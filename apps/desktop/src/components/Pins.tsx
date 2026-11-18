'use client';

import { useEffect, useRef, useState } from 'react';
import type { Channel, Message } from '@line/shared';
import { api, fileUrl } from '@/lib/api';
import { jumpToMessage } from '@/lib/session';
import { mentionsToText, useLine } from '@/lib/store';
import { StyledName } from '@/lib/nameStyle';
import { openMenuAt, type MenuEntry } from './ContextMenu';
import { showError } from './Dialogs';
import { Avatar, cx, Icons } from './ui';

/** Durações para fixar (minutos; null = sempre). */
export const PIN_DURATIONS: { label: string; minutes: number | null }[] = [
  { label: '1 hora', minutes: 60 },
  { label: '5 horas', minutes: 300 },
  { label: '10 horas', minutes: 600 },
  { label: '1 dia', minutes: 1440 },
  { label: '7 dias', minutes: 10080 },
  { label: '30 dias', minutes: 43200 },
  { label: 'Sempre', minutes: null },
];

/** Fixada e ainda dentro do prazo. */
export function isPinned(m: Pick<Message, 'pinnedAt' | 'pinnedUntil'>) {
  return !!m.pinnedAt && (!m.pinnedUntil || new Date(m.pinnedUntil).getTime() > Date.now());
}

export function pinnedUntilLabel(until?: string | null) {
  if (!until) return 'Fixada para sempre';
  const d = new Date(until);
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `Fixada até ${when}`;
}

/** Abre a lista de durações perto do ponto clicado. */
export function openPinMenu(message: Message, at: { x: number; y: number }) {
  const pinned = isPinned(message);
  const items: MenuEntry[] = PIN_DURATIONS.map((d) => ({
    label: `${pinned ? 'Mudar para' : 'Fixar por'} ${d.label.toLowerCase()}`,
    icon: <Icons.Pin size={15} />,
    onClick: () => api.pinMessage(message.id, d.minutes).catch(showError),
  }));
  if (pinned) {
    items.push('sep', { label: 'Desafixar mensagem', icon: <Icons.PinOff size={15} />, danger: true, onClick: () => api.unpinMessage(message.id).catch(showError) });
  }
  // Espera o menu atual fechar antes de abrir o das durações.
  window.setTimeout(() => openMenuAt(at, items), 0);
}

/** Linha "Fixada até ..." em cima do conteúdo da mensagem. */
export function PinnedNote({ message }: { message: Message }) {
  if (!isPinned(message)) return null;
  return (
    <p className="flex items-center gap-1 text-xs text-muted">
      <Icons.Pin size={12} className="text-accent" />
      {pinnedUntilLabel(message.pinnedUntil)}
    </p>
  );
}

/** Spoiler e +18 não mostram miniatura na lista. */
export const hidden = (m: Message) => !!(m.attachments[0]?.spoiler || m.attachments[0]?.nsfw);

export function summary(m: Message, serverId?: string | null) {
  if (m.poll) return `📊 ${m.poll.question}`;
  const text = m.content ? mentionsToText(m.content, serverId) : '';
  if (text) return text;
  const a = m.attachments[0];
  if (!a) return 'Mensagem';
  if (a.nsfw) return '🔞 Anexo +18';
  if (a.spoiler) return '🙈 Spoiler';
  if (a.contentType.startsWith('image/')) return '🖼️ Imagem';
  if (a.contentType.startsWith('video/')) return '🎬 Vídeo';
  if (a.contentType.startsWith('audio/')) return '🎵 Áudio';
  return `📎 ${a.filename}`;
}

/** Botão do cabeçalho com a lista de mensagens fixadas do canal. */
export function PinsButton({ channel, canPin }: { channel: Channel; canPin: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Message[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Atualiza a lista quando alguma mensagem carregada do canal muda (fixar/desafixar ao vivo).
  const bucket = useLine((s) => s.messages[channel.id]?.items);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .pins(channel.id)
      .then((list) => alive && setItems(list))
      .catch((e) => {
        showError(e);
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [open, channel.id, bucket]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const shown = (items ?? []).filter(isPinned);
  const members = useLine((s) => (channel.serverId ? s.members[channel.serverId] : undefined));
  const roles = useLine((s) => (channel.serverId ? s.roles[channel.serverId] : undefined));
  const users = useLine((s) => s.users);
  // Mesma cor/apelido do chat: cor do bot, senão a do primeiro cargo colorido.
  const colorOf = (userId: string) => {
    const botColor = users[userId]?.botStyle?.nameColor;
    if (botColor) return botColor;
    const mine = members?.[userId]?.roleIds;
    return mine?.length ? (roles ?? []).find((r) => r.color && mine.includes(r.id))?.color ?? undefined : undefined;
  };

  return (
    <div ref={box} className="relative">
      <button
        title="Mensagens fixadas"
        onClick={() => setOpen((v) => !v)}
        className={cx('rounded-md p-1.5 hover:bg-hover hover:text-fg', open ? 'text-fg' : 'text-soft')}
      >
        <Icons.Pin size={20} />
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-2 flex max-h-[70vh] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-edge bg-side shadow-2xl">
          <p className="border-b border-edge px-4 py-3 font-bold">Mensagens fixadas</p>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {items === null ? (
              <p className="p-4 text-center text-sm text-muted">Carregando…</p>
            ) : !shown.length ? (
              <p className="p-4 text-center text-sm text-muted">Nenhuma mensagem fixada neste canal.</p>
            ) : (
              shown.map((m) => (
                <div
                  key={m.id}
                  role="button"
                  onClick={() => {
                    setOpen(false);
                    void jumpToMessage(m);
                  }}
                  className="group flex cursor-pointer gap-2.5 rounded-lg p-2 hover:bg-hover"
                >
                  <Avatar name={m.author.displayName} color={m.author.avatarColor} src={m.author.avatarUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <StyledName user={users[m.author.id] ?? m.author} color={colorOf(m.author.id)} className="truncate text-sm font-semibold">
                        {members?.[m.author.id]?.nickname || m.author.displayName}
                      </StyledName>
                      <span className="shrink-0 text-[11px] text-muted">{pinnedUntilLabel(m.pinnedUntil)}</span>
                    </p>
                    {!(m.attachments[0]?.contentType.startsWith('video/') && !hidden(m) && !m.content && !m.poll) && (
                      <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap text-soft">{summary(m, channel.serverId)}</p>
                    )}
                    {m.attachments[0]?.contentType.startsWith('image/') && !hidden(m) && (
                      <img src={fileUrl(m.attachments[0].url)} alt="" className="mt-1 max-h-28 rounded-md object-cover" />
                    )}
                    {m.attachments[0]?.contentType.startsWith('video/') && !hidden(m) && <VideoThumb src={fileUrl(m.attachments[0].url)} />}
                  </div>
                  {canPin && (
                    <button
                      title="Desafixar"
                      onClick={(e) => {
                        e.stopPropagation();
                        api
                          .unpinMessage(m.id)
                          .then(() => setItems((cur) => (cur ?? []).filter((x) => x.id !== m.id)))
                          .catch(showError);
                      }}
                      className="self-start rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger max-md:opacity-100"
                    >
                      <Icons.X size={14} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Miniatura do vídeo (primeiro quadro) com botão de play, no estilo do player do chat. */
function VideoThumb({ src }: { src: string }) {
  const [dur, setDur] = useState<number | null>(null);
  const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  return (
    <div className="relative mt-1.5 aspect-video w-full max-w-[280px] overflow-hidden rounded-lg border border-edge bg-black">
      <video
        src={`${src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        className="pointer-events-none h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
      <span className="absolute top-1/2 left-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent/90 text-white shadow-lg transition-transform group-hover:scale-110">
        <Icons.Play size={18} className="ml-0.5 fill-current" />
      </span>
      {dur !== null && (
        <span className="absolute right-1.5 bottom-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">{fmt(dur)}</span>
      )}
    </div>
  );
}
