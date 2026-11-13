'use client';

import { hasPerm, Perm } from '@line/shared';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { api, fileUrl } from '@/lib/api';
import { actions, permsOf, useLine } from '@/lib/store';
import { useVoice } from '@/lib/voice';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { Avatar, cx, Icons, initials, Logo } from './ui';

export function ServerRail() {
  const view = useLine((s) => s.view);
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]!).filter(Boolean)));
  const unread = useLine((s) => s.unread);
  const channels = useLine((s) => s.channels);
  const pendingFriends = useLine((s) => Object.values(s.friends).filter((f) => f.state === 'incoming').length);

  const dmUnread = Object.entries(unread).reduce((n, [cid, c]) => (channels[cid] && !channels[cid]!.serverId ? n + c : n), 0);
  const serverHasUnread = (serverId: string) =>
    Object.keys(unread).some((cid) => channels[cid]?.serverId === serverId);
  // Quem está em canais de voz, agrupado por servidor (para o indicador e o tooltip).
  const voiceStates = useVoice((v) => v.states);
  const inVoice: Record<string, string[]> = {};
  for (const st of Object.values(voiceStates)) if (st.serverId) (inVoice[st.serverId] ??= []).push(st.userId);

  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3">
      <RailItem
        label="Início"
        active={view.kind === 'home'}
        badge={dmUnread + pendingFriends}
        onClick={() => actions.goHome(view.kind === 'home' ? view.dmId : null)}
      >
        <Logo size={30} />
      </RailItem>

      <div className="mx-auto h-0.5 w-8 rounded bg-edge" />

      {servers.map((server) => (
        <RailItem
          key={server.id}
          label={server.name}
          active={view.kind === 'server' && view.serverId === server.id}
          dot={serverHasUnread(server.id)}
          color={server.iconUrl ? undefined : server.iconColor}
          onClick={() => actions.goServer(server.id)}
          onContextMenu={(e) => openContextMenu(e, serverMenu(server.id))}
          voice={inVoice[server.id]}
          tooltip={<ServerTooltip name={server.name} voice={inVoice[server.id]} />}
        >
          {server.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full rounded-[inherit] object-cover" />
          ) : (
            <span className="text-sm font-bold text-rail">{initials(server.name)}</span>
          )}
        </RailItem>
      ))}

      <RailItem label="Criar um servidor" onClick={() => actions.openModal({ kind: 'create-server' })} action>
        <Icons.Plus />
      </RailItem>
      <RailItem label="Explorar servidores públicos" active={view.kind === 'discover'} onClick={actions.goDiscover} action>
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
  color,
  action,
  onClick,
  onContextMenu,
  voice,
  tooltip,
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  dot?: boolean;
  color?: string;
  action?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  voice?: string[];
  tooltip?: ReactNode;
  children: React.ReactNode;
}) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      className="group relative flex w-full justify-center"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setTip({ x: r.right - 4, y: r.top + r.height / 2 });
      }}
      onMouseLeave={() => setTip(null)}
    >
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
        onContextMenu={onContextMenu}
        className={cx(
          'relative flex h-12 w-12 items-center justify-center transition-all',
          'rounded-[14px]', // quadrado com cantos arredondados (~30%), sem virar círculo
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
        {!!voice?.length && (
          <span
            title="Gente em canais de voz"
            className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-on-accent ring-4 ring-rail"
          >
            <Icons.Speaker size={11} />
          </span>
        )}
      </button>
      {tip &&
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
  const unreadIds = Object.keys(s.unread).filter((cid) => s.channels[cid]?.serverId === serverId);
  const isOwner = s.me?.id === server.ownerId;
  const canSettings =
    hasPerm(perms, Perm.ManageServer) ||
    hasPerm(perms, Perm.ManageRoles) ||
    hasPerm(perms, Perm.KickMembers) ||
    hasPerm(perms, Perm.ManageNicknames);
  return [
    {
      label: 'Marcar como lido',
      icon: <Icons.Check size={15} />,
      disabled: !unreadIds.length,
      onClick: () => unreadIds.forEach((cid) => actions.markRead(cid)),
    },
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
        if (confirm(`Sair de ${server.name}?`)) await api.leaveServer(serverId);
      },
    },
  ];
}
