'use client';

import { formatMessageTime } from '../lib/msgtime';
import type { Channel, Message, NotifyLevel } from '@line/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { api, fileUrl } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import {
  channelNotify,
  infoOf,
  isChannelMuted,
  isMutedAnywhere,
  isServerMuted,
  LEVEL_LABEL,
  markServerRead,
  mentionCount,
  MUTE_OPTIONS,
  muteChannel,
  muteLabel,
  muteServer,
  playMessageSound,
  pref,
  serverNotify,
  setChannelNotify,
  setServerNotify,
  showsUnread,
  totalMentions,
  unmuteChannel,
  unmuteServer,
  updateNotify,
  DEFAULT_SERVER_LEVEL,
} from '@/lib/notify';
import { ensureServerLoaded, jumpToMessage } from '@/lib/session';
import { actions, dmTitle, useLine, type LineState } from '@/lib/store';
import { closeContextMenu, type MenuEntry } from './ContextMenu';
import { Avatar, Button, cx, DefaultServerIcon, Icons, MessageSkeletons, Modal, Select } from './ui';

const LEVELS: NotifyLevel[] = ['all', 'mentions', 'nothing'];

// ---------- peças pequenas ----------

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-raise')}
    >
      <span className={cx('absolute top-1 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-6' : 'left-1')} />
    </button>
  );
}

export function SwitchRow({ title, hint, on, onChange }: { title: string; hint?: ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-6 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
      </div>
      <Switch on={on} onChange={onChange} label={title} />
    </div>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span className={cx('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2', on ? 'border-accent' : 'border-soft/60')}>
      {on && <span className="h-2 w-2 rounded-full bg-accent" />}
    </span>
  );
}

const subItem = 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left font-medium text-soft hover:bg-hover hover:text-fg';

function MuteSubmenu({ onPick }: { onPick: (minutes: number | null) => void }) {
  return (
    <>
      {MUTE_OPTIONS.map((o) => (
        <button
          key={o.label}
          className={subItem}
          onClick={() => {
            closeContextMenu();
            onPick(o.minutes);
          }}
        >
          {o.label}
        </button>
      ))}
    </>
  );
}

/** Submenu "Configurações de notificação" de um canal: padrão ou nível próprio. */
function ChannelLevelSubmenu({ channelId }: { channelId: string }) {
  const own = useLine((s) => channelNotify(s, channelId).level);
  const inherited = useLine((s) => {
    const { serverId, parentId } = infoOf(s, channelId);
    const parent = parentId ? channelNotify(s, parentId).level : undefined;
    return parent ?? (serverId ? (serverNotify(s, serverId).level ?? DEFAULT_SERVER_LEVEL) : 'all');
  });
  const pick = (level?: NotifyLevel) => setChannelNotify(channelId, { level });
  return (
    <>
      <button className={subItem} onClick={() => pick(undefined)}>
        <span className="min-w-0 flex-1">
          <span className="block">Usar padrão</span>
          <span className="block text-xs font-normal text-muted">{LEVEL_LABEL[inherited]}</span>
        </span>
        <Radio on={!own} />
      </button>
      {LEVELS.map((l) => (
        <button key={l} className={subItem} onClick={() => pick(l)}>
          <span className="flex-1">{LEVEL_LABEL[l]}</span>
          <Radio on={own === l} />
        </button>
      ))}
    </>
  );
}

/** Submenu "Configurações de notificação" do servidor (igual ao clique direito do Discord). */
function ServerLevelSubmenu({ serverId }: { serverId: string }) {
  const sn = useLine((s) => serverNotify(s, serverId));
  const level = sn.level ?? DEFAULT_SERVER_LEVEL;
  const check = (on: boolean) => (
    <span className={cx('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border', on ? 'border-accent bg-accent text-on-accent' : 'border-soft/60')}>
      {on && <Icons.Check size={13} />}
    </span>
  );
  return (
    <>
      {LEVELS.map((l) => (
        <button key={l} className={subItem} onClick={() => setServerNotify(serverId, { level: l })}>
          <span className="flex-1">{LEVEL_LABEL[l]}</span>
          <Radio on={level === l} />
        </button>
      ))}
      <div className="mx-1.5 my-1 border-t border-edge" />
      <button className={subItem} onClick={() => setServerNotify(serverId, { suppressEveryone: !sn.suppressEveryone })}>
        <span className="flex-1">Suprimir @everyone e @here</span>
        {check(!!sn.suppressEveryone)}
      </button>
      <button className={subItem} onClick={() => setServerNotify(serverId, { suppressRoles: !sn.suppressRoles })}>
        <span className="flex-1">Suprimir menções de cargo</span>
        {check(!!sn.suppressRoles)}
      </button>
      <div className="mx-1.5 my-1 border-t border-edge" />
      <button
        className={subItem}
        onClick={() => {
          closeContextMenu();
          actions.openModal({ kind: 'notify-settings', serverId });
        }}
      >
        Mais opções…
      </button>
    </>
  );
}

// ---------- itens prontos para os menus de clique direito ----------

export function serverNotifyItems(serverId: string): MenuEntry[] {
  const s = useLine.getState();
  const muted = isServerMuted(s, serverId);
  return [
    muted
      ? { label: 'Reativar servidor', icon: <Icons.Bell size={15} />, onClick: () => unmuteServer(serverId) }
      : { label: 'Silenciar servidor', onClick: () => {}, submenu: () => <MuteSubmenu onPick={(m) => muteServer(serverId, m)} /> },
    { label: 'Configurações de notificação', onClick: () => {}, submenu: () => <ServerLevelSubmenu serverId={serverId} /> },
  ];
}

export function channelNotifyItems(channelId: string): MenuEntry[] {
  const s = useLine.getState();
  const muted = isChannelMuted(s, channelId) && channelNotify(s, channelId).muted;
  const isThread = s.channels[channelId]?.type === 'thread';
  const noun = isThread ? 'conversa' : 'canal';
  return [
    muted
      ? { label: `Reativar ${noun}`, icon: <Icons.Bell size={15} />, onClick: () => unmuteChannel(channelId) }
      : { label: `Silenciar ${noun}`, onClick: () => {}, submenu: () => <MuteSubmenu onPick={(m) => muteChannel(channelId, m)} /> },
    { label: 'Configurações de notificação', onClick: () => {}, submenu: () => <ChannelLevelSubmenu channelId={channelId} /> },
  ];
}

export function dmNotifyItems(channelId: string): MenuEntry[] {
  const s = useLine.getState();
  return [
    {
      label: 'Marcar como lida',
      icon: <Icons.Check size={15} />,
      disabled: !s.unread[channelId] && !s.mentionCounts[channelId],
      onClick: () => actions.markRead(channelId),
    },
    isChannelMuted(s, channelId)
      ? { label: 'Reativar conversa', icon: <Icons.Bell size={15} />, onClick: () => unmuteChannel(channelId) }
      : { label: 'Silenciar conversa', onClick: () => {}, submenu: () => <MuteSubmenu onPick={(m) => muteChannel(channelId, m)} /> },
  ];
}

/** Sino cortado ao lado do nome do canal/servidor silenciado. */
export function MutedIcon({ className }: { className?: string }) {
  return <Icons.BellOff size={13} className={cx('shrink-0 text-muted', className)} />;
}

/** Badge vermelho de menções (igual ao do ícone do servidor). */
export function MentionBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <span className={cx('min-w-[18px] rounded-full bg-danger px-1.5 text-center text-[11px] leading-[18px] font-bold text-white', className)}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ---------- modal "Configurações de notificação" do servidor ----------

export function ServerNotifyModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const sn = useLine((s) => serverNotify(s, serverId));
  const overrides = useLine((s) => s.notify.channels);
  const allChannels = useLine((s) => s.channels);
  const [muteFor, setMuteFor] = useState<string>('null');

  useEffect(() => {
    void ensureServerLoaded(serverId).catch(() => {});
  }, [serverId]);

  const channels = useMemo(
    () =>
      Object.values(allChannels)
        .filter((c) => c.serverId === serverId && c.type !== 'thread' && c.type !== 'voice')
        .sort((a, b) => a.position - b.position),
    [allChannels, serverId],
  );
  const overridden = channels.filter((c) => overrides?.[c.id]);
  const free = channels.filter((c) => !overrides?.[c.id]);
  const muted = isServerMuted(useLine.getState(), serverId);
  const level = sn.level ?? DEFAULT_SERVER_LEVEL;

  if (!server) return null;
  return (
    <Modal title="Configurações de notificação" subtitle={server.name} onClose={onClose} width={560} footer={<Button onClick={onClose}>Pronto</Button>}>
      <div className="space-y-5">
        <div className="rounded-xl border border-edge bg-rail/50 px-4">
          <SwitchRow
            title={`Silenciar ${server.name}`}
            hint={muted ? muteLabel(sn) : 'Sem bolinhas de não lido e sem notificações, a não ser quando você for mencionado.'}
            on={muted}
            onChange={(on) => (on ? muteServer(serverId, muteFor === 'null' ? null : Number(muteFor)) : unmuteServer(serverId))}
          />
          {!muted && (
            <div className="flex items-center gap-3 pb-3 text-sm text-muted">
              <span>Duração ao silenciar:</span>
              <Select
                value={muteFor}
                onChange={setMuteFor}
                options={MUTE_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label }))}
                className="w-48"
              />
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Notificações do servidor</p>
          <div className="space-y-1">
            {LEVELS.map((l) => (
              <button
                key={l}
                onClick={() => setServerNotify(serverId, { level: l })}
                className={cx('flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left', level === l ? 'border-accent/60 bg-accent/10' : 'border-edge hover:bg-hover')}
              >
                <Radio on={level === l} />
                <span className="font-medium">{LEVEL_LABEL[l]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="divide-y divide-edge rounded-xl border border-edge bg-rail/50 px-4">
          <SwitchRow
            title="Suprimir @everyone e @here"
            hint="Essas menções não contam como menção para você."
            on={!!sn.suppressEveryone}
            onChange={(v) => setServerNotify(serverId, { suppressEveryone: v })}
          />
          <SwitchRow
            title="Suprimir todas as menções de cargo"
            hint="Menções aos seus cargos não notificam."
            on={!!sn.suppressRoles}
            onChange={(v) => setServerNotify(serverId, { suppressRoles: v })}
          />
          <SwitchRow
            title="Ocultar canais silenciados"
            hint="Canais silenciados somem da lista (o aberto continua aparecendo)."
            on={!!sn.hideMuted}
            onChange={(v) => setServerNotify(serverId, { hideMuted: v })}
          />
        </div>

        <div>
          <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">Ajustes por canal</p>
          {free.length > 0 && (
            <Select
              value=""
              onChange={(id) => id && setChannelNotify(id, { level })}
              options={[{ value: '', label: 'Adicionar um canal…' }, ...free.map((c) => ({ value: c.id, label: `# ${c.name}` }))]}
            />
          )}
          {overridden.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nenhum canal com ajuste próprio. Os canais seguem o nível do servidor.</p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {overridden.map((c) => (
                <ChannelOverrideRow key={c.id} channel={c} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ChannelOverrideRow({ channel }: { channel: Channel }) {
  const cn = useLine((s) => channelNotify(s, channel.id));
  const muted = isChannelMuted(useLine.getState(), channel.id);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail/50 px-3 py-2">
      <Icons.Hash size={16} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate font-medium">{channel.name}</span>
      <Select
        value={cn.level ?? ''}
        onChange={(v) => setChannelNotify(channel.id, { level: (v || undefined) as NotifyLevel | undefined })}
        options={[{ value: '', label: 'Padrão do servidor' }, ...LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))]}
        className="w-44"
      />
      <button
        title={muted ? 'Reativar canal' : 'Silenciar canal'}
        onClick={() => (muted ? unmuteChannel(channel.id) : muteChannel(channel.id, null))}
        className={cx('rounded-md p-1.5 hover:bg-hover', muted ? 'text-danger' : 'text-muted hover:text-fg')}
      >
        {muted ? <Icons.BellOff size={16} /> : <Icons.Bell size={16} />}
      </button>
      <button
        title="Remover ajuste"
        onClick={() =>
          updateNotify((n) => {
            const channels = { ...n.channels };
            delete channels[channel.id];
            return { ...n, channels };
          })
        }
        className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
      >
        <Icons.X size={16} />
      </button>
    </div>
  );
}

// ---------- Configurações do usuário → Notificações ----------

export function NotificationsSection() {
  const n = useLine((s) => s.notify);
  const dnd = useLine((s) => s.me?.status === 'dnd');
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]!).filter(Boolean)));
  const [perm, setPerm] = useState<NotificationPermission | 'none'>(() => (typeof Notification === 'undefined' ? 'none' : Notification.permission));
  const set = (k: 'desktop' | 'sounds' | 'badge' | 'flash' | 'preview' | 'avatar' | 'quickReply', v: boolean) => updateNotify((x) => ({ ...x, [k]: v }));
  const desktopApp = typeof window !== 'undefined' && !!window.line?.isDesktop;
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="mb-1 text-xl font-bold">Notificações</h2>
        {dnd && (
          <p className="mt-2 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            <Icons.BellOff size={16} className="shrink-0 text-danger" />
            Você está em Não perturbar: nenhum som nem notificação na área de trabalho até mudar o status.
          </p>
        )}
        <div className="divide-y divide-edge">
          <SwitchRow
            title="Ativar notificações na área de trabalho"
            hint={
              perm === 'denied'
                ? 'O sistema bloqueou as notificações do Line. Libere nas configurações do navegador/sistema.'
                : 'Mensagens diretas e o que você escolher em cada servidor aparecem como notificação quando o Line não está em foco.'
            }
            on={pref(n, 'desktop')}
            onChange={(v) => {
              set('desktop', v);
              if (v && perm === 'default') void Notification.requestPermission().then(setPerm);
            }}
          />
          <SwitchRow title="Mostrar o conteúdo da mensagem" hint="Desligado, a notificação só diz quem mandou." on={pref(n, 'preview')} onChange={(v) => set('preview', v)} />
          {desktopApp && window.line?.platform === 'win32' && (
            <>
              <SwitchRow title="Mostrar a foto de quem mandou" hint="A foto aparece redonda ao lado do nome, na notificação do Windows." on={pref(n, 'avatar')} onChange={(v) => set('avatar', v)} />
              <SwitchRow
                title="Resposta rápida"
                hint='Mostra a caixa "Digite uma resposta" e o botão Enviar na notificação, para responder sem abrir o Line.'
                on={pref(n, 'quickReply')}
                onChange={(v) => set('quickReply', v)}
              />
            </>
          )}
          <SwitchRow
            title="Sons de notificação"
            hint={
              <>
                Toca um som quando chega algo que notifica.{' '}
                <button className="text-accent hover:underline" onClick={() => playMessageSound()}>
                  Ouvir
                </button>
              </>
            }
            on={pref(n, 'sounds')}
            onChange={(v) => set('sounds', v)}
          />
          {desktopApp && (
            <SwitchRow title="Mostrar badge de não lidas" hint="Número vermelho no ícone do Line com menções e mensagens diretas." on={pref(n, 'badge')} onChange={(v) => set('badge', v)} />
          )}
          {desktopApp && (
            <SwitchRow title="Piscar a barra de tarefas" hint="Chama atenção quando chega uma notificação." on={pref(n, 'flash')} onChange={(v) => set('flash', v)} />
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-xl font-bold">Servidores</h2>
        <p className="mb-3 text-sm text-muted">Como cada servidor te avisa. Também dá para mudar com o botão direito no ícone do servidor.</p>
        <div className="space-y-1.5">
          {servers.map((srv) => {
            const sn = n.servers?.[srv.id];
            const muted = !!muteLabel(sn);
            return (
              <div key={srv.id} className="flex items-center gap-3 rounded-lg border border-edge bg-rail/50 px-3 py-2">
                <span className="h-8 w-8 shrink-0 overflow-hidden rounded-[10px]">
                  {srv.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fileUrl(srv.iconUrl)} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <DefaultServerIcon />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{srv.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {muted ? muteLabel(sn) : LEVEL_LABEL[sn?.level ?? DEFAULT_SERVER_LEVEL]}
                  </span>
                </span>
                {muted && <MutedIcon />}
                <Button variant="subtle" className="px-3 py-1.5" onClick={() => setEditing(srv.id)}>
                  Configurar
                </Button>
              </div>
            );
          })}
          {!servers.length && <p className="text-sm text-muted">Você ainda não está em nenhum servidor.</p>}
        </div>
      </div>
      {editing && <ServerNotifyModal serverId={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------- caixa de entrada (botão na barra de título) ----------

export function InboxButton({ className, size = 16 }: { className?: string; size?: number }) {
  const [open, setOpen] = useState(false);
  const has = useLine((s) => totalMentions(s) > 0);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        title="Caixa de entrada"
        onClick={() => setOpen((o) => !o)}
        className={cx('relative flex items-center justify-center text-muted hover:text-fg', open && 'text-fg', className)}
      >
        <Icons.Inbox size={size} />
        {has && <span className="absolute top-1 right-2 h-2 w-2 rounded-full bg-danger ring-2 ring-rail" />}
      </button>
      {open && <InboxPanel anchor={ref.current} onClose={() => setOpen(false)} />}
    </>
  );
}

type Tab = 'unread' | 'mentions';

function InboxPanel({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('unread');
  const r = anchor?.getBoundingClientRect();
  const top = (r?.bottom ?? 40) + 6;
  const right = Math.max(8, window.innerWidth - (r?.right ?? window.innerWidth - 8));

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor?.contains(t)) return;
      // Menus e modais abertos a partir do painel não fecham ele.
      if ((t as HTMLElement).closest?.('[role="menu"],[role="dialog"]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      style={{ top, right }}
      className="fixed z-[55] flex max-h-[min(640px,calc(100vh-60px))] w-[min(460px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-edge bg-side shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-edge px-4 pt-3">
        <Icons.Inbox size={18} className="text-muted" />
        <h3 className="mr-2 font-bold">Caixa de entrada</h3>
        {(['unread', 'mentions'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx('-mb-px border-b-2 px-2 pb-2 text-sm font-semibold', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-soft')}
          >
            {t === 'unread' ? 'Não lidas' : 'Menções'}
          </button>
        ))}
      </div>
      {tab === 'unread' ? <UnreadTab onClose={onClose} /> : <MentionsTab onClose={onClose} />}
    </div>,
    document.body,
  );
}

/** Canais com novidade: menções sempre; não lidas só se não estiverem silenciadas. */
function unreadList(s: LineState): { id: string; serverId: string | null; mentions: number }[] {
  const ids = new Set([...Object.keys(s.unread), ...Object.keys(s.mentionCounts)]);
  const out: { id: string; serverId: string | null; mentions: number }[] = [];
  for (const id of ids) {
    const { serverId } = infoOf(s, id);
    const mentions = serverId || !isChannelMuted(s, id) ? mentionCount(s, id) : 0;
    if (mentions || showsUnread(s, id)) out.push({ id, serverId, mentions });
  }
  const last = (id: string) => s.readMarks[id]?.last ?? '';
  return out.sort((a, b) => (last(b.id) > last(a.id) ? 1 : -1));
}

function UnreadTab({ onClose }: { onClose: () => void }) {
  const list = useLine(useMemo(() => {
    let prev: ReturnType<typeof unreadList> = [];
    return (s: LineState) => {
      const next = unreadList(s);
      if (next.length === prev.length && next.every((x, i) => x.id === prev[i]!.id && x.mentions === prev[i]!.mentions)) return prev;
      prev = next;
      return next;
    };
  }, []));

  // Canais de servidores que ainda não abri: carrega para ter nome e mensagens.
  useEffect(() => {
    const s = useLine.getState();
    for (const sid of new Set(list.map((x) => x.serverId).filter(Boolean) as string[])) if (!s.loadedServers[sid]) void ensureServerLoaded(sid).catch(() => {});
  }, [list]);

  const markAll = () => {
    const servers = new Set(list.map((x) => x.serverId).filter(Boolean) as string[]);
    servers.forEach(markServerRead);
    list.filter((x) => !x.serverId).forEach((x) => actions.markRead(x.id));
  };

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted">
        <span>{list.length ? `${list.length} ${list.length === 1 ? 'conversa' : 'conversas'} com novidades` : ''}</span>
        {list.length > 0 && (
          <button onClick={markAll} className="font-semibold text-accent hover:underline">
            Marcar tudo como lido
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {list.length === 0 && (
          <div className="py-12 text-center text-sm text-muted">
            <Icons.Check size={32} className="mx-auto mb-2 opacity-60" />
            Tudo em dia! Nenhuma mensagem não lida.
          </div>
        )}
        {list.slice(0, 30).map((x) => (
          <UnreadChannel key={x.id} channelId={x.id} serverId={x.serverId} mentions={x.mentions} onClose={onClose} />
        ))}
      </div>
    </>
  );
}

function openChannel(channelId: string, serverId: string | null) {
  const ch = useLine.getState().channels[channelId];
  if (ch?.type === 'thread' && ch.parentId && serverId) {
    actions.goServer(serverId, ch.parentId);
    actions.openThread(ch.id);
  } else if (serverId) actions.goServer(serverId, channelId);
  else actions.goHome(channelId);
}

function UnreadChannel({ channelId, serverId, mentions, onClose }: { channelId: string; serverId: string | null; mentions: number; onClose: () => void }) {
  const channel = useLine((s) => s.channels[channelId]);
  const server = useLine((s) => (serverId ? s.servers[serverId] : undefined));
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const me = useLine((s) => s.me);
  const read = useLine((s) => s.readMarks[channelId]?.read ?? '');
  const muted = useLine((s) => isMutedAnywhere(s, channelId));
  const [msgs, setMsgs] = useState<Message[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .messages(channelId, undefined, 6)
      .then((items) => alive && setMsgs(items.filter((m) => m.id > read && m.author.id !== meId).slice(-3)))
      .catch(() => alive && setMsgs([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const name = channel
    ? channel.serverId
      ? `${channel.type === 'thread' ? '' : '#'}${channel.name}`
      : dmTitle(channel, meId, users)
    : 'Carregando…';
  const other = channel && !channel.serverId && channel.type !== 'group_dm' ? (channel.recipients ?? []).find((r) => r.id !== meId) : undefined;

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-main/60">
      <div className="flex items-center gap-2.5 border-b border-edge/60 px-3 py-2">
        {server ? (
          <span className="h-7 w-7 shrink-0 overflow-hidden rounded-[9px]">
            {server.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full object-cover" />
            ) : (
              <DefaultServerIcon />
            )}
          </span>
        ) : (
          <Avatar name={other?.displayName ?? name} color={other?.avatarColor ?? '#3a3a42'} src={other?.avatarUrl} size={28} />
        )}
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => {
            openChannel(channelId, serverId);
            onClose();
          }}
        >
          <span className="flex items-center gap-1.5 truncate text-sm font-semibold hover:underline">
            {channel?.type === 'thread' && <Icons.Thread size={13} />}
            {name}
            {muted && <MutedIcon />}
          </span>
          {server && <span className="block truncate text-xs text-muted">{server.name}</span>}
        </button>
        <MentionBadge count={mentions} />
        <button title="Marcar como lida" onClick={() => actions.markRead(channelId)} className="rounded-full p-1.5 text-muted hover:bg-hover hover:text-fg">
          <Icons.Check size={16} />
        </button>
      </div>
      <div className="space-y-2 px-3 py-2">
        {msgs === null && <MessageSkeletons count={1} />}
        {msgs?.length === 0 && <p className="text-xs text-muted">Novas mensagens.</p>}
        {msgs?.map((m) => {
          const a = users[m.author.id] ?? m.author;
          return (
            <button
              key={m.id}
              onClick={() => {
                void jumpToMessage(m);
                onClose();
              }}
              className="flex w-full gap-2 rounded-md p-1 text-left hover:bg-hover"
            >
              <Avatar name={a.displayName} color={a.avatarColor} src={a.avatarUrl} size={24} />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-semibold" style={{ color: a.avatarColor }}>
                  {a.displayName}
                </span>
                <span className="line-clamp-2 text-sm break-words text-soft">
                  {m.content ? renderMarkdown(m.content, me?.username ?? '') : m.attachments.length ? '📎 Anexo' : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MentionsTab({ onClose }: { onClose: () => void }) {
  const currentServer = useLine((s) => (s.view.kind === 'server' ? s.view.serverId : null));
  const servers = useLine((s) => s.servers);
  const channels = useLine((s) => s.channels);
  const users = useLine((s) => s.users);
  const myUsername = useLine((s) => s.me?.username ?? '');
  const [onlyHere, setOnlyHere] = useState(false);
  const [everyone, setEveryone] = useState(true);
  const [roles, setRoles] = useState(true);
  const [items, setItems] = useState<Message[] | null>(null);
  const [more, setMore] = useState(false);
  const server = onlyHere && currentServer ? currentServer : undefined;

  useEffect(() => {
    let alive = true;
    setItems(null);
    api
      .recentMentions({ server, everyone, roles })
      .then((list) => {
        if (!alive) return;
        setItems(list);
        setMore(list.length >= 25);
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [server, everyone, roles]);

  const loadMore = async () => {
    const last = items?.[items.length - 1];
    if (!last) return;
    const list = await api.recentMentions({ server, everyone, roles, before: last.id }).catch(() => []);
    setItems((cur) => [...(cur ?? []), ...list]);
    setMore(list.length >= 25);
  };

  const chip = (on: boolean, label: string, toggle: () => void) => (
    <button
      onClick={toggle}
      className={cx('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold', on ? 'border-accent/60 bg-accent/15 text-fg' : 'border-edge text-muted hover:text-soft')}
    >
      {on && <Icons.Check size={12} />}
      {label}
    </button>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-4 py-2">
        {currentServer && chip(onlyHere, 'Só este servidor', () => setOnlyHere((v) => !v))}
        {chip(everyone, '@everyone e @here', () => setEveryone((v) => !v))}
        {chip(roles, 'Menções de cargo', () => setRoles((v) => !v))}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {items === null && <MessageSkeletons count={3} />}
        {items?.length === 0 && (
          <div className="py-12 text-center text-sm text-muted">
            <Icons.AtSign size={32} className="mx-auto mb-2 opacity-60" />
            Ninguém te mencionou ainda.
          </div>
        )}
        {items?.map((m) => {
          const info = infoOf(useLine.getState(), m.channelId);
          const ch = channels[m.channelId];
          const srv = info.serverId ? servers[info.serverId] : undefined;
          const a = users[m.author.id] ?? m.author;
          return (
            <button
              key={m.id}
              onClick={async () => {
                if (info.serverId) await ensureServerLoaded(info.serverId).catch(() => {});
                await jumpToMessage(m);
                onClose();
              }}
              className="block w-full rounded-lg border border-edge bg-main/60 p-2.5 text-left hover:border-accent/50 hover:bg-hover"
            >
              <p className="mb-1.5 flex items-center gap-1 truncate text-xs font-semibold text-muted">
                {ch?.type === 'thread' ? <Icons.Thread size={12} /> : <Icons.Hash size={12} />}
                {ch?.name ?? 'canal'}
                {srv && <span className="font-normal">· {srv.name}</span>}
              </p>
              <div className="flex gap-2.5">
                <Avatar name={a.displayName} color={a.avatarColor} src={a.avatarUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-semibold" style={{ color: a.avatarColor }}>
                      {a.displayName}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {formatMessageTime(m.createdAt)}
                    </span>
                  </p>
                  {m.content && <div className="line-clamp-4 text-sm break-words whitespace-pre-wrap text-soft">{renderMarkdown(m.content, myUsername)}</div>}
                </div>
              </div>
            </button>
          );
        })}
        {items && more && (
          <button onClick={() => void loadMore()} className="w-full rounded-lg py-2 text-sm text-accent hover:bg-hover">
            Carregar mais
          </button>
        )}
      </div>
    </>
  );
}
