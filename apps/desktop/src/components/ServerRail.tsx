'use client';

import { useShallow } from 'zustand/react/shallow';
import { fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { cx, Icons, initials, Logo } from './ui';

export function ServerRail() {
  const view = useLine((s) => s.view);
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]!).filter(Boolean)));
  const unread = useLine((s) => s.unread);
  const channels = useLine((s) => s.channels);
  const pendingFriends = useLine((s) => Object.values(s.friends).filter((f) => f.state === 'incoming').length);

  const dmUnread = Object.entries(unread).reduce((n, [cid, c]) => (channels[cid] && !channels[cid]!.serverId ? n + c : n), 0);
  const serverHasUnread = (serverId: string) =>
    Object.keys(unread).some((cid) => channels[cid]?.serverId === serverId);

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
  children,
}: {
  label: string;
  active?: boolean;
  badge?: number;
  dot?: boolean;
  color?: string;
  action?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative flex w-full justify-center">
      {/* Indicador lateral: ativo = barra alta, não lido = bolinha */}
      <span
        className={cx(
          'absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r bg-fg transition-all',
          active ? 'h-10' : dot ? 'h-2' : 'h-0 group-hover:h-5',
        )}
      />
      <button
        title={label}
        aria-label={label}
        onClick={onClick}
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
      </button>
    </div>
  );
}
