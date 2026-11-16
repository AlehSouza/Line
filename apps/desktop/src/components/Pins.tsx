'use client';

import { useEffect, useRef, useState } from 'react';
import type { Channel, Message } from '@line/shared';
import { api, fileUrl } from '@/lib/api';
import { jumpToMessage } from '@/lib/session';
import { mentionsToText, useLine } from '@/lib/store';
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

function summary(m: Message, serverId?: string | null) {
  if (m.poll) return `📊 ${m.poll.question}`;
  const text = m.content ? mentionsToText(m.content, serverId) : '';
  if (text) return text;
  const a = m.attachments[0];
  if (!a) return 'Mensagem';
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
                      <span className="truncate text-sm font-semibold">{m.author.displayName}</span>
                      <span className="shrink-0 text-[11px] text-muted">{pinnedUntilLabel(m.pinnedUntil)}</span>
                    </p>
                    <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap text-soft">{summary(m, channel.serverId)}</p>
                    {m.attachments[0]?.contentType.startsWith('image/') && (
                      <img src={fileUrl(m.attachments[0].url)} alt="" className="mt-1 max-h-28 rounded-md object-cover" />
                    )}
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
