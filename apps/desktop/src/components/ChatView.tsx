'use client';

import type { Attachment, Channel, Message } from '@line/shared';
import { GifEmbed, GifPicker, gifFromContent } from './GifPicker';
import { Fragment, type ReactNode, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type Ref } from 'react';
import { api } from '@/lib/api';
import { attachmentKind, AttachmentList, formatSize } from './Attachments';
import { renderMarkdown } from '@/lib/markdown';
import { loadMessages, sendTyping } from '@/lib/session';
import { actions, dmTitle, useLine } from '@/lib/store';
import { joinVoice, toggleCamera, useVoice } from '@/lib/voice';
import { Avatar, cx, Icons, MessageSkeletons } from './ui';
import { VoiceStage } from './Voice';

const GROUP_WINDOW_MS = 7 * 60 * 1000;
const EMPTY: Message[] = [];

export function ChatView({ channel }: { channel: Channel }) {
  const me = useLine((s) => s.me);
  const users = useLine((s) => s.users);
  const isDm = !channel.serverId;
  const title = isDm ? dmTitle(channel, me?.id, users) : channel.name;
  const other = isDm && channel.type === 'dm' ? channel.recipients?.find((r) => r.id !== me?.id) : undefined;

  const callActive = useVoice((v) => v.channelId === channel.id || Object.values(v.states).some((s) => s.channelId === channel.id));
  const inCall = useVoice((v) => v.channelId === channel.id);
  const composer = useRef<ComposerHandle>(null);
  const drop = useFileDrop((files) => composer.current?.addFiles(files));

  useEffect(() => {
    actions.markRead(channel.id);
    const onFocus = () => actions.markRead(channel.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channel.id]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.handlers}>
      {drop.over && <DropOverlay target={isDm ? title : `#${channel.name}`} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        {isDm ? (
          other ? (
            <Avatar name={title} color={(users[other.id] ?? other).avatarColor} src={(users[other.id] ?? other).avatarUrl} size={24} presence={(users[other.id] ?? other).presence} ring="main" />
          ) : (
            <Icons.Users size={20} className="text-muted" />
          )
        ) : (
          <Icons.Hash size={20} className="text-muted" />
        )}
        <h1 className="font-bold">{title}</h1>
        {channel.topic && (
          <>
            <span className="mx-2 h-6 w-px bg-edge" />
            <p className="truncate text-sm text-muted">{channel.topic}</p>
          </>
        )}
        {isDm && !inCall && (
          <div className="ml-auto flex gap-1">
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
      <Composer ref={composer} channel={channel} placeholder={isDm ? `Conversar com ${title}` : `Conversar em #${channel.name}`} />
    </div>
  );
}

/** Painel lateral com a conversa de uma thread. */
export function ThreadPanel({ thread }: { thread: Channel }) {
  const composer = useRef<ComposerHandle>(null);
  const drop = useFileDrop((files) => composer.current?.addFiles(files));
  const meId = useLine((s) => s.me?.id);
  const isServerOwner = useLine((s) => (thread.serverId ? s.servers[thread.serverId]?.ownerId === meId : false));
  const canDelete = !thread.id.startsWith("draft:") && (isServerOwner || thread.ownerId === meId);

  useEffect(() => {
    actions.markRead(thread.id);
  }, [thread.id]);

  return (
    <aside className="relative flex w-[420px] shrink-0 flex-col border-l border-rail bg-main" {...drop.handlers}>
      {drop.over && <DropOverlay target={thread.name} />}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <h2 className="font-bold">Conversa</h2>
        <span className="truncate text-sm text-muted">{thread.name}</span>
        <div className="ml-auto flex gap-1">
          {canDelete && (
            <button
              title="Apagar thread"
              onClick={async () => {
                if (confirm(`Apagar a thread "${thread.name}"? As mensagens dela serão apagadas.`)) {
                  await api.deleteChannel(thread.id).catch((e) => alert(e.message));
                }
              }}
              className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-danger"
            >
              <Icons.Trash size={18} />
            </button>
          )}
          <button title="Fechar thread" onClick={actions.closeThread} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
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

/** Arrastar e soltar arquivos em cima do chat. */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}

function MessageList({ channel, title, footer }: { channel: Channel; title: string; footer?: ReactNode }) {
  const bucket = useLine((s) => s.messages[channel.id]);
  const meId = useLine((s) => s.me?.id);
  const myUsername = useLine((s) => s.me?.username);
  const users = useLine((s) => s.users);
  const isOwner = useLine((s) => (channel.serverId ? s.servers[channel.serverId]?.ownerId === meId : false));
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const lastTop = useRef(0);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const items = bucket?.items ?? EMPTY;
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
  }, [items]);

  async function onScroll() {
    const el = scroller.current;
    if (!el) return;
    // Só solta do fim quando a pessoa rola para cima (conteúdo crescendo não conta).
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) stickToBottom.current = true;
    else if (el.scrollTop < lastTop.current - 1) stickToBottom.current = false;
    lastTop.current = el.scrollTop;
    if (el.scrollTop < 120 && bucket?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      await loadMessages(channel.id, true).catch(() => (loadingOlder.current = false));
    }
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
      <div ref={content} className={cx('flex flex-col', isThread ? 'pb-2' : 'min-h-full justify-end pb-4')}>
        {bucket && !bucket.hasMore && isThread && (
          <div className="pt-3">
            {starter ? (
              <div className="flex gap-3 px-4 py-1">
                <Avatar
                  name={(users[starter.author.id] ?? starter.author).displayName}
                  color={(users[starter.author.id] ?? starter.author).avatarColor}
                  src={(users[starter.author.id] ?? starter.author).avatarUrl}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="font-semibold">{(users[starter.author.id] ?? starter.author).displayName}</span>
                    <span className="text-xs text-muted">{formatTime(starter.createdAt)}</span>
                  </p>
                  {starter.content && <div className="text-[15px] break-words whitespace-pre-wrap">{renderMarkdown(starter.content, myUsername)}</div>}
                  <AttachmentList attachments={starter.attachments} compact />
                </div>
              </div>
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
              {channel.serverId ? <Icons.Hash size={36} /> : <Icons.Message size={32} />}
            </div>
            <h2 className="text-3xl font-bold">{channel.serverId ? `Bem-vindo a #${title}!` : title}</h2>
            <p className="mt-1 text-muted">
              {channel.serverId
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
            prev?.author.id === m.author.id &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
          const author = users[m.author.id] ?? m.author;
          return (
            <Fragment key={m.id}>
              {newDay && <DayDivider date={m.createdAt} />}
              <MessageRow
                highlighted={highlight === m.id}
                message={m}
                authorName={author.displayName}
                authorColor={author.avatarColor}
                grouped={grouped}
                mine={m.author.id === meId}
                canDelete={m.author.id === meId || isOwner}
                editing={editing === m.id}
                onEdit={() => setEditing(m.id)}
                onDoneEditing={() => setEditing(null)}
                myUsername={myUsername}
                canThread={channel.type === 'text'}
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
  grouped,
  mine,
  canDelete,
  editing,
  onEdit,
  onDoneEditing,
  myUsername,
  canThread,
  tight,
}: {
  highlighted?: boolean;
  message: Message;
  authorName: string;
  authorColor: string;
  grouped: boolean;
  mine: boolean;
  canDelete: boolean;
  editing: boolean;
  onEdit: () => void;
  onDoneEditing: () => void;
  myUsername?: string;
  canThread: boolean;
  tight?: boolean;
}) {
  const [draft, setDraft] = useState(message.content);
  const showThreadAction = canThread && !message.thread;
  const mentionsMe = !!myUsername && message.content.toLowerCase().includes(`@${myUsername}`);

  async function saveEdit() {
    const content = draft.trim();
    if ((!content && !message.attachments.length) || content === message.content) return onDoneEditing();
    try {
      await api.editMessage(message.id, content);
      onDoneEditing();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div
      data-mid={message.id}
      className={cx(
        'group relative flex gap-4 px-4 py-1.5 transition-colors duration-700 hover:bg-black/10',
        !grouped && (tight ? 'mt-2' : 'mt-4'),
        mentionsMe && 'border-l-2 border-sun bg-sun/5 hover:bg-sun/10',
        highlighted && 'bg-accent/15',
      )}
    >
      <div className="w-10 shrink-0">
        {grouped ? (
          <span className="invisible block pt-1 text-right text-[10px] text-muted group-hover:visible">
            {new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <button onClick={(e) => actions.openModal({ kind: 'user', userId: message.author.id, at: { x: e.clientX, y: e.clientY } })}>
            <Avatar name={authorName} color={authorColor} src={(useLine.getState().users[message.author.id] ?? message.author).avatarUrl} size={40} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <button
              onClick={(e) => actions.openModal({ kind: 'user', userId: message.author.id, at: { x: e.clientX, y: e.clientY } })}
              className="font-semibold hover:underline"
              style={{ color: authorColor }}
            >
              {authorName}
            </button>
            <span className="text-xs text-muted">{formatTime(message.createdAt)}</span>
          </div>
        )}
        {editing ? (
          <div className="py-1">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === 'Escape') onDoneEditing();
              }}
              rows={Math.min(8, draft.split('\n').length)}
              className="w-full resize-none rounded-lg bg-raise px-3 py-2 text-[15px] outline-none"
            />
            <p className="text-xs text-muted">Esc para cancelar · Enter para salvar</p>
          </div>
        ) : (
          message.content &&
          (gifFromContent(message.content) ? (
            <GifEmbed url={gifFromContent(message.content)!} />
          ) : (
            <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-soft">
              {renderMarkdown(message.content, myUsername)}
              {message.editedAt && <span className="ml-1 text-[10px] text-muted">(editado)</span>}
            </div>
          ))
        )}
        <AttachmentList attachments={message.attachments} />
        {message.poll && <PollView message={message} poll={message.poll} />}
        {message.thread && <ThreadChip thread={message.thread} />}
      </div>

      {!editing && (mine || canDelete || showThreadAction) && (
        <div className="absolute -top-3 right-4 hidden rounded-lg border border-edge bg-side shadow group-hover:flex">
          {showThreadAction && (
            <button
              title="Responder"
              onClick={() => {
                const parent = useLine.getState().channels[message.channelId];
                const name = (message.content.split('\n')[0] || message.attachments[0]?.filename || 'Conversa').slice(0, 60);
                if (parent) actions.openThreadDraft(parent, message.id, name);
              }}
              className="p-1.5 text-muted hover:text-fg"
            >
              <Icons.Reply size={16} />
            </button>
          )}
          {mine && (
            <button title="Editar" onClick={() => { setDraft(message.content); onEdit(); }} className="p-1.5 text-muted hover:text-fg">
              <Icons.Edit size={16} />
            </button>
          )}
          {canDelete && (
            <button
              title="Apagar"
              onClick={async (e) => {
                if (e.shiftKey || confirm('Apagar esta mensagem?')) await api.deleteMessage(message.id).catch((err) => alert(err.message));
              }}
              className="p-1.5 text-muted hover:text-danger"
            >
              <Icons.Trash size={16} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PollView({ message, poll }: { message: Message; poll: NonNullable<Message['poll']> }) {
  const meId = useLine((s) => s.me?.id);
  const voters = new Set(poll.options.flatMap((o) => o.voterIds));
  const total = poll.options.reduce((n, o) => n + o.voterIds.length, 0);
  const vote = (optionId: string) => void api.votePoll(message.id, optionId).then(actions.addMessage).catch((e) => alert(e.message));
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

function ThreadChip({ thread }: { thread: NonNullable<Message['thread']> }) {
  const open = useLine((s) => s.threadId === thread.id);
  const users = useLine((s) => s.users);
  const n = thread.messageCount;
  const ids = (thread.participantIds ?? []).slice(0, 3);
  const extra = Math.max(0, (thread.participantCount ?? ids.length) - ids.length);
  return (
    <button
      onClick={() => (open ? actions.closeThread() : actions.openThread(thread.id))}
      className={cx('group/thread mt-1 flex items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-left text-sm hover:bg-hover/60', open && 'bg-accent/10')}
    >
      {ids.length > 0 ? (
        <span className="flex items-center -space-x-1.5">
          {ids.map((id) => (
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

type ComposerHandle = { addFiles: (files: File[]) => void };

interface Pending {
  key: string;
  name: string;
  size: number;
  type: string;
  preview?: string;
  progress: number;
  attachment?: Attachment;
  error?: string;
}

const MAX_FILE = 100 * 1024 * 1024;
const MAX_FILES = 5;
/** Texto colado maior que isso vira um arquivo .txt (como no Discord). */
const LONG_PASTE = 2000;

function Composer({ channel, placeholder, ref: handle }: { channel: Channel; placeholder: string; ref?: Ref<ComposerHandle> }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [recording, setRecording] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const patch = (key: string, p: Partial<Pending>) => setPending((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  function addFiles(files: File[]) {
    const room = MAX_FILES - pendingRef.current.length;
    if (files.length > room) {
      setNotice(`Dá para enviar até ${MAX_FILES} anexos por mensagem.`);
      window.setTimeout(() => setNotice(''), 4000);
    }
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
      };
      setPending((list) => [...list, item]);
      if (item.error) continue;
      api
        .uploadAttachment(file, name, (f) => patch(key, { progress: f }))
        .then((attachment) => patch(key, { attachment, progress: 1 }))
        .catch((e: Error) => patch(key, { error: e.message }));
    }
    ref.current?.focus();
  }

  useImperativeHandle(handle, () => ({ addFiles }));

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

  const uploading = pending.some((x) => !x.attachment && !x.error);
  const ready = pending.filter((x) => x.attachment).map((x) => x.attachment!.id);

  async function send(gif?: string) {
    const content = gif ?? text.trim();
    if (!gif && ((!content && !ready.length) || uploading)) return;
    if (sending) return;
    setSending(true);
    try {
      // Primeira resposta de um "Responder": cria a thread agora e manda a mensagem nela.
      let target = channel.id;
      if (channel.id.startsWith('draft:') && channel.parentId) {
        const thread = await api.createThread(channel.parentId, channel.name, channel.threadMessageId ?? undefined);
        actions.upsertChannel(thread);
        target = thread.id;
      }
      const message = await api.sendMessage(target, content, gif ? [] : ready);
      actions.addMessage(message);
      if (target !== channel.id) actions.openThread(target);
      if (gif) return;
      setText('');
      setPending((list) => {
        for (const x of list) if (x.preview) URL.revokeObjectURL(x.preview);
        return [];
      });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="shrink-0 px-4 pb-2">
      {notice && <p className="mb-1.5 px-1 text-xs font-semibold text-sun">{notice}</p>}
      <div className="rounded-xl bg-raise">
        {pending.length > 0 && (
          <div className="flex gap-2 overflow-x-auto border-b border-edge p-3">
            {pending.map((p) => (
              <PendingCard key={p.key} item={p} onRemove={() => remove(p.key)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 px-3 py-2.5">
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
                { icon: <Icons.Upload size={18} />, label: 'Enviar um arquivo', run: () => picker.current?.click() },
                ...(!channel.id.startsWith('draft:')
                  ? [{ icon: <Icons.Poll size={18} />, label: 'Criar enquete', run: () => actions.openModal({ kind: 'create-poll', channelId: channel.id }) }]
                  : []),
                { icon: <Icons.Mic size={18} />, label: 'Gravar mensagem de voz', run: () => setRecording(true) },
              ]}
            />
          )}
        </span>
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
              addFiles([file]);
            }}
          />
        ) : (
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
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
                void send(g.url);
              }}
            />
          )}
        </span>
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

/** Grava um áudio com o microfone e devolve como arquivo para anexar. */
function VoiceRecorder({ onDone, onCancel }: { onDone: (file: File) => void; onCancel: () => void }) {
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    const chunks: Blob[] = [];
    let timer = 0;
    navigator.mediaDevices
      .getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } })
      .then((s) => {
        stream = s;
        const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
        const r = new MediaRecorder(s, type ? { mimeType: type } : undefined);
        rec.current = r;
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        r.onstop = () => {
          stream?.getTracks().forEach((t) => t.stop());
          if (cancelled.current || !chunks.length) return;
          const mime = r.mimeType.split(';')[0] || 'audio/webm';
          const ext = mime.includes('ogg') ? 'ogg' : 'webm';
          const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
          onDone(new File(chunks, `mensagem-de-voz-${stamp}.${ext}`, { type: mime }));
        };
        r.start();
        timer = window.setInterval(() => setSeconds((n) => n + 1), 1000);
      })
      .catch(() => setError('Sem acesso ao microfone.'));
    return () => {
      window.clearInterval(timer);
      cancelled.current = true;
      if (rec.current?.state === 'recording') rec.current.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    cancelled.current = false;
    if (rec.current?.state === 'recording') rec.current.stop();
  };
  const mm = String(Math.floor(seconds / 60)).padStart(1, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div className="flex min-h-6 flex-1 items-center gap-3 text-sm">
      {error ? (
        <span className="flex-1 text-danger">{error}</span>
      ) : (
        <>
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" />
          <span className="font-mono text-soft">
            {mm}:{ss}
          </span>
          <span className="flex-1 text-muted">Gravando mensagem de voz…</span>
        </>
      )}
      <button onClick={onCancel} className="rounded-md px-2 py-0.5 text-muted hover:bg-hover hover:text-fg">
        Cancelar
      </button>
      {!error && (
        <button onClick={stop} className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-0.5 font-semibold text-white hover:brightness-110">
          <Icons.Check size={14} /> Pronto
        </button>
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

function PendingCard({ item, onRemove }: { item: Pending; onRemove: () => void }) {
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
    </div>
  );
}
