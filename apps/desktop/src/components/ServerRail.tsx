'use client';

import { mobile } from '@/lib/mobile';

import { hasPerm, Perm } from '@line/shared';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { api, fileUrl } from '@/lib/api';
import { actions, permsOf, useLine } from '@/lib/store';
import { useVoice } from '@/lib/voice';
import { openContextMenu, useContextMenuOpen, type MenuEntry } from './ContextMenu';
import { Avatar, cx, DefaultServerIcon, Icons, Logo } from './ui';
import { useIncomingCount } from './FriendsView';
import { confirmDialog } from './Dialogs';
import { infoOf, isServerMuted, markServerRead, serverBadge, unreadDms } from '@/lib/notify';
import { dmNotifyItems, serverNotifyItems } from './Notifications';
import { dmTitle } from '@/lib/store';

export function ServerRail() {
  const view = useLine((s) => s.view);
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]!).filter(Boolean)));
  const channels = useLine((s) => s.channels);
  const pendingFriends = useIncomingCount();
  // Bolinha e menções de cada servidor (recalcula só quando muda).
  const badges = useLine(
    useShallow((s) => {
      const out: Record<string, string> = {};
      for (const id of s.serverOrder) {
        const b = serverBadge(s, id);
        out[id] = `${b.unread ? 1 : 0}:${b.mentions}`;
      }
      return out;
    }),
  );
  const mutedServers = useLine(useShallow((s) => s.serverOrder.filter((id) => isServerMuted(s, id))));
  // DMs com mensagens não lidas: aparecem acima dos servidores, com a foto redonda da pessoa.
  const dmBadges = useLine(useShallow((s) => unreadDms(s).map((d) => `${d.id}:${d.count}`)));
  // Quem está em canais de voz, agrupado por servidor (para o indicador e o tooltip).
  const voiceStates = useVoice((v) => v.states);
  // Servidor da call em que ESTE app está conectado (só ele ganha o selo de voz).
  const myVoiceChannel = useVoice((v) => v.channelId);
  // Arrastar servidores para mudar a ordem (salva só para mim).
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dropOn = (targetId: string) => {
    const from = drag;
    setDrag(null);
    setOver(null);
    if (!from || from === targetId) return;
    const ids = servers.map((s) => s.id);
    const to = ids.indexOf(targetId);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(to, 0, from);
    actions.setServerOrder(ids);
    void api.reorderMyServers(ids).catch(() => {});
  };
  const myVoiceServer = myVoiceChannel ? channels[myVoiceChannel]?.serverId : null;
  const inVoice: Record<string, string[]> = {};
  for (const st of Object.values(voiceStates)) if (st.serverId) (inVoice[st.serverId] ??= []).push(st.userId);

  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3">
      <RailItem
        label="Início"
        active={view.kind === 'home'}
        badge={pendingFriends}
        onClick={() => actions.goHome(view.kind === 'home' ? view.dmId : null)}
      >
        {/* Acinzentado em repouso; ganha a cor ao passar o mouse (ou na tela inicial). */}
        <span
          className={cx(
            'flex transition-[filter,opacity] duration-300',
            view.kind === 'home' ? 'grayscale-0' : 'opacity-80 grayscale group-hover:opacity-100 group-hover:grayscale-0',
          )}
        >
          <Logo size={30} />
        </span>
      </RailItem>

      {dmBadges.map((key) => {
        const [dmId, n] = key.split(':') as [string, string];
        return <DmRailItem key={dmId} dmId={dmId} count={Number(n)} />;
      })}

      <div className="mx-auto h-0.5 w-8 rounded bg-edge" />

      {servers.map((server) => (
        <RailItem
          key={server.id}
          drag={{
            draggable: true,
            onDragStart: (e) => {
              e.dataTransfer.effectAllowed = 'move';
              // Imagem de arraste: só o ícone, recortado com os cantos arredondados (sem virar quadrado).
              const btn = e.currentTarget.querySelector('button');
              if (btn) {
                const ghost = btn.cloneNode(true) as HTMLElement;
                Object.assign(ghost.style, { position: 'fixed', top: '-200px', left: '-200px', overflow: 'hidden', borderRadius: '14px' });
                ghost.querySelectorAll('span.absolute').forEach((el) => el.remove());
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 24, 24);
                window.setTimeout(() => ghost.remove(), 0);
              }
              setDrag(server.id);
            },
            onDragEnd: () => {
              setDrag(null);
              setOver(null);
            },
            onDragOver: (e) => {
              if (!drag) return;
              e.preventDefault();
              setOver(server.id);
            },
            onDrop: (e) => {
              e.preventDefault();
              dropOn(server.id);
            },
          }}
          dropMark={over === server.id && drag !== server.id ? (servers.findIndex((s) => s.id === drag) < servers.findIndex((s) => s.id === server.id) ? 'below' : 'above') : null}
          dragging={drag === server.id}
          label={server.name}
          active={view.kind === 'server' && view.serverId === server.id}
          dot={badges[server.id]?.startsWith('1')}
          badge={Number(badges[server.id]?.split(':')[1] ?? 0)}
          muted={mutedServers.includes(server.id)}
          onClick={() => actions.goServer(server.id)}
          onContextMenu={(e) => openContextMenu(e, serverMenu(server.id))}
          voice={!!myVoiceServer && myVoiceServer === server.id}
          tooltip={<ServerTooltip name={server.name} voice={inVoice[server.id]} />}
        >
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full rounded-[inherit] object-cover" />
          ) : (
            <span className="h-full w-full overflow-hidden rounded-[inherit]">
              <DefaultServerIcon />
            </span>
          )}
        </RailItem>
      ))}

      <RailItem label="Criar um servidor" onClick={() => actions.openModal({ kind: 'create-server' })} action>
        <Icons.Plus />
      </RailItem>
      <RailItem label="Explorar servidores públicos" active={view.kind === 'discover'} onClick={() => {
          actions.goDiscover();
          mobile.showMain();
        }} action>
        <Icons.Compass />
      </RailItem>
    </nav>
  );
}

function RailItem({
  label,
  active,
  badge,
  dot,
  muted,
  round,
  color,
  action,
  onClick,
  onContextMenu,
  voice,
  tooltip,
  drag,
  dropMark,
  dragging,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  dot?: boolean;
  /** Servidor silenciado: ícone um pouco apagado. */
  muted?: boolean;
  /** Redondo (DM), diferente do quadrado arredondado dos servidores. */
  round?: boolean;
  color?: string;
  action?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** Eu estou conectado em voz neste servidor (só aí aparece o selo). */
  voice?: boolean;
  tooltip?: ReactNode;
  /** Handlers de arrastar (só nos servidores). */
  drag?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  /** Onde aparece a linha de "soltar aqui". */
  dropMark?: 'above' | 'below' | null;
  dragging?: boolean;
  children: React.ReactNode;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  // Clique direito abre o menu: o tooltip some e só volta quando o mouse sair e entrar de novo.
  const menuOpen = useContextMenuOpen();
  return (
    <div
      {...drag}
      className={cx('group relative flex w-full justify-center', dragging && 'opacity-40')}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ x: r.right - 4, y: r.top + r.height / 2 });
      }}
      onMouseLeave={() => setTip(null)}
    >
      {dropMark && (
        <span className={cx('pointer-events-none absolute left-1/2 h-0.5 w-10 -translate-x-1/2 rounded bg-accent', dropMark === 'above' ? '-top-1' : '-bottom-1')} />
      )}
      {/* Indicador lateral: ativo = barra alta, não lido = bolinha */}
      <span
        className={cx(
          'absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-fg transition-all',
          active ? 'h-10' : dot ? 'h-2' : 'h-0 group-hover:h-5',
        )}
      />
      <button
        aria-label={label}
        onClick={onClick}
        onContextMenu={(e) => {
          setTip(null);
          onContextMenu?.(e);
        }}
        className={cx(
          'relative flex h-12 w-12 items-center justify-center transition-all',
          round ? 'rounded-full' : 'rounded-[14px]', // servidor: quadrado com cantos arredondados (~30%); DM: círculo
          muted && !active && 'opacity-60 hover:opacity-100',
          action && !active && 'bg-side text-accent hover:bg-accent hover:text-on-accent',
          action && active && 'bg-accent text-on-accent',
          !action && !color && (active ? 'bg-raise' : 'bg-side hover:bg-raise'),
        )}
        style={color ? { background: color } : undefined}
      >
        {children}
        {!!badge && (
          <span className="absolute -right-1 -bottom-1 min-w-5 rounded-full bg-danger px-1 text-center text-[11px] leading-5 font-bold text-white ring-4 ring-rail">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
        {voice && !badge && (
          <span
            className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent ring-4 ring-rail"
          >
            <Icons.Speaker size={11} />
          </span>
        )}
      </button>
      {tip &&
        !menuOpen &&
        createPortal(
          <div
            style={{ left: tip.x + 12, top: tip.y }}
            className="pointer-events-none fixed z-[70] max-w-64 -translate-y-1/2 rounded-lg border border-edge bg-rail px-3 py-2 text-sm shadow-2xl"
          >
            {tooltip ?? <span className="font-semibold">{label}</span>}
          </div>,
          document.body,
        )}
    </div>
  );
}

function ServerTooltip({ name, voice }: { name: string; voice?: string[] }) {
  const users = useLine((s) => s.users);
  const shown = (voice ?? []).slice(0, 6);
  const extra = (voice?.length ?? 0) - shown.length;
  return (
    <div>
      <p className="truncate font-semibold">{name}</p>
      {!!shown.length && (
        <div className="mt-1.5 flex items-center gap-2">
          <Icons.Speaker size={16} className="shrink-0 text-muted" />
          <div className="flex -space-x-1.5">
            {shown.map((uid) => {
              const u = users[uid];
              return (
                <Avatar
                  key={uid}
                  name={u?.displayName ?? '?'}
                  color={u?.avatarColor ?? '#555'}
                  src={u?.avatarUrl}
                  size={24}
                  className="rounded-full ring-2 ring-rail"
                />
              );
            })}
          </div>
          {extra > 0 && <span className="text-xs text-muted">+{extra}</span>}
        </div>
      )}
    </div>
  );
}

/** Clique direito num servidor da barra lateral. */
function serverMenu(serverId: string): MenuEntry[] {
  const s = useLine.getState();
  const server = s.servers[serverId];
  if (!server) return [];
  const perms = permsOf(s, serverId, s.me?.id);
  const { unread: hasUnread, mentions } = serverBadge(s, serverId);
  const isOwner = s.me?.id === server.ownerId;
  const canSettings =
    hasPerm(perms, Perm.ManageServer) ||
    hasPerm(perms, Perm.ManageRoles) ||
    hasPerm(perms, Perm.KickMembers) ||
    hasPerm(perms, Perm.ManageNicknames) ||
    hasPerm(perms, Perm.ManageSoundboard) ||
    hasPerm(perms, Perm.ManageAgent);
  return [
    {
      label: 'Marcar como lido',
      icon: <Icons.Check size={15} />,
      disabled: !hasUnread && !mentions && !Object.keys(s.unread).some((cid) => infoOf(s, cid).serverId === serverId),
      onClick: () => markServerRead(serverId),
    },
    'sep',
    ...serverNotifyItems(serverId),
    'sep',
    hasPerm(perms, Perm.CreateInvite) && {
      label: 'Convidar pessoas',
      icon: <Icons.UserPlus size={15} />,
      onClick: () => actions.openModal({ kind: 'invite', serverId }),
    },
    canSettings && {
      label: 'Config. do servidor',
      icon: <Icons.Settings size={15} />,
      onClick: () => actions.openModal({ kind: 'server-settings', serverId }),
    },
    hasPerm(perms, Perm.ManageChannels) && {
      label: 'Criar canal',
      icon: <Icons.Plus size={15} />,
      onClick: () => actions.openModal({ kind: 'create-channel', serverId, categoryId: null }),
    },
    s.me &&
      (hasPerm(perms, Perm.ChangeNickname) || hasPerm(perms, Perm.ManageNicknames)) && {
        label: 'Alterar apelido',
        icon: <Icons.Edit size={15} />,
        onClick: () => actions.openModal({ kind: 'nickname', serverId, userId: s.me!.id }),
      },
    'sep',
    {
      label: 'Copiar ID do servidor',
      icon: <Icons.Copy size={15} />,
      onClick: () => navigator.clipboard.writeText(serverId),
    },
    !isOwner && 'sep',
    !isOwner && {
      label: 'Sair do servidor',
      icon: <Icons.Logout size={15} />,
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: `Sair de ${server.name}`, message: 'Você pode voltar depois com um convite.', confirmLabel: 'Sair', danger: true })) await api.leaveServer(serverId);
      },
    },
  ];
}

/** DM com mensagens não lidas na barra lateral: foto redonda da pessoa (ou do grupo) e o número. */
function DmRailItem({ dmId, count }: { dmId: string; count: number }) {
  const dm = useLine((s) => s.channels[dmId]);
  const me = useLine((s) => s.me);
  const users = useLine((s) => s.users);
  if (!dm) return null;
  const isGroup = dm.type === 'group_dm';
  const other = (dm.recipients ?? []).find((r) => r.id !== me?.id);
  const u = other ? (users[other.id] ?? other) : null;
  const title = dmTitle(dm, me?.id, users);
  return (
    <RailItem
      label={title}
      round
      badge={count}
      onClick={() => {
        actions.goHome(dmId);
        mobile.showMain();
      }}
      onContextMenu={(e) => openContextMenu(e, dmNotifyItems(dmId))}
    >
      <Avatar
        name={isGroup || !u ? title : u.displayName}
        color={isGroup || !u ? '#3a3a42' : u.avatarColor}
        src={isGroup || !u ? null : u.avatarUrl}
        size={48}
        className="rounded-full"
      />
    </RailItem>
  );
}
