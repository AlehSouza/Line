'use client';

import type { Channel, Message } from '@line/shared';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { loadMessages, sendTyping } from '@/lib/session';
import { actions, dmTitle, useLine } from '@/lib/store';
import { joinVoice, toggleCamera, useVoice } from '@/lib/voice';
import { Avatar, cx, Icons } from './ui';
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

  useEffect(() => {
    actions.markRead(channel.id);
    const onFocus = () => actions.markRead(channel.id);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [channel.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        {isDm ? (
          other ? (
            <Avatar name={title} color={(users[other.id] ?? other).avatarColor} size={24} presence={(users[other.id] ?? other).presence} ring="main" />
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
      <Composer channel={channel} placeholder={isDm ? `Conversar com ${title}` : `Conversar em #${channel.name}`} />
    </div>
  );
}

function MessageList({ channel, title }: { channel: Channel; title: string }) {
  const bucket = useLine((s) => s.messages[channel.id]);
  const meId = useLine((s) => s.me?.id);
  const myUsername = useLine((s) => s.me?.username);
  const users = useLine((s) => s.users);
  const isOwner = useLine((s) => (channel.serverId ? s.servers[channel.serverId]?.ownerId === meId : false));
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const loadingOlder = useRef(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const items = bucket?.items ?? EMPTY;

  useEffect(() => {
    stickToBottom.current = true;
    setError('');
    loadMessages(channel.id).catch((e) => setError(e.message));
  }, [channel.id]);

  // Mantém a rolagem no fim quando chegam mensagens novas, e a posição quando carregamos antigas.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  async function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && bucket?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      await loadMessages(channel.id, true).catch(() => (loadingOlder.current = false));
    }
  }

  return (
    <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col justify-end pb-4">
        {bucket && !bucket.hasMore && (
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
        {!bucket && !error && <p className="px-4 py-6 text-sm text-muted">Carregando mensagens…</p>}
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
              />
            </Fragment>
          );
        })}
      </div>
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
}: {
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
}) {
  const [draft, setDraft] = useState(message.content);
  const mentionsMe = !!myUsername && message.content.toLowerCase().includes(`@${myUsername}`);

  async function saveEdit() {
    const content = draft.trim();
    if (!content || content === message.content) return onDoneEditing();
    try {
      await api.editMessage(message.id, content);
      onDoneEditing();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div
      className={cx(
        'group relative flex gap-4 px-4 py-0.5 hover:bg-black/10',
        !grouped && 'mt-4',
        mentionsMe && 'border-l-2 border-sun bg-sun/5 hover:bg-sun/10',
      )}
    >
      <div className="w-10 shrink-0">
        {grouped ? (
          <span className="invisible block pt-1 text-right text-[10px] text-muted group-hover:visible">
            {new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <button onClick={() => actions.openModal({ kind: 'user', userId: message.author.id })}>
            <Avatar name={authorName} color={authorColor} size={40} />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <button
              onClick={() => actions.openModal({ kind: 'user', userId: message.author.id })}
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
          <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-soft">
            {renderMarkdown(message.content, myUsername)}
            {message.editedAt && <span className="ml-1 text-[10px] text-muted">(editado)</span>}
          </div>
        )}
      </div>

      {!editing && (mine || canDelete) && (
        <div className="absolute -top-3 right-4 hidden rounded-lg border border-edge bg-side shadow group-hover:flex">
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

function Composer({ channel, placeholder }: { channel: Channel; placeholder: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const typing = useLine((s) => s.typing[channel.id]);
  const meId = useLine((s) => s.me?.id);
  const typers = Object.entries(typing ?? {})
    .filter(([id, t]) => id !== meId && t.until > Date.now())
    .map(([, t]) => t.name);

  useEffect(() => {
    setText('');
    ref.current?.focus();
  }, [channel.id]);

  async function send() {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const message = await api.sendMessage(channel.id, content);
      actions.addMessage(message);
      setText('');
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
      <div className="flex items-end rounded-xl bg-raise px-4 py-2.5">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) sendTyping(channel.id);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          maxLength={4000}
          className="max-h-60 min-h-6 flex-1 resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-muted"
          style={{ height: `${Math.min(240, 24 * Math.max(1, text.split('\n').length))}px` }}
        />
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

function TypingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-soft" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}
