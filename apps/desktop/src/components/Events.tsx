'use client';

import type { Channel, RsvpStatus, ServerEvent } from '@line/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type EventInput, type ServerActivity } from '@/lib/api';
import { actions, channelPermsOf, displayNameIn, useLine } from '@/lib/store';
import { joinVoice, useVoice } from '@/lib/voice';
import { hasPerm, Perm } from '@line/shared';
import { confirmDialog, showError } from './Dialogs';
import { EmojiInput, EmojiTextarea } from './EmojiField';
import { MobileBack, MobileMembersButton } from './Mobile';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input, Modal, Select } from './ui';

// ---------- datas ----------

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** "Hoje", "Amanhã", "qua., 19 de nov." */
function dayLabel(d: Date) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Hoje';
  if (sameDay(d, tomorrow)) return 'Amanhã';
  if (sameDay(d, yesterday)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/** "Amanhã às 21:00 – 23:00" */
function whenLabel(e: ServerEvent) {
  const start = new Date(e.startsAt);
  let s = `${dayLabel(start)} às ${hhmm(start)}`;
  if (e.endsAt) {
    const end = new Date(e.endsAt);
    s += sameDay(start, end) ? ` – ${hhmm(end)}` : ` até ${dayLabel(end).toLowerCase()} às ${hhmm(end)}`;
  }
  return s;
}

/** Sem fim definido, o evento "dura" 2 horas para contar como acontecendo agora. */
const endOf = (e: ServerEvent) => (e.endsAt ? new Date(e.endsAt).getTime() : new Date(e.startsAt).getTime() + 2 * 3600_000);
const phase = (e: ServerEvent, now = Date.now()) =>
  now < new Date(e.startsAt).getTime() ? 'next' : now < endOf(e) ? 'live' : 'past';

/** Arquivo .ics para levar o evento ao calendário do aparelho. */
function downloadIcs(e: ServerEvent, where: string) {
  const fmt = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
  const end = e.endsAt ?? new Date(endOf(e)).toISOString();
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Line//Eventos//PT',
    'BEGIN:VEVENT',
    `UID:${e.id}@useline.tech`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(e.startsAt)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(e.title)}`,
    e.description && `DESCRIPTION:${esc(e.description)}`,
    where && `LOCATION:${esc(where)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${e.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'evento'}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- canal ----------

/** Canal base "Eventos": lista de eventos e, ao lado, quem vai no evento escolhido. */
export function EventsChannel({ channel }: { channel: Channel }) {
  const serverId = channel.serverId!;
  const canPost = useLine((s) => hasPerm(channelPermsOf(s, channel.id, s.me?.id), Perm.SendMessages));
  const [events, setEvents] = useState<ServerEvent[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServerEvent | 'new' | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    setSelected(null);
    api.channelEvents(channel.id).then(
      (l) => alive && setEvents(l),
      (e: Error) => alive && setError(e.message),
    );
    const onEvent = (ev: Event) => {
      const d = (ev as CustomEvent<{ event?: ServerEvent; deleted?: string }>).detail;
      setEvents((list) => {
        if (!list) return list;
        if (d.deleted) return list.filter((x) => x.id !== d.deleted);
        if (!d.event || d.event.channelId !== channel.id) return list;
        const rest = list.filter((x) => x.id !== d.event!.id);
        return [...rest, d.event].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      });
    };
    window.addEventListener('line:event', onEvent);
    // "Acontecendo agora" muda com o relógio.
    const clock = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => {
      alive = false;
      window.removeEventListener('line:event', onEvent);
      window.clearInterval(clock);
    };
  }, [channel.id]);

  const groups = useMemo(() => {
    const now = Date.now();
    const list = events ?? [];
    return {
      live: list.filter((e) => phase(e, now) === 'live'),
      next: list.filter((e) => phase(e, now) === 'next'),
      past: list.filter((e) => phase(e, now) === 'past').reverse(),
    };
  }, [events]);
  const current = events?.find((e) => e.id === selected) ?? null;

  const upsert = (e: ServerEvent) =>
    setEvents((list) => [...(list ?? []).filter((x) => x.id !== e.id), e].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));

  const section = (title: string, list: ServerEvent[]) =>
    list.length > 0 && (
      <section>
        <h3 className="mb-2 px-1 text-xs font-bold tracking-wide text-muted uppercase">
          {title} — {list.length}
        </h3>
        <div className="space-y-2">
          {list.map((e) => (
            <EventCard key={e.id} event={e} serverId={serverId} active={e.id === selected} onOpen={() => setSelected(e.id)} onChange={upsert} />
          ))}
        </div>
      </section>
    );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <MobileBack />
        <Icons.CalendarCheck size={20} className="text-muted" />
        <h1 className="truncate font-bold">{channel.name}</h1>
        {channel.topic && (
          <>
            <span className="mx-2 h-6 w-px bg-edge max-md:hidden" />
            <p className="truncate text-sm text-muted max-md:hidden">{channel.topic}</p>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {canPost && (
            <Button className="h-8 px-3" onClick={() => setEditing('new')}>
              <Icons.Plus size={16} />
              <span className="max-sm:hidden">Criar evento</span>
            </Button>
          )}
          <MobileMembersButton />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-4">
          {error && <ErrorText>{error}</ErrorText>}
          {!events && !error && <p className="text-sm text-muted">Carregando eventos…</p>}
          {events && !groups.live.length && !groups.next.length && (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted">
              <Icons.CalendarCheck size={44} />
              <p className="font-semibold text-soft">Nenhum evento marcado.</p>
              <p className="max-w-sm text-sm">
                {canPost ? 'Crie um evento, escolha o canal de voz e o jogo, e o pessoal marca presença aqui.' : 'Quando alguém marcar um evento, ele aparece aqui para você confirmar presença.'}
              </p>
              {canPost && (
                <Button className="mt-2" onClick={() => setEditing('new')}>
                  <Icons.Plus size={16} /> Criar evento
                </Button>
              )}
            </div>
          )}
          {section('Acontecendo agora', groups.live)}
          {section('Próximos', groups.next)}
          {groups.past.length > 0 && (
            <section>
              <button onClick={() => setShowPast((v) => !v)} className="mb-2 flex items-center gap-1 px-1 text-xs font-bold tracking-wide text-muted uppercase hover:text-soft">
                <Icons.Chevron size={12} className={cx('transition-transform', !showPast && '-rotate-90')} />
                Já rolaram — {groups.past.length}
              </button>
              {showPast && (
                <div className="space-y-2 opacity-70">
                  {groups.past.map((e) => (
                    <EventCard key={e.id} event={e} serverId={serverId} active={e.id === selected} onOpen={() => setSelected(e.id)} onChange={upsert} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {current && (
          <>
            <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSelected(null)} />
            <EventPanel
              event={current}
              serverId={serverId}
              onClose={() => setSelected(null)}
              onEdit={() => setEditing(current)}
              onChange={upsert}
              onDeleted={() => {
                setEvents((l) => (l ?? []).filter((x) => x.id !== current.id));
                setSelected(null);
              }}
            />
          </>
        )}
      </div>

      {editing && (
        <EventEditor
          channel={channel}
          event={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(e) => {
            upsert(e);
            setSelected(e.id);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- presença ----------

const RSVP: { status: RsvpStatus; label: string; icon: keyof typeof Icons }[] = [
  { status: 'going', label: 'Vou', icon: 'Check' },
  { status: 'maybe', label: 'Talvez', icon: 'Help' },
  { status: 'no', label: 'Não vou', icon: 'X' },
];

function RsvpButtons({ event, onChange, big }: { event: ServerEvent; onChange: (e: ServerEvent) => void; big?: boolean }) {
  const meId = useLine((s) => s.me?.id);
  const mine = event.rsvps.find((r) => r.userId === meId)?.status ?? null;
  const [busy, setBusy] = useState(false);
  const pick = (status: RsvpStatus) => {
    if (busy) return;
    setBusy(true);
    api
      .rsvpEvent(event.id, mine === status ? null : status)
      .then(onChange, showError)
      .finally(() => setBusy(false));
  };
  return (
    <div className={cx('flex gap-1.5', big && 'w-full')}>
      {RSVP.map((o) => {
        const I = Icons[o.icon];
        const on = mine === o.status;
        return (
          <button
            key={o.status}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              pick(o.status);
            }}
            className={cx(
              'flex items-center justify-center gap-1.5 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-60',
              big ? 'h-10 flex-1' : 'h-8 px-3',
              on
                ? o.status === 'going'
                  ? 'border-online/60 bg-online/15 text-online'
                  : o.status === 'maybe'
                    ? 'border-sun/60 bg-sun/15 text-sun'
                    : 'border-danger/60 bg-danger/15 text-danger'
                : 'border-edge text-soft hover:bg-hover hover:text-fg',
            )}
          >
            <I size={15} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Rodinha de fotos de quem vai. */
function GoingFaces({ event, serverId }: { event: ServerEvent; serverId: string }) {
  const users = useLine((s) => s.users);
  const going = event.rsvps.filter((r) => r.status === 'going' && users[r.userId]);
  const maybe = event.rsvps.filter((r) => r.status === 'maybe').length;
  if (!going.length && !maybe) return <span className="text-xs text-muted">Ninguém confirmou ainda</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex shrink-0 -space-x-2">
        {going.slice(0, 5).map((r) => {
          const u = users[r.userId]!;
          return (
            <span key={r.userId} className="rounded-full ring-2 ring-side" title={displayNameIn(useLine.getState(), serverId, r.userId)}>
              <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={22} />
            </span>
          );
        })}
      </span>
      <span className="truncate text-xs text-muted">
        {going.length > 0 && `${going.length} ${going.length === 1 ? 'vai' : 'vão'}`}
        {going.length > 0 && maybe > 0 && ' · '}
        {maybe > 0 && `${maybe} talvez`}
      </span>
    </span>
  );
}

/** Onde: canal de voz (clicável) e/ou local escrito. */
function useWhere(event: ServerEvent) {
  const voice = useLine((s) => (event.voiceChannelId ? s.channels[event.voiceChannelId] : undefined));
  return { voice, where: [voice?.name, event.location].filter(Boolean).join(' · ') };
}

function EventCard({
  event,
  serverId,
  active,
  onOpen,
  onChange,
}: {
  event: ServerEvent;
  serverId: string;
  active: boolean;
  onOpen: () => void;
  onChange: (e: ServerEvent) => void;
}) {
  const start = new Date(event.startsAt);
  const live = phase(event) === 'live';
  const { voice } = useWhere(event);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={cx(
        'flex cursor-pointer gap-4 rounded-xl border bg-rail/60 p-4 transition-colors hover:bg-hover',
        active ? 'border-accent/70 bg-hover' : 'border-edge',
      )}
    >
      <div className={cx('flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-lg', live ? 'bg-online/15 text-online' : 'bg-accent/15 text-accent')}>
        <span className="text-[11px] font-bold uppercase">{MONTHS[start.getMonth()]!.slice(0, 3)}</span>
        <span className="text-2xl leading-none font-bold">{start.getDate()}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className={cx('flex items-center gap-1.5 text-xs font-semibold', live ? 'text-online' : 'text-muted')}>
          {live && <span className="h-2 w-2 animate-pulse rounded-full bg-online" />}
          {live ? 'Acontecendo agora · ' : ''}
          {whenLabel(event)}
        </p>
        <p className="mt-0.5 truncate text-[17px] font-bold">{event.title}</p>
        {event.description && <p className="line-clamp-2 text-sm text-soft">{event.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {voice && (
            <span className="flex items-center gap-1 rounded-md bg-raise px-2 py-0.5 text-xs text-soft">
              <Icons.Speaker size={13} /> {voice.name}
            </span>
          )}
          {event.game && (
            <span className="flex items-center gap-1 rounded-md bg-raise px-2 py-0.5 text-xs text-soft">
              <Icons.Gamepad size={13} /> {event.game}
            </span>
          )}
          {event.location && (
            <span className="flex max-w-[220px] items-center gap-1 truncate rounded-md bg-raise px-2 py-0.5 text-xs text-soft">
              <Icons.MapPin size={13} /> {event.location}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <GoingFaces event={event} serverId={serverId} />
          {phase(event) !== 'past' && <RsvpButtons event={event} onChange={onChange} />}
        </div>
      </div>
    </div>
  );
}

// ---------- painel lateral ----------

function EventPanel({
  event,
  serverId,
  onClose,
  onEdit,
  onChange,
  onDeleted,
}: {
  event: ServerEvent;
  serverId: string;
  onClose: () => void;
  onEdit: () => void;
  onChange: (e: ServerEvent) => void;
  onDeleted: () => void;
}) {
  const meId = useLine((s) => s.me?.id);
  const users = useLine((s) => s.users);
  const perms = useLine((s) => channelPermsOf(s, event.channelId, s.me?.id));
  const canEdit = (event.creatorId === meId && hasPerm(perms, Perm.SendMessages)) || hasPerm(perms, Perm.ManageMessages);
  const inThisVoice = useVoice((v) => !!event.voiceChannelId && v.channelId === event.voiceChannelId);
  const { voice, where } = useWhere(event);
  const live = phase(event) === 'live';
  const name = (id: string) => displayNameIn(useLine.getState(), serverId, id);
  const creator = users[event.creatorId];
  const byStatus = (s: RsvpStatus) =>
    event.rsvps
      .filter((r) => r.status === s && users[r.userId])
      // Criador primeiro, depois por ordem de resposta.
      .sort((a, b) => Number(b.userId === event.creatorId) - Number(a.userId === event.creatorId) || a.at.localeCompare(b.at));

  const people = (title: string, status: RsvpStatus) => {
    const list = byStatus(status);
    if (!list.length && status !== 'going') return null;
    return (
      <div className="border-t border-edge pt-3">
        <p className="mb-1 flex items-center justify-between px-4 text-sm font-semibold">
          {title}
          <span className="text-xs font-normal text-muted">
            {list.length} {list.length === 1 ? 'pessoa' : 'pessoas'}
          </span>
        </p>
        {!list.length && <p className="px-4 pb-3 text-sm text-muted">Ninguém ainda.</p>}
        {list.map((r) => {
          const u = users[r.userId]!;
          const at = new Date(r.at);
          return (
            <button
              key={r.userId}
              onClick={(e) => actions.openModal({ kind: 'user', userId: r.userId, at: { x: e.clientX, y: e.clientY } })}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-hover"
            >
              <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={36} presence={u.presence} ring="side" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.userId === meId ? 'Você' : name(r.userId)}</span>
                <span className="block text-xs text-muted">
                  {dayLabel(at)} às {hhmm(at)}
                </span>
              </span>
              {r.userId === event.creatorId && (
                <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] font-bold text-accent">Criador do evento</span>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(380px,92vw)] shrink-0 flex-col border-l border-edge bg-side md:static md:z-auto">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4">
        <Icons.CalendarCheck size={18} className="text-muted" />
        <p className="flex-1 truncate text-sm font-bold">Detalhes do evento</p>
        <button title="Fechar" onClick={onClose} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
          <Icons.X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="space-y-4 p-4">
          <div>
            {live && (
              <p className="mb-1 flex items-center gap-1.5 text-xs font-bold text-online uppercase">
                <span className="h-2 w-2 animate-pulse rounded-full bg-online" /> Acontecendo agora
              </p>
            )}
            <h2 className="text-xl font-bold break-words">{event.title}</h2>
            {event.description && <p className="mt-1 text-sm break-words whitespace-pre-wrap text-soft">{event.description}</p>}
            {creator && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                <Avatar name={creator.displayName} color={creator.avatarColor} src={creator.avatarUrl} size={16} />
                Criado por <span className="font-semibold text-soft">{event.creatorId === meId ? 'você' : name(event.creatorId)}</span>
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <Icons.Calendar size={20} className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0">
              <p className="text-sm font-medium">{whenLabel(event)}</p>
              <button onClick={() => downloadIcs(event, where)} className="text-sm font-semibold text-accent hover:underline">
                Adicionar ao calendário
              </button>
            </div>
          </div>
          {voice && (
            <div className="flex gap-3">
              <Icons.Speaker size={20} className="mt-0.5 shrink-0 text-muted" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{voice.name}</p>
                {inThisVoice ? (
                  <p className="text-sm text-online">Você está nesse canal</p>
                ) : (
                  <button
                    onClick={() => {
                      actions.goServer(serverId, voice.id);
                      void joinVoice(voice.id);
                    }}
                    className="text-sm font-semibold text-accent hover:underline"
                  >
                    Entrar no canal de voz
                  </button>
                )}
              </div>
            </div>
          )}
          {event.game && (
            <div className="flex gap-3">
              <Icons.Gamepad size={20} className="mt-0.5 shrink-0 text-muted" />
              <p className="text-sm font-medium">{event.game}</p>
            </div>
          )}
          {event.location && (
            <div className="flex gap-3">
              <Icons.MapPin size={20} className="mt-0.5 shrink-0 text-muted" />
              <p className="text-sm font-medium break-words">{event.location}</p>
            </div>
          )}

          {phase(event) !== 'past' && <RsvpButtons event={event} onChange={onChange} big />}

          {canEdit && (
            <div className="flex gap-2">
              <Button variant="subtle" className="flex-1" onClick={onEdit}>
                <Icons.Edit size={15} /> Editar evento
              </Button>
              <Button
                variant="ghost"
                className="text-danger hover:text-danger"
                onClick={async () => {
                  if (await confirmDialog({ title: `Excluir ${event.title}`, message: 'O evento e as presenças marcadas somem para todo mundo.', confirmLabel: 'Excluir', danger: true })) {
                    api.deleteEvent(event.id).then(onDeleted, showError);
                  }
                }}
              >
                <Icons.Trash size={15} />
              </Button>
            </div>
          )}
        </div>

        {people('Presença confirmada', 'going')}
        {people('Talvez', 'maybe')}
        {people('Não vão', 'no')}
      </div>
    </aside>
  );
}

// ---------- criar / editar ----------

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: pad(h), label: pad(h) }));
const MINUTES = Array.from({ length: 12 }, (_, i) => ({ value: pad(i * 5), label: pad(i * 5) }));

/** Data (dia) + hora e minuto, sem os seletores nativos. */
function DateTimeField({ value, onChange, min }: { value: Date; onChange: (d: Date) => void; min?: Date }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const set = (patch: { y?: number; m?: number; d?: number; h?: number; min?: number }) => {
    const n = new Date(value);
    if (patch.y !== undefined) n.setFullYear(patch.y, patch.m!, patch.d!);
    if (patch.h !== undefined) n.setHours(patch.h);
    if (patch.min !== undefined) n.setMinutes(patch.min);
    onChange(n);
  };
  const first = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = new Date();
  const minDay = min ? new Date(min.getFullYear(), min.getMonth(), min.getDate()) : null;

  return (
    <div className="flex gap-2">
      <div ref={box} className="relative flex-1">
        <button
          type="button"
          onClick={() => {
            setMonth(new Date(value.getFullYear(), value.getMonth(), 1));
            setOpen((o) => !o);
          }}
          className={cx('flex h-[38px] w-full items-center gap-2 rounded-lg border bg-rail px-3 text-left text-sm', open ? 'border-accent' : 'border-edge')}
        >
          <span className="flex-1 truncate">
            {value.getDate()} de {MONTHS[value.getMonth()]} de {value.getFullYear()}
          </span>
          <Icons.Calendar size={16} className="text-muted" />
        </button>
        {open && (
          <div className="absolute top-full left-0 z-[90] mt-1 w-72 rounded-xl border border-edge bg-side p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                <Icons.Chevron size={16} className="rotate-90" />
              </button>
              <span className="text-sm font-semibold capitalize">
                {MONTHS[month.getMonth()]} de {month.getFullYear()}
              </span>
              <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                <Icons.Chevron size={16} className="-rotate-90" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] font-bold text-muted">
              {['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d, i) => (
                <span key={i} className="py-1">
                  {d}
                </span>
              ))}
              {Array.from({ length: first }, (_, i) => (
                <span key={`v${i}`} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const day = new Date(month.getFullYear(), month.getMonth(), i + 1);
                const disabled = !!minDay && day < minDay;
                const picked = sameDay(day, value);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      set({ y: day.getFullYear(), m: day.getMonth(), d: day.getDate() });
                      setOpen(false);
                    }}
                    className={cx(
                      'h-8 rounded-md text-sm font-medium disabled:opacity-25',
                      picked ? 'bg-accent text-on-accent' : 'text-fg enabled:hover:bg-hover',
                      !picked && sameDay(day, today) && 'text-accent',
                    )}
                  >
                    {i + 1}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Select className="w-[72px]" value={pad(value.getHours())} onChange={(v) => set({ h: Number(v) })} options={HOURS} />
        <span className="text-muted">:</span>
        <Select
          className="w-[72px]"
          value={pad(value.getMinutes() - (value.getMinutes() % 5))}
          onChange={(v) => set({ min: Number(v) })}
          options={MINUTES}
        />
      </div>
    </div>
  );
}

/** Próxima hora cheia (para começar o formulário). */
function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function EventEditor({
  channel,
  event,
  onClose,
  onSaved,
}: {
  channel: Channel;
  event: ServerEvent | null;
  onClose: () => void;
  onSaved: (e: ServerEvent) => void;
}) {
  const serverId = channel.serverId!;
  const allChannels = useLine((s) => s.channels);
  const voiceOptions = useMemo(
    () => [
      { value: '', label: 'Nenhum canal de voz' },
      ...Object.values(allChannels)
        .filter((c) => c.serverId === serverId && c.type === 'voice')
        .sort((a, b) => a.position - b.position)
        .map((c) => ({ value: c.id, label: c.name })),
    ],
    [allChannels, serverId],
  );
  const [title, setTitle] = useState(event?.title ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [start, setStart] = useState(() => (event ? new Date(event.startsAt) : nextHour()));
  const [end, setEnd] = useState<Date | null>(() => (event?.endsAt ? new Date(event.endsAt) : null));
  const [voiceId, setVoiceId] = useState(event?.voiceChannelId ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [game, setGame] = useState(event?.game ?? '');
  const [games, setGames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Sugestões de jogo: o que o pessoal do servidor anda jogando.
  useEffect(() => {
    api.serverActivities(serverId).then(
      (l: ServerActivity[]) => setGames([...new Set(l.map((a) => a.name))].slice(0, 8)),
      () => {},
    );
  }, [serverId]);

  const save = async () => {
    if (!title.trim()) return setError('Dê um nome para o evento.');
    if (end && end <= start) return setError('O fim precisa ser depois do início.');
    setBusy(true);
    setError('');
    const body: EventInput = {
      title: title.trim(),
      description: description.trim(),
      startsAt: start.toISOString(),
      endsAt: end ? end.toISOString() : null,
      location: location.trim(),
      voiceChannelId: voiceId || null,
      game: game.trim(),
    };
    try {
      onSaved(event ? await api.updateEvent(event.id, body) : await api.createEvent(channel.id, body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={event ? 'Editar evento' : 'Criar evento'}
      subtitle="Quem vê o canal Eventos pode marcar presença."
      onClose={onClose}
      width={540}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || !title.trim()} onClick={save}>
            {busy ? 'Salvando…' : event ? 'Salvar' : 'Criar evento'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome do evento">
          <EmojiInput autoFocus value={title} maxLength={100} placeholder="Ex.: Noite de Valorant" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Descrição (opcional)">
          <EmojiTextarea
            value={description}
            maxLength={1000}
            rows={3}
            placeholder="O que vai rolar, regras, premiação…"
            onChange={(e) => setDescription(e.target.value)}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
          />
        </Field>
        <Field label="Data e hora de início" group>
          <DateTimeField
            value={start}
            min={event ? undefined : new Date()}
            onChange={(d) => {
              // Mudar o início leva o fim junto, mantendo a duração.
              if (end) setEnd(new Date(end.getTime() + (d.getTime() - start.getTime())));
              setStart(d);
            }}
          />
        </Field>
        {end ? (
          <Field label="Data e hora de término" group>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <DateTimeField value={end} min={start} onChange={setEnd} />
              </div>
              <button type="button" title="Tirar o término" onClick={() => setEnd(null)} className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg">
                <Icons.X size={16} />
              </button>
            </div>
          </Field>
        ) : (
          <button
            type="button"
            onClick={() => setEnd(new Date(start.getTime() + 2 * 3600_000))}
            className="flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
          >
            <Icons.Plus size={16} /> Adicionar hora de término
          </button>
        )}
        <Field label="Canal de voz" hint="Onde o pessoal se encontra. Dá para entrar direto pelo evento." group>
          <Select value={voiceId} onChange={setVoiceId} options={voiceOptions} />
        </Field>
        <Field label="Jogo (opcional)" group>
          <div className="relative">
            <Icons.Gamepad size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <Input value={game} maxLength={80} placeholder="Ex.: VALORANT" onChange={(e) => setGame(e.target.value)} className="pl-9" />
          </div>
          {games.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {games.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setGame(g)}
                  className={cx('rounded-md border px-2 py-0.5 text-xs', game === g ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-hover')}
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Local (opcional)">
          <div className="relative">
            <Icons.MapPin size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <Input value={location} maxLength={200} placeholder="Ex.: Lan house do Zé, link da live…" onChange={(e) => setLocation(e.target.value)} className="pl-9" />
          </div>
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
