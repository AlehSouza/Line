'use client';

import { useIgnored } from '@/lib/ignored';
import { StyledName } from '@/lib/nameStyle';
import { hasPerm, massMention, missingFeatures, Perm, type Attachment, type Channel, type Message, type ThreadSummary } from '@line/shared';
import { GifEmbed, GifPicker, gifFromContent } from './GifPicker';
import { openContextMenu, openMenuAt, useContextMenuOpen, userMenu, type MenuEntry } from './ContextMenu';
import { EMOJI_FONT, EmojiPicker, pushRecentEmoji, topEmojis } from './EmojiPicker';
import { messageLink } from '@/lib/messageLink';
import { Fragment, type ReactNode, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type Ref, type RefObject } from 'react';
import { api } from '@/lib/api';
import { looksNsfw } from '@/lib/nsfw';
import { acceptNsfwChannel, loadNsfwOk, useNsfwOk } from '@/lib/nsfwGate';
import { isAdult } from '@/lib/age';
import { goBack } from '@/lib/history';
import { attachmentKind, AttachmentList, formatSize, GRID_MIN, isMedia, MediaGrid } from './Attachments';
import { renderMarkdown } from '@/lib/markdown';
import { LinkPreviews } from './LinkPreview';
import { VoiceInviteCard, voiceInviteFromContent } from './VoiceInvite';
import { GameShareCard, gameFromContent } from './GameCard';
import { BotTag, CommandNotice, commandFromContent, controlCommand, MusicAnnounceCard, musicFromContent, MusicSearching, SlashPicker, stopCommand, type SlashPickerHandle } from './Music';
import { loadMessages, mentionsMe as messageMentionsMe, sendTyping } from '@/lib/session';
import { MentionPicker, useMentionContext, type MentionPickerHandle } from './Mentions';
import { actions, dmTitle, mentionsToText, channelPermsOf, textToMentions, useCan, useLine } from '@/lib/store';
import { joinVoice, toggleCamera, useVoice } from '@/lib/voice';
import { Avatar, channelIcon, cx, Icons, MessageSkeletons, Modal } from './ui';
import { EmojiButton } from './EmojiField';
import { VoiceStage } from './Voice';
import { UserTagBadge } from './ServerTag';
import { confirmDialog, showError, toast } from './Dialogs';
import { UpdateRequired } from './UpdateBanner';
import { MobileBack, MobileMembersButton } from './Mobile';
import { isPinned, openPinMenu, PinnedNote, PinsButton } from './Pins';
import { toggleSaved, useIsSaved } from './Saved';
import { InboxButton } from './Notifications';

const GROUP_WINDOW_MS = 7 * 60 * 1000;
const EMPTY: Message[] = [];

export function ChatView({ channel }: { channel: Channel }) {
  const me = useLine((s) => s.me);
  const users = useLine((s) => s.users);
  const isDm = !channel.serverId;
  const title = isDm ? dmTitle(channel, me?.id, users) : channel.name;
  const other = isDm && channel.type === 'dm' ? channel.recipients?.find((r) => r.id !== me?.id) : undefined;
  const ChanIcon = channelIcon(channel);
  const canPost = useLine((s) => hasPerm(channelPermsOf(s, channel.id, s.me?.id), Perm.SendMessages));

  const callActive = useVoice((v) => v.channelId === channel.id || Object.values(v.states).some((s) => s.channelId === channel.id));
  const inCall = useVoice((v) => v.channelId === channel.id);
  const composer = useRef<ComposerHandle>(null);
  const drop = useFileDrop(composer);
  const canPin = useLine((s) => {
    const p = channelPermsOf(s, channel.id, s.me?.id);
    return hasPerm(p, Perm.ManageMessages) || hasPerm(p, Perm.PinMessages);
  });

  useEffect(() => {
    actions.markRead(channel.id);
    const onFocus = () => actions.markRead(channel.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channel.id]);

  const nsfwOk = useNsfwOk((g) => g.ids.includes(channel.id));
  const adult = isAdult(me?.birthDate);
  useEffect(() => loadNsfwOk(), [me?.id]);
  if (channel.nsfw && (!adult || !nsfwOk)) return <NsfwChannelGate channel={channel} adult={adult} />;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.handlers}>
      {drop.over && <DropOverlay target={isDm ? title : `#${channel.name}`} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <MobileBack />
        {isDm ? (
          other ? (
            <Avatar name={title} color={(users[other.id] ?? other).avatarColor} src={(users[other.id] ?? other).avatarUrl} size={24} presence={(users[other.id] ?? other).presence} ring="main" />
          ) : (
            <Icons.Users size={20} className="text-muted" />
          )
        ) : (
          <ChanIcon size={20} className="text-muted" />
        )}
        <h1 className="truncate font-bold">{title}</h1>
        {channel.topic && (
          <>
            <span className="mx-2 h-6 w-px bg-edge max-md:hidden" />
            <p className="truncate text-sm text-muted max-md:hidden">{channel.topic}</p>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!channel.id.startsWith('draft:') && <PinsButton channel={channel} canPin={isDm || canPin} />}
          {!isDm && <MobileMembersButton />}
          {/* No navegador não há barra de título: a caixa de entrada fica aqui. */}
          {typeof window !== 'undefined' && !window.line?.window && <InboxButton size={20} className="rounded-md p-1.5 text-soft hover:bg-hover" />}
        </div>
        {isDm && !inCall && (
          <div className="flex gap-1">
            <button title="Iniciar chamada de voz" onClick={() => joinVoice(channel.id)} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
              <Icons.Phone size={20} />
            </button>
            <button
              title="Iniciar chamada de vídeo"
              onClick={async () => {
                await joinVoice(channel.id);
                if (useVoice.getState().channelId === channel.id && !useVoice.getState().camera) await toggleCamera();
              }}
              className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg"
            >
              <Icons.Video size={20} />
            </button>
          </div>
        )}
      </header>
      {isDm && callActive && <VoiceStage channel={channel} compact />}
      <MessageList channel={channel} title={title} />
      {/* Canal de Notas e Atualizações sem permissão para publicar: só leitura, sem caixa de texto. */}
      {!(channel.base && !canPost) && (
        <Composer ref={composer} channel={channel} placeholder={isDm ? `Conversar com ${title}` : `Conversar em #${channel.name}`} />
      )}
    </div>
  );
}

/** "Ver conversas" de uma grade: as mídias uma embaixo da outra, cada uma com a thread dela. */
export function MediaThreadsPanel({ channelId, messageIds }: { channelId: string; messageIds: string[] }) {
  const items = useLine((s) => s.messages[channelId]?.items);
  const channel = useLine((s) => s.channels[channelId]);
  const messages = useMemo(() => (items ?? []).filter((m) => messageIds.includes(m.id)), [items, messageIds]);
  const meId = useLine((s) => s.me?.id);
  const myUsername = useLine((s) => s.me?.username);
  const users = useLine((s) => s.users);
  const serverId = channel?.serverId ?? undefined;
  const canManageMessages = useCan(serverId, Perm.ManageMessages);
  const canPinMessages = useCan(serverId, Perm.PinMessages);
  const canCreateThreads = useLine((s) => hasPerm(channelPermsOf(s, channelId, s.me?.id), Perm.CreateThreads));
  const serverMembers = useLine((s) => (serverId ? s.members[serverId] : undefined));
  const serverRoles = useLine((s) => (serverId ? s.roles[serverId] : undefined));
  const mentionCtx = useMentionContext(serverId);
  const [editing, setEditing] = useState<string | null>(null);
  const colorOf = (userId: string) => {
    const botColor = users[userId]?.botStyle?.nameColor;
    if (botColor) return botColor;
    const mine = serverMembers?.[userId]?.roleIds;
    return mine?.length ? (serverRoles ?? []).find((r) => r.color && mine.includes(r.id))?.color ?? undefined : undefined;
  };
  return (
    <aside className="relative flex w-[420px] shrink-0 flex-col border-l border-rail bg-main max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-0">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <h2 className="font-bold">Conversas</h2>
        <div className="ml-auto flex gap-1">
          <button title="Fechar" onClick={actions.closeThread} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
            <Icons.X size={20} />
          </button>
        </div>
      </header>
      {/* Cada mídia da grade é uma mensagem de verdade: mesma linha do chat, com a barra de
          ações no hover (reagir, responder, encaminhar, menu...). */}
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {channel &&
          messages.map((m, i) => {
            const author = users[m.author.id] ?? m.author;
            return (
              <MessageRow
                key={m.id}
                message={m}
                authorName={serverMembers?.[m.author.id]?.nickname || author.displayName}
                authorColor={author.avatarColor}
                nameColor={colorOf(m.author.id)}
                mentionCtx={mentionCtx}
                grouped={i > 0 && messages[i - 1]!.author.id === m.author.id}
                mine={m.author.id === meId}
                canDelete={m.author.id === meId || canManageMessages}
                canPin={!serverId || canManageMessages || canPinMessages}
                editing={editing === m.id}
                onEdit={() => setEditing(m.id)}
                onDoneEditing={() => setEditing(null)}
                myUsername={myUsername}
                canThread={channel.type === 'text' && canCreateThreads}
                tight
              />
            );
          })}
      </div>
    </aside>
  );
}

/** Painel lateral com a conversa de uma thread. */
export function ThreadPanel({ thread }: { thread: Channel }) {
  const composer = useRef<ComposerHandle>(null);
  const drop = useFileDrop(composer);
  // Sem botão de apagar: a conversa some sozinha quando fica sem respostas.
  const back = useLine((s) => s.threadBack);

  useEffect(() => {
    actions.markRead(thread.id);
  }, [thread.id]);

  return (
    <aside
      className="relative flex w-[420px] shrink-0 flex-col border-l border-rail bg-main max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full max-md:border-0"
      {...drop.handlers}
    >
      {drop.over && <DropOverlay target={thread.name} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        {back && (
          <button
            title="Voltar para as conversas"
            onClick={() => actions.openMediaThreads(back.channelId, back.messageIds)}
            className="-ml-1.5 rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg"
          >
            <Icons.ChevronLeft size={20} />
          </button>
        )}
        <h2 className="font-bold">Conversa</h2>
        <span className="truncate text-sm text-muted">{mentionsToText(thread.name, thread.serverId)}</span>
        <div className="ml-auto flex gap-1">
          <button title="Fechar conversa" onClick={actions.closeThread} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
            <Icons.X size={20} />
          </button>
        </div>
      </header>
      <MessageList
        channel={thread}
        title={thread.name}
        footer={<Composer ref={composer} channel={thread} placeholder="Responder…" />}
      />
    </aside>
  );
}

function DropOverlay({ target }: { target: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="rounded-2xl border-2 border-dashed border-accent bg-side/90 px-10 py-8 text-center shadow-2xl">
        <Icons.Paperclip size={36} className="mx-auto text-accent" />
        <p className="mt-3 text-lg font-bold">Soltar para enviar</p>
        <p className="text-sm text-muted">em {target}</p>
      </div>
    </div>
  );
}

// Arrastos que começam dentro do próprio app (texto selecionado, imagens do chat) não viram anexo.
let internalDrag = false;
if (typeof document !== 'undefined') {
  document.addEventListener('dragstart', () => (internalDrag = true));
  document.addEventListener('dragend', () => (internalDrag = false));
  document.addEventListener('drop', (e) => {
    internalDrag = false;
    // Arquivo solto fora do chat: não deixa o navegador/app abrir o arquivo no lugar do Line.
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
}

/** O que veio no arrasto: arquivos do computador ou algo de uma página (imagem/vídeo). */
const dragKinds = (e: DragEvent) => {
  const types = Array.from(e.dataTransfer.types);
  if (types.includes('Files')) return true;
  return !internalDrag && (types.includes('text/uri-list') || types.includes('text/html'));
};

const MEDIA_LINK = /^(data:(image|video)\/|https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v)(\?\S*)?$)/i;

/** Link da imagem/vídeo arrastado de uma página: o `src` do elemento, ou um link direto de mídia. */
function droppedUrl(data: DataTransfer): string | null {
  const html = data.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const src = doc.querySelector('img[src], video[src], video source[src]')?.getAttribute('src')?.trim();
    if (src && /^(https?:|data:(image|video)\/)/i.test(src)) return src;
  }
  const uri = data.getData('text/uri-list').split(/\r?\n/).find((l) => l && !l.startsWith('#'))?.trim();
  return uri && MEDIA_LINK.test(uri) ? uri : null;
}

/** Arrastar e soltar em cima do chat: arquivos do computador ou imagens/vídeos de sites. */
function useFileDrop(composer: RefObject<ComposerHandle | null>) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!dragKinds(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!dragKinds(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: DragEvent) => {
        if (!dragKinds(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!dragKinds(e)) return;
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
          e.preventDefault();
          composer.current?.addFiles(files);
          return;
        }
        // Sem imagem/vídeo (um link comum, texto): segue o normal, ex. escrever no campo de mensagem.
        const url = droppedUrl(e.dataTransfer);
        if (!url) return;
        e.preventDefault();
        composer.current?.addUrl(url);
      },
    },
  };
}

function MessageList({ channel, title, footer }: { channel: Channel; title: string; footer?: ReactNode }) {
  const bucket = useLine((s) => s.messages[channel.id]);
  const meId = useLine((s) => s.me?.id);
  const myUsername = useLine((s) => s.me?.username);
  const users = useLine((s) => s.users);
  const canManageMessages = useCan(channel.serverId, Perm.ManageMessages);
  const canPinMessages = useCan(channel.serverId, Perm.PinMessages);
  const canCreateThreads = useLine((s) => hasPerm(channelPermsOf(s, channel.id, s.me?.id), Perm.CreateThreads));
  // Apelido e cor do cargo mais alto de quem escreveu (só em servidor).
  const serverMembers = useLine((s) => (channel.serverId ? s.members[channel.serverId] : undefined));
  const serverRoles = useLine((s) => (channel.serverId ? s.roles[channel.serverId] : undefined));
  const colorOf = (userId: string) => {
    const botColor = useLine.getState().users[userId]?.botStyle?.nameColor;
    if (botColor) return botColor;
    const mine = serverMembers?.[userId]?.roleIds;
    return mine?.length ? (serverRoles ?? []).find((r) => r.color && mine.includes(r.id))?.color ?? undefined : undefined;
  };
  const nameOf = (userId: string, fallback: string) => serverMembers?.[userId]?.nickname || fallback;
  const mentionCtx = useMentionContext(channel.serverId);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const lastTop = useRef(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  // Seta para cima com o campo vazio: edita a minha última mensagem deste canal.
  useEffect(() => {
    const onEditLast = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== channel.id) return;
      const list = useLine.getState().messages[channel.id]?.items ?? [];
      const last = [...list].reverse().find((m) => m.author.id === meId);
      if (!last) return;
      setEditing(last.id);
      window.setTimeout(() => {
        scroller.current?.querySelector(`[data-mid="${last.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }, 30);
    };
    window.addEventListener('line:edit-last', onEditLast);
    return () => window.removeEventListener('line:edit-last', onEditLast);
  }, [channel.id, meId]);

  const items = bucket?.items ?? EMPTY;
  const mediaRuns = useMemo(() => mediaRunsOf(items), [items]);
  const content = useRef<HTMLDivElement>(null);
  const isThread = channel.type === 'thread';
  const starter = useLine((s) =>
    isThread && channel.threadMessageId && channel.parentId
      ? s.messages[channel.parentId]?.items.find((m) => m.id === channel.threadMessageId)
      : undefined,
  );

  // Imagens e vídeos mudam de altura ao carregar: continua grudado no fim se já estava.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const sc = scroller.current;
      if (sc && stickToBottom.current) sc.scrollTop = sc.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    stickToBottom.current = true;
    setError('');
    if (channel.id.startsWith('draft:')) return;
    loadMessages(channel.id).catch((e) => setError(e.message));
  }, [channel.id]);

  // Pular para uma mensagem (resultado de busca): rola até ela e destaca por um tempo.
  const highlight = useLine((s) => (s.highlight?.channelId === channel.id ? s.highlight.messageId : null));
  useEffect(() => {
    if (!highlight || !items.some((m) => m.id === highlight)) return;
    stickToBottom.current = false;
    const t = window.setTimeout(() => {
      scroller.current?.querySelector(`[data-mid="${highlight}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 60);
    const clear = window.setTimeout(() => actions.setHighlight(null), 2600);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(clear);
    };
  }, [highlight, items]);

  // Mantém a rolagem no fim quando chegam mensagens novas, e a posição quando carregamos antigas.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (stickToBottom.current && !useLine.getState().highlight) {
      el.scrollTop = el.scrollHeight;
    }
    // As 40 primeiras não enchem a tela: busca mais 40 até aparecer a barra de rolagem.
    if (bucket?.hasMore && el.scrollHeight <= el.clientHeight + 120) void loadOlder();
  }, [items]);

  /** Busca as 40 mensagens anteriores à mais antiga da lista, mantendo a posição da rolagem. */
  async function loadOlder() {
    const el = scroller.current;
    if (!el || loadingOlder.current || !useLine.getState().messages[channel.id]?.hasMore) return;
    const first = useLine.getState().messages[channel.id]?.items[0]?.id;
    loadingOlder.current = true;
    prevHeight.current = el.scrollHeight;
    try {
      await loadMessages(channel.id, true);
    } catch {
      /* tenta de novo na próxima rolagem */
    }
    // Nada mudou (erro ou pedido repetido): libera para a próxima rolagem.
    if (useLine.getState().messages[channel.id]?.items[0]?.id === first) loadingOlder.current = false;
  }

  async function onScroll() {
    const el = scroller.current;
    if (!el) return;
    // Só solta do fim quando a pessoa rola para cima (conteúdo crescendo não conta).
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) stickToBottom.current = true;
    else if (el.scrollTop < lastTop.current - 1) stickToBottom.current = false;
    lastTop.current = el.scrollTop;
    if (el.scrollTop < 120 && bucket?.hasMore) await loadOlder();
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
      <div ref={content} className={cx('flex flex-col', isThread ? 'pb-2' : 'min-h-full justify-end pb-4')}>
        {bucket && !bucket.hasMore && isThread && (
          <div className="pt-3">
            {starter ? (
              <ThreadStarter message={starter} only={onlyMediaOf(channel, starter)} myUsername={myUsername} mentionCtx={mentionCtx} />
            ) : (
              <p className="px-4 py-1 text-sm text-muted">Começo da conversa em {title}.</p>
            )}
            <div className="mt-2 flex justify-end px-4 text-xs text-muted">
              <span className="shrink-0">{items.length === 1 ? '1 resposta' : `${items.length} respostas`}</span>
            </div>
          </div>
        )}
        {bucket && !bucket.hasMore && !isThread && (
          <div className="px-4 pt-8 pb-4">
            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-raise text-accent">
              {channel.serverId ? (() => { const I = channelIcon(channel); return <I size={36} />; })() : <Icons.Message size={32} />}
            </div>
            <h2 className="text-3xl font-bold">{channel.base ? title : channel.serverId ? `Bem-vindo a #${title}!` : title}</h2>
            <p className="mt-1 text-muted">
              {channel.base
                ? channel.topic || 'Canal de Notas e Atualizações.'
                : channel.serverId
                ? `Este é o começo do canal #${title}.`
                : `Este é o começo da sua conversa com ${title}.`}
            </p>
          </div>
        )}
        {!bucket && !error && <MessageSkeletons />}
        {error && <p className="px-4 py-6 text-sm text-danger">{error}</p>}

        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped =
            !newDay &&
            !m.deleted &&
            !prev?.deleted &&
            prev?.author.id === m.author.id &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
          // Mídias seguidas (sem texto no meio) viram uma grade na primeira mensagem da sequência.
          if (mediaRuns.hidden.has(m.id)) return null;
          const author = users[m.author.id] ?? m.author;
          return (
            <Fragment key={m.id}>
              {newDay && <DayDivider date={m.createdAt} />}
              <MessageRow
                highlighted={highlight === m.id}
                message={m}
                authorName={nameOf(m.author.id, author.displayName)}
                authorColor={author.avatarColor}
                nameColor={colorOf(m.author.id)}
                mentionCtx={mentionCtx}
                grouped={grouped}
                gallery={mediaRuns.leaders.get(m.id)}
                galleryThreads={mediaRuns.threads.get(m.id)}
                galleryIds={mediaRuns.runIds.get(m.id)}
                mine={m.author.id === meId}
                canDelete={m.author.id === meId || canManageMessages}
                canPin={!channel.id.startsWith('draft:') && (!channel.serverId || canManageMessages || canPinMessages)}
                editing={editing === m.id}
                onEdit={() => setEditing(m.id)}
                onDoneEditing={() => setEditing(null)}
                myUsername={myUsername}
                canThread={channel.type === 'text' && canCreateThreads}
                tight={isThread}
              />
            </Fragment>
          );
        })}
      </div>
      {/* Na thread a caixa de resposta fica logo abaixo da última resposta (e gruda embaixo quando a conversa é longa). */}
      {footer && <div className="sticky bottom-0 bg-main pt-1">{footer}</div>}
    </div>
  );
}

/** Mensagem/mídia apagada que tinha conversa com respostas. */
const DELETED_ITEM = 'Esse item foi apagado pelo autor ou administração';

/** Threads da mensagem (servidor antigo só manda `thread`). */
export const threadsOf = (m: Message): ThreadSummary[] => m.threads ?? (m.thread ? [m.thread] : []);
/** Thread da mensagem inteira (não de uma mídia só). */
export const wholeThreadOf = (m: Message) => threadsOf(m).find((t) => !t.attachmentId);

/** Só mídia, sem texto, enquete ou thread: pode entrar numa grade. */
const mediaOnly = (m: Message) =>
  !m.deleted && !m.content && !m.poll && !!m.attachments.length && m.attachments.every(isMedia);

/** Sequências de mensagens só com mídia, do mesmo autor, no mesmo dia e com no máximo
 * GROUP_WINDOW_MS entre uma e outra. Com GRID_MIN mídias ou mais, a primeira mensagem
 * mostra a grade com todas e as outras somem da lista. */
function mediaRunsOf(items: Message[]) {
  const leaders = new Map<string, Attachment[]>();
  const hidden = new Set<string>();
  /** Todas as threads das mensagens da grade (viram um "Ver conversas" embaixo dela). */
  const threads = new Map<string, ThreadSummary[]>();
  /** Mensagens de cada grade (para o painel "Ver conversas"). */
  const runIds = new Map<string, string[]>();
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    if (!mediaOnly(first)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < items.length) {
      const prev = items[j - 1]!;
      const m = items[j]!;
      if (
        !mediaOnly(m) ||
        m.author.id !== first.author.id ||
        new Date(m.createdAt).toDateString() !== new Date(prev.createdAt).toDateString() ||
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() >= GROUP_WINDOW_MS
      )
        break;
      j++;
    }
    const run = items.slice(i, j);
    const media = run.flatMap((m) => m.attachments);
    if (media.length >= GRID_MIN) {
      leaders.set(first.id, media);
      for (const m of run.slice(1)) hidden.add(m.id);
      const all = run.flatMap(threadsOf);
      if (all.length) threads.set(first.id, all);
      runIds.set(first.id, run.map((m) => m.id));
    }
    i = j;
  }
  return { leaders, hidden, threads, runIds };
}

function DayDivider({ date }: { date: string }) {
  const label = new Date(date).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="mx-4 my-4 flex items-center gap-2 text-xs font-semibold text-muted">
      <span className="h-px flex-1 bg-edge" />
      {label}
      <span className="h-px flex-1 bg-edge" />
    </div>
  );
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return `Hoje às ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${d.toLocaleDateString('pt-BR')} ${time}`;
}

function MessageRow({
  highlighted,
  message,
  authorName,
  authorColor,
  nameColor,
  mentionCtx,
  grouped,
  gallery,
  galleryThreads,
  galleryIds,
  mine,
  canDelete,
  editing,
  onEdit,
  onDoneEditing,
  myUsername,
  canThread,
  canPin,
  tight,
}: {
  highlighted?: boolean;
  message: Message;
  authorName: string;
  authorColor: string;
  nameColor?: string;
  mentionCtx?: ReturnType<typeof useMentionContext>;
  grouped: boolean;
  /** Primeira de uma sequência de mídias: mostra a grade com todas. */
  gallery?: Attachment[];
  galleryThreads?: ThreadSummary[];
  galleryIds?: string[];
  mine: boolean;
  canDelete: boolean;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  myUsername?: string;
  canThread: boolean;
  canPin?: boolean;
  tight?: boolean;
}) {
  const serverId = useLine((s) => s.channels[message.channelId]?.serverId);
  const [draft, setDraft] = useState(message.content);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const [reactAnchor, setReactAnchor] = useState<HTMLElement | null>(null);
  const canReact = useLine((s) => hasPerm(channelPermsOf(s, message.channelId, s.me?.id), Perm.AddReactions));
  const whole = wholeThreadOf(message);
  const showThreadAction = canThread && !whole;
  const mentionsMe = !mine && messageMentionsMe(message);
  const ignored = useIgnored((s) => s.ids.includes(message.author.id));
  const [reveal, setReveal] = useState(false);
  const authorUser = useLine((s) => s.users[message.author.id]) ?? message.author;
  const isSaved = useIsSaved(message.id);
  // Barra fica aberta enquanto o menu das reticências estiver aberto (some quando ele fecha).
  const [moreOpen, setMoreOpen] = useState(false);
  const menuOpen = useContextMenuOpen();
  useEffect(() => {
    if (!menuOpen) setMoreOpen(false);
  }, [menuOpen]);

  // Ao entrar em edição (botão, menu ou seta para cima), começa do texto atual.
  useEffect(() => {
    if (editing) setDraft(mentionsToText(message.content, serverId));
  }, [editing]);

  function stopEditing() {
    onDoneEditing();
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.focus(), 0);
  }

  async function saveEdit() {
    const content = textToMentions(draft.trim(), serverId);
    if ((!content && !message.attachments.length) || content === message.content) return stopEditing();
    try {
      await api.editMessage(message.id, content);
      stopEditing();
    } catch (e) {
      showError(e);
    }
  }

  const forwardedFromName = useLine((s) => {
    const c = message.forwardedFrom ? s.channels[message.forwardedFrom] : null;
    return c?.serverId ? c.name : null;
  });
  // Item apagado: continua com reações, conversa, favoritar e links; só perde o conteúdo.
  const del = !!message.deleted;

  if (ignored && !reveal && !del) {
    return (
      <div className={cx('flex items-center gap-2 px-4 py-1 text-xs text-muted', !grouped && 'mt-3')}>
        <Icons.EyeOff size={14} />
        Mensagem de alguém que você ignorou.
        <button type="button" onClick={() => setReveal(true)} className="font-semibold text-accent hover:underline">
          Mostrar
        </button>
      </div>
    );
  }

  const plain = message.content ? mentionsToText(message.content, serverId) : '';
  const canReply = showThreadAction || !!whole;
  const canForward = !message.poll && !del;
  const canReport = !mine && !message.author.bot && !del;
  const canEdit = mine && !del;

  function reply() {
    if (whole) return actions.openThread(whole.id);
    const parent = useLine.getState().channels[message.channelId];
    const name = (plain.split('\n')[0] || message.attachments[0]?.filename || 'Conversa').slice(0, 60);
    if (parent) actions.openThreadDraft(parent, message.id, name);
  }

  function forward() {
    actions.openModal({ kind: 'forward', messageId: message.id, channelId: message.channelId });
  }

  function copy(text: string, done: string) {
    navigator.clipboard.writeText(text).then(() => toast(done), showError);
  }

  /** Na grade, excluir apaga todas as mensagens dela (as que têm conversa com respostas ficam como item apagado, com a conversa embaixo). */
  async function remove() {
    const ids = gallery && galleryIds?.length ? galleryIds : [message.id];
    const many = ids.length > 1;
    const ok = await confirmDialog({
      title: many ? 'Excluir grade' : 'Excluir mensagem',
      message: many ? `As ${gallery!.length} mídias desta grade serão excluídas. Não dá para desfazer.` : 'Tem certeza? Não dá para desfazer.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    const results = await Promise.allSettled(ids.map((id) => api.deleteMessage(id)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) showError(failed.reason);
  }

  /** Menu das reticências (e fim do clique direito), na ordem pedida. */
  function moreItems(menuAt: { x: number; y: number }): MenuEntry[] {
    return [
      !!plain && { label: 'Copiar texto', icon: <Icons.Copy size={15} />, onClick: () => copy(plain, 'Texto copiado.') },
      canPin && !del && {
        label: isPinned(message) ? 'Fixada: mudar ou desafixar' : 'Fixar mensagem',
        icon: <Icons.Pin size={15} />,
        onClick: () => openPinMenu(message, menuAt),
      },
      { label: 'Copiar link da mensagem', icon: <Icons.Link size={15} />, onClick: () => copy(messageLink(message), 'Link da mensagem copiado.') },
      'sep',
      canDelete && !del && { label: gallery && (galleryIds?.length ?? 0) > 1 ? 'Excluir grade' : 'Excluir mensagem', icon: <Icons.Trash size={15} />, danger: true, onClick: () => remove() },
      canReport && {
        label: 'Denunciar mensagem',
        icon: <Icons.Flag size={15} />,
        danger: true,
        onClick: () =>
          actions.openModal({
            kind: 'report',
            target: { userId: message.author.id, messageId: message.id, preview: plain || message.attachments[0]?.filename },
          }),
      },
      'sep',
      { label: 'Copiar ID da mensagem', icon: <Icons.IdCard size={15} />, onClick: () => copy(message.id, 'ID da mensagem copiado.') },
    ];
  }

  return (
    <div
      data-mid={message.id}
      onContextMenu={(e) => {
        if (editing) return;
        const row = e.currentTarget;
        const menuAt = { x: e.clientX, y: e.clientY };
        openContextMenu(e, [
          canReact && { label: 'Adicionar reação', icon: <Icons.SmilePlus size={15} />, onClick: () => setReactAnchor(row) },
          canReply && { label: whole ? 'Abrir conversa' : 'Responder em conversa', icon: <Icons.Reply size={15} />, onClick: reply },
          canForward && { label: 'Encaminhar', icon: <Icons.Forward size={15} />, onClick: forward },
          {
            label: isSaved ? 'Remover dos favoritos' : 'Favoritar mensagem',
            icon: isSaved ? <Icons.BookmarkX size={15} /> : <Icons.Bookmark size={15} />,
            onClick: () => toggleSaved(message),
          },
          canEdit && {
            label: 'Editar mensagem',
            icon: <Icons.Edit size={15} />,
            onClick: () => {
              setDraft(plain);
              onEdit();
            },
          },
          !mine && !del && {
            label: 'Mencionar autor',
            icon: <Icons.AtSign size={15} />,
            onClick: () =>
              window.dispatchEvent(new CustomEvent('line:mention', { detail: `@${message.author.bot ? message.author.displayName : message.author.username} ` })),
          },
          'sep',
          ...moreItems(menuAt),
        ]);
      }}
      className={cx(
        // Sem margem entre as linhas: o espaço é padding, então o hover pega a linha inteira.
        'group relative flex gap-4 px-4 transition-colors duration-700 hover:bg-hover/30 hover:duration-100',
        moreOpen && 'bg-black/10',
        // Mesmo espaço em cima e embaixo (a soma de antes dividida por 2).
        grouped ? 'py-1.5' : tight ? 'py-[9px]' : 'py-[11px]',
        mentionsMe && 'border-l-2 border-sun bg-sun/5 hover:bg-sun/10',
        highlighted && 'bg-accent/15',
      )}
    >
      <div className="w-10 shrink-0">
        {del ? (
          <div className="flex size-10 items-center justify-center rounded-lg bg-raise text-muted">
            <Icons.Trash size={18} />
          </div>
        ) : grouped ? (
          <span className="invisible block pt-1 text-right text-[10px] text-muted group-hover:visible">
            {new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <button
            onClick={(e) => actions.openModal({ kind: 'user', userId: message.author.id, at: { x: e.clientX, y: e.clientY } })}
            onContextMenu={(e) => openContextMenu(e, userMenu(message.author.id, { x: e.clientX, y: e.clientY }, serverId))}
          >
            <Avatar name={authorName} color={authorColor} src={(serverId && useLine.getState().members[serverId]?.[message.author.id]?.profile?.avatarUrl) || (useLine.getState().users[message.author.id] ?? message.author).avatarUrl} size={40} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {del ? (
          <>
            {/* Cada conversa fica logo abaixo do item apagado de onde ela saiu. */}
            {(threadsOf(message).length ? threadsOf(message) : [null]).map((t, i) => (
              <div key={t?.id ?? i} className={cx('flex flex-col items-start', i > 0 && 'mt-2')}>
                <p className="flex min-h-10 items-center rounded-lg border border-dashed border-edge px-3 py-2 text-[15px] text-soft">{DELETED_ITEM}</p>
                {t && <ThreadChip thread={t} />}
              </div>
            ))}
            {!!message.reactions?.length && <Reactions message={message} onAdd={(el) => setReactAnchor(el)} adding={!!reactAnchor} />}
          </>
        ) : (
          <>
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <button
              onClick={(e) => actions.openModal({ kind: 'user', userId: message.author.id, at: { x: e.clientX, y: e.clientY } })}
              onContextMenu={(e) => openContextMenu(e, userMenu(message.author.id, { x: e.clientX, y: e.clientY }, serverId))}
              className="font-semibold hover:underline"
            >
              <StyledName user={authorUser} color={nameColor}>
                {authorName}
              </StyledName>
            </button>
            {message.author.bot && <BotTag user={message.author} />}
            <UserTagBadge user={message.author} />
            <span className="text-xs text-muted">{formatTime(message.createdAt)}</span>
          </div>
        )}
        <PinnedNote message={message} />
        {message.forwardedFrom && (
          <p className="flex items-center gap-1 pt-0.5 text-xs text-muted italic">
            <Icons.Forward size={13} />
            Encaminhada{forwardedFromName ? ` de #${forwardedFromName}` : ''}
          </p>
        )}
        {missingFeatures(message.requires).length ? (
          <UpdateRequired />
        ) : editing ? (
          <div className="py-1">
            <div className="relative">
            <textarea
              ref={editRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  stopEditing();
                }
              }}
              onFocus={(e) => {
                const end = e.currentTarget.value.length;
                e.currentTarget.setSelectionRange(end, end);
              }}
              rows={Math.min(8, draft.split('\n').length)}
              className="w-full resize-none rounded-lg bg-raise py-2 pr-10 pl-3 text-[15px] outline-none"
            />
            <EmojiButton target={editRef} size={20} className="absolute top-2 right-3" />
            </div>
            <p className="mt-1 text-xs text-muted">
              esc para{' '}
              <button type="button" onClick={stopEditing} className="text-accent hover:underline">
                cancelar
              </button>{' '}
              • enter para{' '}
              <button type="button" onClick={() => void saveEdit()} className="text-accent hover:underline">
                salvar
              </button>
            </p>
          </div>
        ) : (
          message.content &&
          (voiceInviteFromContent(message.content) ? (
            <VoiceInviteCard invite={voiceInviteFromContent(message.content)!} />
          ) : musicFromContent(message.content) ? (
            <MusicAnnounceCard data={musicFromContent(message.content)!} serverId={serverId} />
          ) : gameFromContent(message.content) ? (
            <GameShareCard data={gameFromContent(message.content)!} />
          ) : gifFromContent(message.content) ? (
            <GifEmbed url={gifFromContent(message.content)!} />
          ) : serverId && !message.author.bot && commandFromContent(message.content) ? (
            <CommandNotice serverId={serverId} command={commandFromContent(message.content)!} content={message.content} />
          ) : (
            <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-soft">
              {renderMarkdown(message.content, myUsername, mentionCtx)}
              {message.editedAt && <span className="ml-1 text-[10px] text-muted">(editado)</span>}
            </div>
          ))
        )}
        {!missingFeatures(message.requires).length && (
          <>
        {!editing && message.content && !gifFromContent(message.content) && !voiceInviteFromContent(message.content) && !musicFromContent(message.content) && !gameFromContent(message.content) && (
          <LinkPreviews content={message.content} />
        )}
        {gallery ? (
          <MediaGrid attachments={gallery} channelId={message.channelId} />
        ) : (
          <AttachmentList
            attachments={message.attachments}
            authorId={message.author.id}
            owner={{ channelId: message.channelId, messageId: message.id }}
            below={mediaThreadsBelow(message)}
          />
        )}
        {message.poll && <PollView message={message} poll={message.poll} />}
          </>
        )}
        {!!message.reactions?.length && (
          <Reactions message={message} onAdd={(el) => setReactAnchor(el)} adding={!!reactAnchor} />
        )}
        {gallery ? galleryThreads?.length ? <GalleryThreads threads={galleryThreads} channelId={message.channelId} messageIds={galleryIds ?? [message.id]} /> : null : whole && <ThreadChip thread={whole} />}
          </>
        )}
      </div>

      {reactAnchor && (
        <EmojiPicker
          anchor={reactAnchor}
          onClose={() => setReactAnchor(null)}
          onPick={(emoji, keepOpen) => {
            void toggleReaction(message, emoji);
            if (!keepOpen) setReactAnchor(null);
          }}
        />
      )}

      {!editing && (
        <div className={cx('absolute -top-4 right-4 items-center gap-0.5 rounded-lg border border-edge bg-side p-0.5 shadow', reactAnchor || moreOpen ? 'flex' : 'hidden group-hover:flex')}>
          {canReact && (
            <>
              {topEmojis(3).map((emoji) => (
                <button
                  key={emoji}
                  title={`Reagir com ${emoji}`}
                  onClick={() => void toggleReaction(message, emoji)}
                  className="flex size-8 items-center justify-center rounded-md text-lg leading-none hover:bg-hover"
                  style={{ fontFamily: EMOJI_FONT }}
                >
                  {emoji}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-edge" />
              <button
                title="Adicionar reação"
                onClick={(e) => {
                  const el = e.currentTarget;
                  setReactAnchor((a) => (a ? null : el));
                }}
                className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
              >
                <Icons.SmilePlus size={18} />
              </button>
            </>
          )}
          <button
            title={isSaved ? 'Remover dos favoritos' : 'Favoritar mensagem'}
            onClick={() => toggleSaved(message)}
            className={cx('flex size-8 items-center justify-center rounded-md hover:bg-hover hover:text-fg', isSaved ? 'text-accent' : 'text-muted')}
          >
            {isSaved ? <Icons.BookmarkCheck size={18} /> : <Icons.Bookmark size={18} />}
          </button>
          {canEdit && (
            <button
              title="Editar"
              onClick={() => {
                setDraft(plain);
                onEdit();
              }}
              className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <Icons.Edit size={17} />
            </button>
          )}
          {canReply && (
            <button
              title={whole ? 'Abrir conversa' : 'Responder em conversa'}
              onClick={reply}
              className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <Icons.Reply size={18} />
            </button>
          )}
          {canForward && (
            <button title="Encaminhar" onClick={forward} className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
              <Icons.Forward size={18} />
            </button>
          )}
          <button
            title="Mais opções"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const at = { x: Math.max(8, r.right - 232), y: r.bottom + 4 };
              openMenuAt(at, moreItems(at));
              setMoreOpen(true);
            }}
            className="flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
          >
            <Icons.More size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Mensagem que abriu a thread, no topo do painel: com as mesmas reações da mensagem original. */
/** Topo da thread. `only`: a thread responde a uma mídia só da mensagem (pelo visualizador). */
/** Mídia da thread, só se ela ainda estiver na mensagem. */
const onlyMediaOf = (channel: Channel, m: Message) =>
  channel.threadAttachmentId && m.attachments.some((a) => a.id === channel.threadAttachmentId) ? channel.threadAttachmentId : null;

function ThreadStarter({ message, only, myUsername, mentionCtx }: { message: Message; only?: string | null; myUsername?: string; mentionCtx: ReturnType<typeof useMentionContext> }) {
  const author = useLine((s) => s.users[message.author.id]) ?? message.author;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (message.deleted) {
    return (
      <div className="flex items-center gap-3 px-4 py-1">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-raise text-muted">
          <Icons.Trash size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] text-soft">{DELETED_ITEM}</p>
          {!!message.reactions?.length && <Reactions message={message} onAdd={setAnchor} adding={!!anchor} />}
        </div>
        {anchor && (
          <EmojiPicker
            anchor={anchor}
            onClose={() => setAnchor(null)}
            onPick={(emoji, keepOpen) => {
              void toggleReaction(message, emoji);
              if (!keepOpen) setAnchor(null);
            }}
          />
        )}
      </div>
    );
  }
  return (
    <div className="group relative flex gap-3 px-4 py-1 hover:bg-hover/30">
      <Avatar name={author.displayName} color={author.avatarColor} src={author.avatarUrl} size={36} />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="font-semibold">{author.displayName}</span>
          <span className="text-xs text-muted">{formatTime(message.createdAt)}</span>
        </p>
        {message.content && <div className="text-[15px] break-words whitespace-pre-wrap">{renderMarkdown(message.content, myUsername, mentionCtx)}</div>}
        {message.content && !gifFromContent(message.content) && <LinkPreviews content={message.content} />}
        <AttachmentList
          attachments={only ? message.attachments.filter((a) => a.id === only) : message.attachments}
          compact
          authorId={message.author.id}
          owner={{ channelId: message.channelId, messageId: message.id }}
          below={only ? (a) => (a.reactions?.length ? <Reactions message={message} attachmentId={a.id} /> : null) : mediaThreadsBelow(message)}
        />
        {!!message.reactions?.length && <Reactions message={message} onAdd={setAnchor} adding={!!anchor} />}
      </div>
      <div className={cx('absolute -top-3 right-4 rounded-lg border border-edge bg-side shadow', anchor ? 'flex' : 'hidden group-hover:flex')}>
        <button
          title="Adicionar reação"
          onClick={(e) => {
            const el = e.currentTarget;
            setAnchor((a) => (a ? null : el));
          }}
          className="p-1.5 text-muted hover:text-fg"
        >
          <Icons.SmilePlus size={16} />
        </button>
      </div>
      {anchor && (
        <EmojiPicker
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onPick={(emoji, keepOpen) => {
            void toggleReaction(message, emoji);
            if (!keepOpen) setAnchor(null);
          }}
        />
      )}
    </div>
  );
}

/** Põe ou tira a sua reação com esse emoji (o resto da sala recebe pelo WebSocket). */
/** attachmentId: reação só naquela mídia da mensagem (visualizador). */
async function toggleReaction(message: Message, emoji: string, attachmentId?: string) {
  const meId = useLine.getState().me?.id;
  const current = useLine.getState().messages[message.channelId]?.items.find((m) => m.id === message.id) ?? message;
  const list = attachmentId ? current.attachments.find((a) => a.id === attachmentId)?.reactions : current.reactions;
  const mine = !!meId && !!list?.some((r) => r.emoji === emoji && r.userIds.includes(meId));
  if (!mine) pushRecentEmoji(emoji);
  try {
    const updated = attachmentId
      ? await api.setAttachmentReaction(attachmentId, emoji, !mine)
      : mine
        ? await api.removeReaction(message.id, emoji)
        : await api.addReaction(message.id, emoji);
    actions.updateMessage(updated);
  } catch (e) {
    showError(e);
  }
}

function reactorNames(userIds: string[], meId?: string) {
  const users = useLine.getState().users;
  const names = userIds.map((id) => (id === meId ? 'Você' : users[id]?.displayName ?? 'Alguém'));
  const shown = names.slice(0, 6);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} e mais ${rest}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} e ${shown.at(-1)}` : (shown[0] ?? '');
}

/** Pílulas de reação embaixo da mensagem. Destacadas na cor do Line só quando você está entre quem reagiu. */
/** Reações da mensagem no visualizador de mídia (acima da imagem), com o seletor para adicionar. */
export function ViewerReactions({ message, attachmentId }: { message: Message; attachmentId?: string }) {
  const list = attachmentId ? message.attachments.find((a) => a.id === attachmentId)?.reactions : message.reactions;
  if (!list?.length) return null;
  return <Reactions message={message} attachmentId={attachmentId} />;
}

/** Caixa de emoji do visualizador (ao lado das respostas): reage à mídia aberta. */
export function ViewerReactButton({ message, attachmentId }: { message: Message; attachmentId?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const canReact = useLine((s) => hasPerm(channelPermsOf(s, message.channelId, s.me?.id), Perm.AddReactions));
  if (!canReact) return null;
  return (
    <>
      <button
        title="Adicionar reação"
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((x) => (x ? null : el));
        }}
        className={cx('flex size-11 shrink-0 items-center justify-center rounded-xl bg-raise text-soft hover:bg-hover hover:text-fg', anchor && 'text-fg')}
      >
        <Icons.SmilePlus size={20} />
      </button>
      {anchor && (
        <EmojiPicker
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onPick={(emoji, keepOpen) => {
            void toggleReaction(message, emoji, attachmentId);
            if (!keepOpen) setAnchor(null);
          }}
        />
      )}
    </>
  );
}

/** Quem reagiu: aba Tudo (cada pessoa com o emoji dela) e uma aba por emoji com a contagem. */
function ReactionsListModal({ reactions, onClose }: { reactions: NonNullable<Message['reactions']>; onClose: () => void }) {
  const [tab, setTab] = useState<string | null>(null);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const rows = (tab ? reactions.filter((r) => r.emoji === tab) : reactions).flatMap((r) => r.userIds.map((id) => ({ id, emoji: r.emoji })));
  const total = reactions.reduce((n, r) => n + r.userIds.length, 0);
  const tabCls = (on: boolean) =>
    cx('-mb-px flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold', on ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-fg');
  return (
    <Modal title="Reações" onClose={onClose} width={460} fixedBody>
      <div className="flex overflow-x-auto border-b border-edge">
        <button onClick={() => setTab(null)} className={tabCls(tab === null)}>
          Tudo <span className="tabular-nums">{total}</span>
        </button>
        {reactions.map((r) => (
          <button key={r.emoji} onClick={() => setTab(r.emoji)} className={tabCls(tab === r.emoji)}>
            <span className="text-lg leading-none" style={{ fontFamily: EMOJI_FONT }}>{r.emoji}</span>
            <span className="tabular-nums">{r.userIds.length}</span>
          </button>
        ))}
      </div>
      <div className="max-h-[50vh] overflow-y-auto py-2">
        {rows.map(({ id, emoji }) => {
          const u = users[id];
          return (
            <div key={`${emoji}:${id}`} className="flex items-center gap-3 rounded-md px-2 py-1.5">
              <span className="relative shrink-0">
                <Avatar name={u?.displayName ?? '?'} color={u?.avatarColor ?? '#55555f'} src={u?.avatarUrl} size={36} />
                <span
                  className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-side text-[13px] leading-none ring-2 ring-side"
                  style={{ fontFamily: EMOJI_FONT }}
                >
                  {emoji}
                </span>
              </span>
              <span className="truncate font-semibold">{id === meId ? 'Você' : (u?.displayName ?? 'Alguém')}</span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

/** Reações da mídia: até 3 e "+N reações" (abre a lista de quem reagiu). */
const MEDIA_REACTIONS_SHOWN = 3;

function Reactions({ message, onAdd, adding, attachmentId }: { message: Message; onAdd?: (el: HTMLElement) => void; adding?: boolean; attachmentId?: string }) {
  const all = (attachmentId ? message.attachments.find((a) => a.id === attachmentId)?.reactions : message.reactions) ?? [];
  const reactions = attachmentId ? all.slice(0, MEDIA_REACTIONS_SHOWN) : all;
  const hidden = all.length - reactions.length;
  const [listOpen, setListOpen] = useState(false);
  const meId = useLine((s) => s.me?.id);
  const canReact = useLine((s) => hasPerm(channelPermsOf(s, message.channelId, s.me?.id), Perm.AddReactions));
  useLine((s) => s.users);
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const mine = !!meId && r.userIds.includes(meId);
        return (
          <span key={r.emoji} className="group/react relative">
            <button
              onClick={() => void toggleReaction(message, r.emoji, attachmentId)}
              aria-pressed={mine}
              aria-label={`${r.emoji} ${r.userIds.length}: ${reactorNames(r.userIds, meId)}`}
              className={cx(
                'flex h-7 items-center gap-1.5 rounded-lg border px-2 text-sm font-semibold transition-colors',
                mine ? 'border-accent bg-accent/20 text-fg' : 'border-transparent bg-raise text-soft hover:border-edge',
              )}
            >
              <span className="text-base leading-none" style={{ fontFamily: EMOJI_FONT }}>
                {r.emoji}
              </span>
              <span className={cx('tabular-nums', mine && 'text-accent')}>{r.userIds.length}</span>
            </button>
            <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-max max-w-64 -translate-x-1/2 items-center gap-2 rounded-lg border border-edge bg-rail px-3 py-2 text-xs text-soft shadow-xl group-hover/react:flex">
              <span className="text-2xl leading-none" style={{ fontFamily: EMOJI_FONT }}>
                {r.emoji}
              </span>
              <span>
                <strong className="text-fg">{reactorNames(r.userIds, meId)}</strong> reagiu com {r.emoji}
              </span>
            </span>
          </span>
        );
      })}
      {hidden > 0 && (
        <button
          onClick={() => setListOpen(true)}
          className="flex h-7 items-center rounded-lg bg-raise px-2 text-sm font-semibold text-soft hover:text-fg"
        >
          +{hidden} {hidden === 1 ? 'reação' : 'reações'}
        </button>
      )}
      {listOpen && (
        <div className="contents" onMouseDown={(e) => e.stopPropagation()}>
          <ReactionsListModal reactions={all} onClose={() => setListOpen(false)} />
        </div>
      )}
      {canReact && onAdd && (
        <button
          title="Adicionar reação"
          onClick={(e) => onAdd(e.currentTarget)}
          className={cx(
            'flex h-7 items-center rounded-lg bg-raise px-2 text-muted transition-opacity hover:text-fg',
            adding ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <Icons.SmilePlus size={16} />
        </button>
      )}
    </div>
  );
}

function PollView({ message, poll }: { message: Message; poll: NonNullable<Message['poll']> }) {
  const meId = useLine((s) => s.me?.id);
  const voters = new Set(poll.options.flatMap((o) => o.voterIds));
  const total = poll.options.reduce((n, o) => n + o.voterIds.length, 0);
  const vote = (optionId: string) => void api.votePoll(message.id, optionId).then(actions.addMessage).catch(showError);
  return (
    <div className="mt-1 w-full max-w-[440px] rounded-xl border border-edge bg-side/70 p-4">
      <p className="flex items-center gap-2 font-semibold">
        <Icons.Poll size={18} className="shrink-0 text-accent" />
        {poll.question}
      </p>
      <p className="mt-0.5 mb-3 text-xs text-muted">{poll.multi ? 'Escolha uma ou mais opções' : 'Escolha uma opção'}</p>
      <div className="space-y-2">
        {poll.options.map((o) => {
          const mine = !!meId && o.voterIds.includes(meId);
          const pct = total ? Math.round((o.voterIds.length / total) * 100) : 0;
          return (
            <button
              key={o.id}
              onClick={() => vote(o.id)}
              className={cx(
                'relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                mine ? 'border-accent' : 'border-edge hover:border-accent/50',
              )}
            >
              <span className={cx('absolute inset-y-0 left-0 transition-all', mine ? 'bg-accent/30' : 'bg-white/5')} style={{ width: `${pct}%` }} />
              <span className="relative flex items-center gap-2">
                <span className={cx('flex h-4 w-4 shrink-0 items-center justify-center border', poll.multi ? 'rounded' : 'rounded-full', mine ? 'border-accent bg-accent text-white' : 'border-muted')}>
                  {mine && <Icons.Check size={12} />}
                </span>
                <span className="flex-1">{o.text}</span>
                <span className="text-xs text-muted">{o.voterIds.length} · {pct}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">{voters.size === 1 ? '1 pessoa votou' : `${voters.size} pessoas votaram`}</p>
    </div>
  );
}

/** Embaixo de cada mídia, a thread aberta só para ela (se houver). */
function mediaThreadsBelow(message: Message, withWhole = false) {
  const all = threadsOf(message);
  const list = all.filter((t) => t.attachmentId);
  // No painel "Ver conversas", mensagem com uma mídia só mostra a thread dela embaixo da mídia.
  const whole = withWhole && message.attachments.length === 1 ? all.find((t) => !t.attachmentId) : undefined;
  const reacted = message.attachments.length > 1 && message.attachments.some((a) => a.reactions?.length);
  if (!list.length && !whole && !reacted) return undefined;
  return (a: Attachment) => {
    const t = list.find((x) => x.attachmentId === a.id) ?? whole;
    const r = message.attachments.length > 1 && !!a.reactions?.length;
    if (!t && !r) return null;
    return (
      <>
        {r && <Reactions message={message} attachmentId={a.id} />}
        {t && <ThreadChip thread={t} />}
      </>
    );
  };
}

/** Grade com respostas: avatares de quem respondeu (até 3 e +N) e "Ver conversas". */
function GalleryThreads({ threads, channelId, messageIds }: { threads: ThreadSummary[]; channelId: string; messageIds: string[] }) {
  const users = useLine((s) => s.users);
  const open = useLine((s) => s.mediaThreads?.messageIds[0] === messageIds[0]);
  const ids = [...new Set(threads.flatMap((t) => t.participantIds ?? []))];
  const total = Math.max(ids.length, ...threads.map((t) => t.participantCount ?? 0));
  const shown = ids.slice(0, 3);
  const extra = Math.max(0, total - shown.length);
  return (
    <button
      onClick={() => (open ? actions.closeThread() : actions.openMediaThreads(channelId, messageIds))}
      className={cx('group/thread mt-1 flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-hover/60', open && 'bg-accent/10')}
    >
      {shown.length > 0 ? (
        <span className="flex items-center -space-x-1.5">
          {shown.map((id) => (
            <span key={id} className="rounded-full ring-2 ring-main">
              <Avatar name={users[id]?.displayName ?? '?'} color={users[id]?.avatarColor ?? '#55555f'} src={users[id]?.avatarUrl} size={22} />
            </span>
          ))}
          {extra > 0 && (
            <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-raise px-1 text-[10px] font-bold text-soft ring-2 ring-main">
              +{extra}
            </span>
          )}
        </span>
      ) : (
        <Icons.Thread size={18} className="text-accent" />
      )}
      <span className="font-semibold text-accent group-hover/thread:underline">Ver conversas</span>
    </button>
  );
}

/** onClick troca o abrir/fechar padrão (o visualizador abre a thread e se fecha). */
const fetchingUsers = new Set<string>();

export function ThreadChip({ thread, onClick, className }: { thread: ThreadSummary; onClick?: () => void; className?: string }) {
  const open = useLine((s) => s.threadId === thread.id);
  const users = useLine((s) => s.users);
  const n = thread.messageCount;
  const ids = (thread.participantIds ?? []).slice(0, 3);
  const extra = Math.max(0, (thread.participantCount ?? ids.length) - ids.length);
  // Quem respondeu e ainda não está carregado: busca o perfil para já mostrar a foto certa.
  const missing = ids.filter((id) => !users[id]).join(',');
  useEffect(() => {
    for (const id of missing ? missing.split(',') : []) {
      if (fetchingUsers.has(id)) continue;
      fetchingUsers.add(id);
      api.user(id).then((u) => actions.upsertUsers([u]), () => fetchingUsers.delete(id));
    }
  }, [missing]);
  return (
    <button
      onClick={onClick ?? (() => (open ? actions.closeThread() : actions.openThread(thread.id)))}
      className={cx('group/thread mt-1 flex items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-left text-sm hover:bg-hover/60', open && 'bg-accent/10', className)}
    >
      {ids.length > 0 ? (
        <span className="flex items-center -space-x-1">
          {ids.map((id) =>
            users[id] ? (
              <Avatar key={id} name={users[id].displayName} color={users[id].avatarColor} src={users[id].avatarUrl} size={22} />
            ) : (
              // Perfil ainda chegando: círculo neutro em vez de um ícone que depois troca.
              <span key={id} className="size-[22px] shrink-0 rounded-full bg-raise" />
            ),
          )}
          {extra > 0 && (
            <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-raise px-1 text-[10px] font-bold text-soft">
              +{extra}
            </span>
          )}
        </span>
      ) : (
        <Icons.Thread size={18} className="text-accent" />
      )}
      <span className="font-semibold text-accent group-hover/thread:underline">
        {n === 0 ? 'Responder' : n === 1 ? '1 resposta' : `${n} respostas`}
      </span>
      {thread.lastMessageAt && n > 0 && (
        <span className="text-xs text-muted opacity-0 transition-opacity group-hover/thread:opacity-100">
          Última resposta {formatTime(thread.lastMessageAt)}
        </span>
      )}
    </button>
  );
}

type ComposerHandle = { addFiles: (files: File[]) => void; addUrl: (url: string) => void };

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'video/quicktime': 'mov', 'image/x-icon': 'ico' };

/** Nome de arquivo para mídia baixada de um link. */
function nameFromUrl(url: string, type: string) {
  const ext = EXT[type] ?? (type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  let base = '';
  if (!url.startsWith('data:')) {
    try {
      base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {
      /* link estranho: usa o nome padrão */
    }
  }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60);
  return `${base || (type.startsWith('video/') ? 'video' : 'imagem')}.${ext}`;
}

/** Primeira entrada num canal +18: aviso centralizado com Voltar e Prosseguir. Sem data de
 * nascimento (ou menor de 18) não dá para prosseguir. */
function NsfwChannelGate({ channel, adult }: { channel: Channel; adult: boolean }) {
  const server = useLine((s) => (channel.serverId ? s.servers[channel.serverId] : undefined));
  const hasBirth = !!useLine((s) => s.me?.birthDate);
  const ChanIcon = channelIcon(channel);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <MobileBack />
        <ChanIcon size={20} className="text-muted" />
        <h1 className="truncate font-bold">{channel.name}</h1>
        <span className="flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-bold text-amber-400"><Icons.Warning size={12} />Conteúdo Sensível</span>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-400/15 text-amber-400"><Icons.Warning size={32} /></span>
        <h2 className="text-2xl font-bold">Canal com conteúdo sensível</h2>
        <p className="max-w-[520px] text-[15px] leading-relaxed text-soft">
          {adult
            ? `Este canal foi marcado como +18 pela administração de ${server?.name ?? 'este servidor'} e pode ter conteúdo sensível. Prossiga só se você tem 18 anos ou mais.`
            : hasBirth
              ? 'Este canal foi marcado como +18 e só pode ser aberto por quem tem 18 anos ou mais.'
              : 'Este canal foi marcado como +18. Para entrar, informe sua data de nascimento em Configurações, Minha conta.'}
        </p>
        <div className="mt-1 flex gap-3">
          <button onClick={() => goBack()} className="rounded-lg bg-raise px-5 py-2.5 text-sm font-semibold text-fg hover:bg-hover">
            Voltar
          </button>
          {adult ? (
            <button
              onClick={() => {
                acceptNsfwChannel(channel.id);
                if (channel.type === 'voice') void joinVoice(channel.id);
              }}
              className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-strong"
            >
              Prosseguir
            </button>
          ) : (
            !hasBirth && (
              <button
                onClick={() => actions.openModal({ kind: 'settings', section: 'account' })}
                className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-strong"
              >
                Informar data de nascimento
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

interface Pending {
  key: string;
  name: string;
  size: number;
  type: string;
  preview?: string;
  progress: number;
  attachment?: Attachment;
  error?: string;
  spoiler?: boolean;
  nsfw?: boolean;
  /** A detecção automática ainda está olhando a imagem/vídeo. */
  checking?: boolean;
  /** Marcado como +18 pela detecção automática. */
  autoNsfw?: boolean;
}

const MAX_FILE = 100 * 1024 * 1024;
const MAX_FILES = 10;
/** Texto colado maior que isso vira um arquivo .txt (como no Discord). */
const LONG_PASTE = 2000;

/** Caixa de texto padrão do chat. onSent avisa onde a mensagem foi parar (a thread criada no caso de um rascunho). */
export function Composer({ channel, placeholder, ref: handle, onSent }: { channel: Channel; placeholder: string; ref?: Ref<ComposerHandle>; onSent?: (targetId: string) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const [voiceSending, setVoiceSending] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const mentions = useRef<MentionPickerHandle>(null);
  const slash = useRef<SlashPickerHandle>(null);
  const [searching, setSearching] = useState(0);
  const [caret, setCaret] = useState(0);
  const myPerms = useLine((s) => channelPermsOf(s, channel.id, s.me?.id));
  const canSend = hasPerm(myPerms, Perm.SendMessages);
  const canAttach = hasPerm(myPerms, Perm.AttachFiles);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const patch = (key: string, p: Partial<Pending>) => setPending((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  function addFiles(files: File[]) {
    if (!canAttach) {
      setNotice('Você não tem permissão para anexar arquivos aqui.');
      window.setTimeout(() => setNotice(''), 4000);
      return;
    }
    const room = MAX_FILES - pendingRef.current.length;
    if (files.length > room) toast(`Dá para enviar até ${MAX_FILES} anexos por mensagem.`, 'error');
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = file.name || 'arquivo';
      const kind = attachmentKind(file.type, name);
      const item: Pending = {
        key,
        name,
        size: file.size,
        type: file.type,
        progress: 0,
        preview: kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : undefined,
        error: file.size > MAX_FILE ? 'Maior que 100 MB' : file.size === 0 ? 'Arquivo vazio' : undefined,
        checking: kind === 'image' || kind === 'video',
      };
      setPending((list) => [...list, item]);
      if (item.error) continue;
      if (item.checking) {
        const level = channel.serverId ? useLine.getState().servers[channel.serverId]?.nsfwLevel : undefined;
        void looksNsfw(file, level ?? 'moderate').then((hit) => {
          patch(key, hit ? { checking: false, nsfw: true, autoNsfw: true } : { checking: false });
          if (hit) toast('Esse anexo parece conteúdo +18 e foi marcado como +18.');
        });
      }
      api
        .uploadAttachment(file, name, (f) => patch(key, { progress: f }))
        .then((attachment) => patch(key, { attachment, progress: 1 }))
        .catch((e: Error) => patch(key, { error: e.message }));
    }
    ref.current?.focus();
  }

  /** Imagem/vídeo arrastado de um site: baixa direto (se o site deixar) ou pelo servidor. */
  async function addUrl(url: string) {
    if (!canAttach) return addFiles([]);
    setNotice('Baixando arquivo…');
    let blob: Blob | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) blob = await res.blob();
    } catch {
      /* CORS ou rede: tenta pelo servidor */
    }
    try {
      if (!blob || !/^(image|video)\//.test(blob.type)) blob = await api.fetchMedia(url);
      setNotice('');
      addFiles([new File([blob], nameFromUrl(url, blob.type), { type: blob.type })]);
    } catch (e) {
      setNotice((e as Error).message || 'Não deu para baixar esse arquivo.');
      window.setTimeout(() => setNotice(''), 4000);
    }
  }

  useImperativeHandle(handle, () => ({ addFiles, addUrl }));

  // "Mencionar" do menu de usuário da voz: só o campo do canal principal (não o da thread).
  useEffect(() => {
    if (channel.type === 'thread') return;
    const onMention = (e: Event) => {
      const tag = mentionsToText((e as CustomEvent<string>).detail, channel.serverId);
      setText((t) => (t && !t.endsWith(' ') ? `${t} ${tag}` : t + tag));
      ref.current?.focus();
    };
    window.addEventListener('line:mention', onMention);
    return () => window.removeEventListener('line:mention', onMention);
  }, [channel.type, channel.serverId]);

  /** Põe o texto onde está o cursor do campo (usado pelo seletor de emojis). */
  function insertText(piece: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText((t) => t.slice(0, start) + piece + t.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + piece.length, start + piece.length);
    });
  }

  /** GIF escolhido vira anexo pendente, para mandar junto com texto (ou sozinho). */
  async function addGif(url: string, title: string) {
    try {
      const res = await fetch(url.replace(/\.webp(\?|$)/, '.gif$1'));
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const name = `${(title || 'gif').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'gif'}.gif`;
      addFiles([new File([blob], name, { type: blob.type || 'image/gif' })]);
    } catch {
      // Sem acesso ao arquivo: manda o link mesmo.
      void send(url);
    }
  }

  function remove(key: string) {
    setPending((list) => {
      const item = list.find((x) => x.key === key);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return list.filter((x) => x.key !== key);
    });
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    const pasted = e.clipboardData.getData('text/plain');
    if (pasted.length > LONG_PASTE) {
      e.preventDefault();
      addFiles([new File([pasted], 'mensagem.txt', { type: 'text/plain' })]);
    }
  }
  const typing = useLine((s) => s.typing[channel.id]);
  const meId = useLine((s) => s.me?.id);
  const typers = Object.entries(typing ?? {})
    .filter(([id, t]) => id !== meId && t.until > Date.now())
    .map(([, t]) => t.name);

  useEffect(() => {
    setText('');
    setPending((list) => {
      for (const x of list) if (x.preview) URL.revokeObjectURL(x.preview);
      return [];
    });
    ref.current?.focus();
  }, [channel.id]);

  const uploading = pending.some((x) => !x.error && (!x.attachment || x.checking));
  const ready = pending.filter((x) => x.attachment).map((x) => x.attachment!.id);
  const flagIds = (flag: 'spoiler' | 'nsfw') => pending.filter((x) => x.attachment && x[flag]).map((x) => x.attachment!.id);

  /** Mensagem de voz vai direto, sem passar pelos anexos pendentes. */
  async function sendVoice(file: File) {
    setVoiceSending(true);
    try {
      const attachment = await api.uploadAttachment(file, file.name);
      const target = await resolveTarget();
      actions.addMessage(await api.sendMessage(target, '', [attachment.id], ['audio']));
      if (target !== channel.id) actions.openThread(target);
      onSent?.(target);
    } catch (e) {
      showError(e);
    } finally {
      setVoiceSending(false);
      ref.current?.focus();
    }
  }

  /** Primeira resposta de um "Responder": cria a thread agora e manda a mensagem nela. */
  async function resolveTarget() {
    if (channel.id.startsWith('draft:') && channel.parentId) {
      const thread = await api.createThread(channel.parentId, channel.name, channel.threadMessageId ?? undefined, channel.threadAttachmentId ?? undefined);
      actions.upsertChannel(thread);
      return thread.id;
    }
    return channel.id;
  }

  async function send(gif?: string) {
    const content = gif ?? textToMentions(text.trim(), channel.serverId);
    if (!gif && ((!content && !ready.length) || uploading)) return;
    if (sending) return;
    // /stop: para a música do canal de voz em que estou (só quem deu o /play).
    if (!gif && channel.serverId && /^\/stop\s*$/i.test(text.trim())) {
      if (stopCommand(channel.serverId)) setText('');
      return;
    }
    // /play [link]: o bot de música põe o vídeo na fila (não vira mensagem).
    const play = !gif && channel.serverId ? /^\/play(?:\s+(.+))?$/i.exec(text.trim()) : null;
    if (play) {
      if (!play[1]) return toast('Use /play [link do YouTube ou nome da música]');
      // Libera a caixa na hora; o aviso do bot fica acima dela até a música ser encontrada.
      setText('');
      setSearching((n) => n + 1);
      try {
        await api.musicPlay(channel.id, play[1]);
      } catch (e) {
        showError(e);
      } finally {
        setSearching((n) => n - 1);
      }
      return;
    }
    // /pular, /pausar, /voltar: controles da música (quem não é o DJ vota).
    const ctl = !gif && channel.serverId ? /^\/(pular|skip|pausar|pause|voltar|back)\s*$/i.exec(text.trim()) : null;
    if (ctl) {
      const k = ctl[1]!.toLowerCase();
      const action = k === 'pular' || k === 'skip' ? 'skip' : k === 'voltar' || k === 'back' ? 'prev' : 'pause';
      if (controlCommand(channel.serverId!, action)) setText('');
      return;
    }
    const mass = !gif && channel.serverId ? massMention(content) : null;
    if (mass && !hasPerm(myPerms, Perm.MentionEveryone)) {
      toast(`Seu cargo não permite usar @${mass}: a mensagem vai sem notificar ninguém.`);
    } else if (mass) {
      const ok = await confirmDialog({
        title: `Notificar @${mass}`,
        message: mass === 'todos' ? 'Você vai notificar todas as pessoas nesse servidor.' : 'Você vai notificar todas as pessoas nesse chat.',
        confirmLabel: 'Enviar',
      });
      ref.current?.focus();
      if (!ok) return;
    }
    setSending(true);
    try {
      const target = await resolveTarget();
      // Áudio usa o player novo: apps antigos mostram o aviso de atualizar.
      const hasAudio = !gif && pending.some((x) => x.attachment && attachmentKind(x.type, x.name) === 'audio');
      const message = await api.sendMessage(
        target,
        content,
        gif ? [] : ready,
        hasAudio ? ['audio'] : [],
        gif ? {} : { spoilerIds: flagIds('spoiler'), nsfwIds: flagIds('nsfw') },
      );
      actions.addMessage(message);
      if (target !== channel.id) actions.openThread(target);
      onSent?.(target);
      if (gif) return;
      setText('');
      setPending((list) => {
        for (const x of list) if (x.preview) URL.revokeObjectURL(x.preview);
        return [];
      });
    } catch (e) {
      showError(e);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentions.current?.onKeyDown(e)) return;
    if (slash.current?.onKeyDown(e)) return;
    if (e.key === 'ArrowUp' && !text && !pending.length && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('line:edit-last', { detail: channel.id }));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="shrink-0 px-4 pb-2">
      {notice && <p className="mb-1.5 px-1 text-xs font-semibold text-sun">{notice}</p>}
      {searching > 0 && <MusicSearching serverId={channel.serverId} />}
      <div className="relative rounded-xl bg-raise">
        {canSend && (
          <SlashPicker
            ref={slash}
            serverId={channel.serverId}
            text={text}
            onPick={(insert) => {
              setText(insert);
              setCaret(insert.length);
              requestAnimationFrame(() => {
                ref.current?.focus();
                ref.current?.setSelectionRange(insert.length, insert.length);
              });
            }}
          />
        )}
        {canSend && (
          <MentionPicker
            ref={mentions}
            serverId={channel.serverId}
            channelId={channel.id}
            text={text}
            caret={caret}
            onPick={(start, end, insert) => {
              const next = text.slice(0, start) + insert + text.slice(end);
              setText(next);
              const pos = start + insert.length;
              setCaret(pos);
              requestAnimationFrame(() => {
                ref.current?.focus();
                ref.current?.setSelectionRange(pos, pos);
              });
            }}
          />
        )}
        {pending.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-b border-edge p-3">
            {pending.map((p) => (
              <PendingCard
                key={p.key}
                item={p}
                onRemove={() => remove(p.key)}
                onToggle={(flag) => {
                  if (flag === 'nsfw' && p.autoNsfw) return toast('Esse anexo foi identificado como +18 e não dá para tirar a marca.');
                  patch(p.key, flag === 'spoiler' ? { spoiler: !p.spoiler } : { nsfw: !p.nsfw });
                }}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 px-3 py-2.5">
        {canSend && (
        <span className="relative shrink-0">
          <button
            title="Mais opções"
            onClick={() => setMenu((v) => !v)}
            className={cx('flex h-6 w-6 items-center justify-center rounded-full text-soft transition-transform hover:text-fg', menu && 'rotate-45 text-fg')}
          >
            <Icons.Plus size={20} />
          </button>
          {menu && (
            <ComposerMenu
              onClose={() => setMenu(false)}
              items={[
                ...(canAttach ? [{ icon: <Icons.Upload size={18} />, label: 'Enviar um arquivo', run: () => picker.current?.click() }] : []),
                ...(!channel.id.startsWith('draft:') && hasPerm(myPerms, Perm.CreatePolls)
                  ? [{ icon: <Icons.Poll size={18} />, label: 'Criar enquete', run: () => actions.openModal({ kind: 'create-poll', channelId: channel.id }) }]
                  : []),
                ...(canAttach ? [{ icon: <Icons.Mic size={18} />, label: 'Gravar mensagem de voz', run: () => setRecording(true) }] : []),
              ]}
            />
          )}
        </span>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        {recording ? (
          <VoiceRecorder
            onCancel={() => setRecording(false)}
            onDone={(file) => {
              setRecording(false);
              void sendVoice(file);
            }}
          />
        ) : !canSend ? (
          <p className="flex-1 py-0.5 text-[15px] text-muted">
            Você não tem permissão para enviar mensagens neste canal.
          </p>
        ) : (
        <textarea
          ref={ref}
          data-composer
          value={text}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            if (e.target.value && !channel.id.startsWith('draft:')) sendTyping(channel.id);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
          maxLength={4000}
          className="max-h-60 min-h-6 flex-1 resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-muted"
          style={{ height: `${Math.min(240, 24 * Math.max(1, text.split('\n').length))}px` }}
        />
        )}
        {uploading && <span className="shrink-0 self-center text-xs text-muted">Enviando arquivos…</span>}
        {voiceSending && <span className="shrink-0 self-center text-xs text-muted">Enviando mensagem de voz…</span>}
        {canSend && !recording && (
        <span className="relative shrink-0">
          <button
            title="Emojis"
            onClick={(e) => {
              const el = e.currentTarget;
              setEmojiAnchor((a) => (a ? null : el));
            }}
            className={cx('flex h-6 items-center text-soft hover:text-fg', emojiAnchor && 'text-fg')}
          >
            <Icons.Smile size={22} />
          </button>
          {emojiAnchor && (
            <EmojiPicker
              anchor={emojiAnchor}
              onClose={() => setEmojiAnchor(null)}
              onPick={(emoji, keepOpen) => {
                insertText(emoji);
                if (!keepOpen) setEmojiAnchor(null);
              }}
            />
          )}
        </span>
        )}
        {canSend && canAttach && !recording && (
        <span className="relative shrink-0">
          <button
            title="GIFs"
            onClick={() => setGifOpen((v) => !v)}
            className={cx('flex h-6 items-center text-soft hover:text-fg', gifOpen && 'text-fg')}
          >
            <Icons.Gif size={22} />
          </button>
          {gifOpen && (
            <GifPicker
              onClose={() => setGifOpen(false)}
              onPick={(g) => {
                setGifOpen(false);
                void addGif(g.url, g.title);
              }}
            />
          )}
        </span>
        )}
        {canSend && canAttach && !recording && (
          <button
            title="Gravar mensagem de voz"
            onClick={() => setRecording(true)}
            disabled={voiceSending}
            className="flex h-6 shrink-0 items-center text-soft hover:text-fg disabled:opacity-40"
          >
            <Icons.Mic size={22} />
          </button>
        )}
        </div>
      </div>
      <div className="h-5 px-1 pt-0.5 text-xs text-soft">
        {typers.length > 0 && (
          <span className="flex items-center gap-1.5">
            <TypingDots />
            <strong>{typers.slice(0, 3).join(', ')}</strong>
            {typers.length === 1 ? ' está digitando…' : ' estão digitando…'}
          </span>
        )}
      </div>
    </div>
  );
}

function ComposerMenu({ items, onClose }: { items: { icon: ReactNode; label: string; run: () => void }[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="absolute bottom-full left-0 z-30 mb-3 w-60 rounded-xl border border-edge bg-rail p-1.5 shadow-2xl">
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => {
            onClose();
            it.run();
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-soft hover:bg-hover hover:text-fg"
        >
          <span className="text-muted">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Grava uma mensagem de voz: lixeira, tempo, forma de onda ao vivo, pausar e enviar. */
function VoiceRecorder({ onDone, onCancel }: { onDone: (file: File) => void; onCancel: () => void }) {
  const [ms, setMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const finish = useRef<'send' | 'cancel'>('cancel');
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const chunks: Blob[] = [];
    let timer = 0;
    let alive = true;
    navigator.mediaDevices
      .getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
        const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
        rec.current = r;
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          if (finish.current !== 'send' || !chunks.length) return;
          const mime = r.mimeType.split(';')[0] || 'audio/webm';
          const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
          const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
          onDone(new File(chunks, `mensagem-de-voz-${stamp}.${ext}`, { type: mime }));
        };
        r.start(250);
        // Nível do microfone para desenhar a forma de onda enquanto grava.
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let last = performance.now();
        timer = window.setInterval(() => {
          const now = performance.now();
          const dt = now - last;
          last = now;
          if (pausedRef.current) return;
          setMs((n) => n + dt);
          analyser.getByteTimeDomainData(buf);
          let peak = 0;
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
          setLevels((l) => [...l.slice(-59), Math.min(1, peak * 2.5)]);
        }, 100);
      })
      .catch(() => setError('Sem acesso ao microfone.'));
    return () => {
      alive = false;
      window.clearInterval(timer);
      if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePause = () => {
    const r = rec.current;
    if (!r) return;
    if (r.state === 'recording') {
      r.pause();
      setPaused(true);
    } else if (r.state === 'paused') {
      r.resume();
      setPaused(false);
    }
  };
  const send = () => {
    finish.current = 'send';
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop();
  };
  const cancel = () => {
    finish.current = 'cancel';
    onCancel();
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') send();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const secs = Math.floor(ms / 1000);
  const bars = [...Array.from({ length: Math.max(0, 60 - levels.length) }, () => 0), ...levels];

  return (
    <div className="flex min-h-6 flex-1 items-center gap-3 text-sm">
      <button onClick={cancel} title="Descartar" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-danger">
        <Icons.Trash size={18} />
      </button>
      {error ? (
        <span className="flex-1 text-danger">{error}</span>
      ) : (
        <>
          <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full bg-danger', !paused && 'animate-pulse', paused && 'opacity-40')} />
          <span className="w-10 shrink-0 font-mono text-[15px] font-semibold text-fg">
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
          </span>
          <div className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
            {bars.map((v, i) => (
              <span key={i} className={cx('w-[3px] shrink-0 rounded-full', v ? 'bg-soft' : 'bg-muted/40')} style={{ height: `${Math.max(8, v * 100)}%` }} />
            ))}
          </div>
          <button
            onClick={togglePause}
            title={paused ? 'Continuar gravando' : 'Pausar'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-danger hover:bg-hover"
          >
            {paused ? <Icons.Mic size={18} /> : <Icons.Pause size={18} />}
          </button>
          <button
            onClick={send}
            title="Enviar mensagem de voz"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent hover:brightness-110"
          >
            <Icons.Send size={17} />
          </button>
        </>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-soft" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

function PendingCard({ item, onRemove, onToggle }: { item: Pending; onRemove: () => void; onToggle: (flag: 'spoiler' | 'nsfw') => void }) {
  const kind = attachmentKind(item.type, item.name);
  const done = !!item.attachment;
  return (
    <div className="relative flex w-44 shrink-0 flex-col rounded-lg border border-edge bg-side p-2">
      <button
        title="Remover"
        onClick={onRemove}
        className="absolute -top-2 -right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-rail text-muted shadow hover:text-danger"
      >
        <Icons.X size={14} />
      </button>
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-md bg-rail">
        {kind === 'image' && item.preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.preview} alt={item.name} className="h-full w-full object-cover" />
        ) : kind === 'video' && item.preview ? (
          <video src={item.preview} muted className="h-full w-full object-cover" />
        ) : kind === 'text' ? (
          <Icons.FileText size={36} className="text-accent" />
        ) : (
          <Icons.File size={36} className="text-accent" />
        )}
      </div>
      <p className="mt-1.5 truncate text-xs font-medium text-fg" title={item.name}>
        {item.name}
      </p>
      {item.error ? (
        <p className="truncate text-[11px] text-danger" title={item.error}>
          {item.error}
        </p>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-rail">
            <div className={cx('h-full rounded-full', done ? 'bg-online' : 'bg-accent')} style={{ width: `${Math.round(item.progress * 100)}%` }} />
          </div>
          <span className="text-[10px] text-muted">{formatSize(item.size)}</span>
        </div>
      )}
      {!item.error && (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => onToggle('spoiler')}
            title="Fica borrado até a pessoa clicar"
            className={cx(
              'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors',
              item.spoiler ? 'border-accent bg-accent/15 text-accent' : 'border-edge text-muted hover:text-fg',
            )}
          >
            <Icons.Warning size={12} /> Spoiler
          </button>
          <button
            type="button"
            onClick={() => onToggle('nsfw')}
            title={item.autoNsfw ? 'Identificado automaticamente como +18 (não dá para tirar)' : 'Só quem tem 18 anos ou mais vê'}
            className={cx(
              'rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors',
              item.nsfw ? 'border-danger bg-danger/15 text-danger' : 'border-edge text-muted hover:text-fg',
              item.autoNsfw && 'cursor-not-allowed',
            )}
          >
            {item.autoNsfw && <Icons.Lock size={11} className="mr-0.5 inline" />}+18
          </button>
          {item.checking && <span className="ml-auto text-[10px] text-muted">Verificando…</span>}
        </div>
      )}
    </div>
  );
}
