'use client';

import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import * as L from 'lucide-react';
import { api, type PatchNoteSocial } from '@/lib/api';
import { PATCH_NOTES, type PatchIcon, type PatchNote, type PatchTopic } from '@/lib/patchNotes';
import { watchNews } from '@/lib/session';
import { actions, setNewsAdmin, useLine } from '@/lib/store';
import { ChatView } from './ChatView';
import { showError } from './Dialogs';
import { EMOJI_FONT, EmojiPicker } from './EmojiPicker';
import { MobileBack } from './Mobile';
import { cx } from './ui';

const ICONS: Record<PatchIcon, LucideIcon> = {
  mic: L.Mic,
  headphones: L.Headphones,
  mouse: L.MousePointerClick,
  eye: L.Eye,
  pause: L.CirclePause,
  image: L.Image,
  volume: L.Volume2,
  window: L.AppWindow,
  zap: L.Zap,
  clock: L.Clock,
  monitor: L.MonitorPlay,
  refresh: L.RefreshCw,
  sparkles: L.Sparkles,
  message: L.MessageCircle,
  shield: L.ShieldCheck,
  wrench: L.Wrench,
};

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}`;
}

/** Emojis que aparecem sempre embaixo da nota, mesmo sem ninguém ter reagido. */
const QUICK = ['🔥', '❤️', '👏', '🎉', '😮', '😂'];

/** Página "Novidades": banner, faixa da última versão e as notas, da mais nova para a mais antiga. */
export function PatchNotesView() {
  const latest = PATCH_NOTES[0];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex h-12 items-center px-4 md:hidden">
        <MobileBack />
      </div>

      {/* Banner */}
      <div className="relative overflow-hidden bg-gradient-to-br from-accent/45 via-accent/10 to-main px-10 pt-14 pb-12 max-md:px-4 max-md:pt-6 max-md:pb-8">
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-full bg-accent/30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-1/3 size-72 rounded-full bg-sun/15 blur-3xl" />
        <L.ScrollText aria-hidden strokeWidth={1.2} className="pointer-events-none absolute top-6 right-10 size-44 rotate-12 text-fg/10 max-md:hidden" />
        <div className="relative mx-auto max-w-4xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-fg/10 px-3 py-1 text-xs font-bold tracking-wide text-fg uppercase backdrop-blur">
            <L.Sparkles size={14} /> Atualizações do Line
          </span>
          <h1 className="mt-4 text-5xl font-extrabold tracking-tight text-fg max-md:text-3xl">Novidades</h1>
          <p className="mt-3 max-w-2xl text-lg text-soft max-md:text-base">
            Tudo o que mudou no Line, contado para você. Leia, reaja e diga o que achou de cada novidade.
          </p>
        </div>
      </div>

      {/* Faixa da última atualização */}
      {latest && (
        <a
          href={`#nota-${latest.id}`}
          className="flex items-center gap-3 border-y border-accent/30 bg-accent/15 px-10 py-3 text-sm text-fg hover:bg-accent/20 max-md:px-4"
        >
          <span className="mx-auto flex w-full max-w-4xl items-center gap-3">
            <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-xs font-extrabold tracking-wide text-on-accent uppercase">Novo</span>
            <span className="min-w-0 flex-1 truncate">
              <strong className="font-bold">{latest.title}</strong>
              <span className="text-soft"> · {formatDate(latest.id)}</span>
            </span>
            <L.ArrowDown size={16} className="shrink-0 text-soft" />
          </span>
        </a>
      )}

      <div className="mx-auto max-w-4xl px-10 py-12 max-md:px-4 max-md:py-8">
        {PATCH_NOTES.map((note, i) => (
          <Note key={note.id} note={note} latest={i === 0} last={i === PATCH_NOTES.length - 1} />
        ))}
      </div>
    </div>
  );
}

function Note({ note, latest, last }: { note: PatchNote; latest: boolean; last: boolean }) {
  return (
    <article id={`nota-${note.id}`} className={cx('scroll-mt-4', !last && 'mb-16 border-b border-edge pb-16')}>
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted">
        <L.CalendarDays size={16} />
        <span>{formatDate(note.id)}</span>
        {latest && <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-xs font-bold text-accent">Mais recente</span>}
      </div>
      <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-fg max-md:text-2xl">{note.title}</h2>
      <p className="mt-3 text-lg leading-relaxed text-soft max-md:text-base">{note.intro}</p>

      <SectionTitle icon={L.Star} title="Destaques" />
      <div className="grid gap-4 md:grid-cols-3">
        {note.highlights.map((t) => (
          <Highlight key={t.title} topic={t} />
        ))}
      </div>

      {!!note.improvements?.length && (
        <>
          <SectionTitle icon={L.TrendingUp} title="Melhorias" />
          <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
            {note.improvements.map((t) => (
              <Topic key={t.title} topic={t} />
            ))}
          </div>
        </>
      )}

      {!!note.fixes?.length && (
        <>
          <SectionTitle icon={L.Wrench} title="Correções" />
          <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
            {note.fixes.map((t) => (
              <Topic key={t.title} topic={t} tone="fix" />
            ))}
          </div>
        </>
      )}

      <Social noteId={note.id} />
    </article>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <h3 className="mt-10 mb-5 flex items-center gap-2 text-xl font-bold text-fg">
      <Icon size={20} className="text-accent" /> {title}
    </h3>
  );
}

function Highlight({ topic }: { topic: PatchTopic }) {
  const Icon = ICONS[topic.icon];
  return (
    <div className="rounded-2xl bg-gradient-to-br from-accent/20 to-raise/40 p-5">
      <span className="flex size-12 items-center justify-center rounded-xl bg-accent text-on-accent shadow-lg shadow-accent/30">
        <Icon size={24} />
      </span>
      <h4 className="mt-4 text-lg font-bold text-fg">{topic.title}</h4>
      <p className="mt-1.5 text-[15px] leading-relaxed text-soft">{topic.text}</p>
    </div>
  );
}

function Topic({ topic, tone }: { topic: PatchTopic; tone?: 'fix' }) {
  const Icon = ICONS[topic.icon];
  return (
    <div className="flex gap-4">
      <span
        className={cx(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          tone === 'fix' ? 'bg-online/15 text-online' : 'bg-accent/15 text-accent',
        )}
      >
        <Icon size={20} />
      </span>
      <div className="min-w-0">
        <h4 className="text-base font-bold text-fg">{topic.title}</h4>
        <p className="mt-1 text-[15px] leading-relaxed text-soft">{topic.text}</p>
      </div>
    </div>
  );
}

/** Reações e comentários no fim de cada nota. Os comentários são um chat igual ao dos servidores. */
function Social({ noteId }: { noteId: string }) {
  const me = useLine((s) => s.me);
  const [data, setData] = useState<PatchNoteSocial | null>(null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const channelId = data?.channel?.id;
  const channel = useLine((s) => (channelId ? s.channels[channelId] : undefined));

  useEffect(() => {
    let alive = true;
    api
      .patchNote(noteId)
      .then((d) => {
        if (!alive) return;
        setNewsAdmin(!!d.admin);
        if (d.channel) actions.upsertChannel(d.channel);
        setData(d);
      })
      .catch(() => alive && setData({ noteId, reactions: [], comments: [] }));
    return () => {
      alive = false;
    };
  }, [noteId]);

  // Tempo real e conversas já criadas no canal de comentários.
  useEffect(() => {
    if (!channelId) return;
    watchNews(channelId, true);
    api
      .threads(channelId)
      .then((list) => list.forEach((t) => actions.upsertChannel(t)))
      .catch(() => {});
    return () => watchNews(channelId, false);
  }, [channelId]);

  const reactions = data?.reactions ?? [];
  const shown = [...QUICK.map((e) => reactions.find((r) => r.emoji === e) ?? { emoji: e, userIds: [] }), ...reactions.filter((r) => !QUICK.includes(r.emoji))];

  const toggle = (emoji: string) => {
    if (!me) return;
    const mine = !!reactions.find((r) => r.emoji === emoji)?.userIds.includes(me.id);
    // Mostra na hora; a resposta do servidor confirma.
    setData((d) => {
      if (!d) return d;
      const list = d.reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: mine ? r.userIds.filter((u) => u !== me.id) : [...r.userIds, me.id] } : r));
      if (!mine && !list.some((r) => r.emoji === emoji)) list.push({ emoji, userIds: [me.id] });
      return { ...d, reactions: list.filter((r) => r.userIds.length) };
    });
    api.patchNoteReact(noteId, emoji, !mine).then((d) => setData((cur) => ({ ...d, channel: cur?.channel ?? d.channel }))).catch(showError);
  };

  return (
    <section className="mt-12">
      <div className="rounded-2xl bg-raise/40 p-6 max-md:p-4">
        <h3 className="text-lg font-bold text-fg">O que você achou?</h3>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {shown.map((r) => {
            const mine = !!me && r.userIds.includes(me.id);
            return (
              <button
                key={r.emoji}
                onClick={() => toggle(r.emoji)}
                aria-pressed={mine}
                className={cx(
                  'flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-bold transition-transform hover:-translate-y-0.5',
                  mine ? 'border-accent bg-accent/20 text-fg' : 'border-edge bg-main/60 text-soft hover:border-accent/50',
                )}
              >
                <span className="text-xl leading-none" style={{ fontFamily: EMOJI_FONT }}>
                  {r.emoji}
                </span>
                {r.userIds.length > 0 && <span className={cx('tabular-nums', mine && 'text-accent')}>{r.userIds.length}</span>}
              </button>
            );
          })}
          <button
            title="Outro emoji"
            onClick={(e) => setPicker(picker ? null : e.currentTarget)}
            className="flex h-10 items-center rounded-xl border border-dashed border-edge px-3 text-muted hover:border-accent/50 hover:text-fg"
          >
            <L.SmilePlus size={20} />
          </button>
          {picker && (
            <EmojiPicker
              anchor={picker}
              onPick={(emoji, keepOpen) => {
                if (!reactions.find((r) => r.emoji === emoji)?.userIds.includes(me?.id ?? '')) toggle(emoji);
                if (!keepOpen) setPicker(null);
              }}
              onClose={() => setPicker(null)}
            />
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-col overflow-hidden rounded-2xl border border-edge bg-main">
        {channel ? <ChatView channel={channel} /> : <p className="m-auto text-sm text-muted">{data ? 'Os comentários não carregaram. Tente de novo mais tarde.' : 'Carregando comentários…'}</p>}
      </div>
    </section>
  );
}
