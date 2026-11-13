'use client';

import { hasPerm, Perm, type Channel } from '@line/shared';
import { useMemo, useState } from 'react';
import { fileUrl } from '@/lib/api';
import { actions, permsOf, useLine } from '@/lib/store';
import { joinVoice, leaveVoice, useVoice } from '@/lib/voice';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { cx, Icons, ListSkeleton } from './ui';
import { VoiceChannelMembers } from './Voice';
import { CallTimer } from './VoiceInvite';

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const server = useLine((s) => s.servers[serverId]);
  const me = useLine((s) => s.me);
  const allChannels = useLine((s) => s.channels);
  const allCategories = useLine((s) => s.categories);
  const unread = useLine((s) => s.unread);
  const activeId = useLine((s) => (s.view.kind === 'server' ? s.view.channelId : null));
  const openThreadId = useLine((s) => s.threadId);
  const loaded = useLine((s) => !!s.loadedServers[serverId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const perms = useLine((s) => permsOf(s, serverId, s.me?.id));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { categories, byCategory, loose, threads } = useMemo(() => {
    const all = Object.values(allChannels).filter((c) => c.serverId === serverId);
    const threads: Record<string, Channel[]> = {};
    for (const t of all) if (t.type === 'thread' && t.parentId) (threads[t.parentId] ??= []).push(t);
    // Threads mais ativas primeiro.
    for (const list of Object.values(threads))
      list.sort((a, b) => (b.lastMessageAt ?? b.id).localeCompare(a.lastMessageAt ?? a.id));
    const channels = all
      .filter((c) => c.type !== 'thread')
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const categories = Object.values(allCategories)
      .filter((c) => c.serverId === serverId)
      .sort((a, b) => a.position - b.position);
    const byCategory: Record<string, Channel[]> = {};
    const loose: Channel[] = [];
    for (const c of channels) {
      if (c.categoryId && allCategories[c.categoryId]) (byCategory[c.categoryId] ??= []).push(c);
      else loose.push(c);
    }
    return { categories, byCategory, loose, threads };
  }, [allChannels, allCategories, serverId]);

  if (!server) return null;
  const isOwner = me?.id === server.ownerId;
  // "Gerenciar canais" libera criar/editar/excluir canais e categorias.
  const canChannels = hasPerm(perms, Perm.ManageChannels);
  const canSettings = hasPerm(perms, Perm.ManageServer) || hasPerm(perms, Perm.ManageRoles) || hasPerm(perms, Perm.KickMembers) || hasPerm(perms, Perm.ManageNicknames);
  const canNick = hasPerm(perms, Perm.ChangeNickname) || hasPerm(perms, Perm.ManageNicknames);

  const renderChannel = (c: Channel) => {
    const active = c.id === activeId;
    const hasUnread = !!unread[c.id] && !active;
    const Icon = c.type === 'voice' ? Icons.Speaker : Icons.Hash;
    return (
      <div key={c.id}>
        <div className="group relative" onContextMenu={(e) => openContextMenu(e, channelMenu(c, canChannels, hasPerm(perms, Perm.CreateInvite)))}>
          <button
            onClick={() => {
              actions.goServer(serverId, c.id);
              if (c.type === 'voice' && useVoice.getState().channelId !== c.id) void joinVoice(c.id);
            }}
            className={cx(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[15px]',
              active ? 'bg-hover text-fg' : hasUnread ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-soft',
            )}
          >
            <span className="relative shrink-0">
              <Icon size={18} className="opacity-70" />
              {c.isPrivate && (
                <span className="absolute -top-1 -right-1 rounded-full bg-side p-px" title="Canal privado">
                  <Icons.Lock size={9} />
                </span>
              )}
            </span>
            <span className={cx('truncate', hasUnread && 'font-semibold')}>{c.name}</span>
          </button>
          {hasUnread && <span className="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r bg-fg" />}
          {c.type === 'voice' && (
            <CallTimer
              channelId={c.id}
              className={cx('pointer-events-none absolute top-1/2 right-2 -translate-y-1/2', canChannels && 'group-hover:hidden')}
            />
          )}
          {canChannels && (
            <button
              title="Excluir canal"
              onClick={async () => {
                if (confirm(`Excluir o canal #${c.name}? As mensagens dele serão apagadas.`)) {
                  const { api } = await import('@/lib/api');
                  await api.deleteChannel(c.id).catch((e) => alert(e.message));
                }
              }}
              className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 text-muted group-hover:block hover:text-danger"
            >
              <Icons.Trash size={14} />
            </button>
          )}
        </div>
        {c.type === 'voice' && <VoiceChannelMembers channelId={c.id} serverId={serverId} />}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Cabeçalho fixo: fica fora da área que rola, então o banner não sai do lugar. */}
      <div className="relative shrink-0">
        {server.bannerUrl && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[135px] overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(server.bannerUrl)} alt="" className="h-full w-full object-cover" />
            {/* Gradiente: escurece em cima (nome legível) e funde com a lista embaixo. */}
            <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(0,0,0,0.6),transparent_45%,transparent_65%,var(--color-side))]" />
          </div>
        )}
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className={cx(
            'relative flex h-12 w-full items-center justify-between px-4 font-bold',
            server.bannerUrl
              ? 'text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.7)] hover:bg-black/20'
              : 'border-b border-rail shadow-sm hover:bg-hover',
          )}
        >
          <span className="truncate">{server.name}</span>
          <Icons.Chevron size={16} className={cx('transition-transform', menuOpen && 'rotate-180')} />
        </button>
        {server.bannerUrl && <div className="h-[87px]" />}
        {menuOpen && (
          <div
            className="absolute top-13 right-2 left-2 z-20 space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-xl"
            onMouseLeave={() => setMenuOpen(false)}
          >
            {hasPerm(perms, Perm.CreateInvite) && (
              <MenuItem
                icon={<Icons.Link size={16} />}
                accent
                onClick={() => actions.openModal({ kind: 'invite', serverId })}
                close={() => setMenuOpen(false)}
              >
                Convidar pessoas
              </MenuItem>
            )}
            {canSettings && (
              <MenuItem
                icon={<Icons.Settings size={16} />}
                onClick={() => actions.openModal({ kind: 'server-settings', serverId })}
                close={() => setMenuOpen(false)}
              >
                Config. do servidor
              </MenuItem>
            )}
            {hasPerm(perms, Perm.ManageRoles) && (
              <MenuItem
                icon={<Icons.Shield size={16} />}
                onClick={() => actions.openModal({ kind: 'server-settings', serverId, section: 'roles' })}
                close={() => setMenuOpen(false)}
              >
                Cargos
              </MenuItem>
            )}
            {canNick && me && (
              <MenuItem
                icon={<Icons.Edit size={16} />}
                onClick={() => actions.openModal({ kind: 'nickname', serverId, userId: me.id })}
                close={() => setMenuOpen(false)}
              >
                Alterar apelido
              </MenuItem>
            )}
            {canChannels && (
              <>
                <MenuItem
                  icon={<Icons.Plus size={16} />}
                  onClick={() => actions.openModal({ kind: 'create-channel', serverId, categoryId: null })}
                  close={() => setMenuOpen(false)}
                >
                  Criar canal
                </MenuItem>
                <MenuItem
                  icon={<Icons.Folder size={16} />}
                  onClick={() => actions.openModal({ kind: 'create-category', serverId })}
                  close={() => setMenuOpen(false)}
                >
                  Criar categoria
                </MenuItem>
              </>
            )}
            {!isOwner && (
              <MenuItem
                icon={<Icons.Logout size={16} />}
                danger
                onClick={async () => {
                  if (!confirm(`Sair de ${server.name}?`)) return;
                  const { api } = await import('@/lib/api');
                  await api.leaveServer(serverId).catch((e) => alert(e.message));
                }}
                close={() => setMenuOpen(false)}
              >
                Sair do servidor
              </MenuItem>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-2 py-3">
        {!loaded && <ListSkeleton count={8} />}
        {loose.length > 0 && <div className="space-y-0.5">{loose.map(renderChannel)}</div>}
        {categories.map((cat) => (
          <div key={cat.id}>
            <div className="group flex items-center justify-between px-1 pb-1">
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [cat.id]: !c[cat.id] }))}
                className="flex items-center gap-0.5 text-xs font-bold tracking-wide text-muted uppercase hover:text-soft"
              >
                <Icons.Chevron size={12} className={cx('transition-transform', collapsed[cat.id] && '-rotate-90')} />
                {cat.name}
              </button>
              {canChannels && (
                <span className="flex items-center gap-1.5">
                  <button
                    title="Editar categoria"
                    onClick={() => actions.openModal({ kind: 'edit-category', categoryId: cat.id })}
                    className="hidden text-muted group-hover:block hover:text-fg"
                  >
                    <Icons.Edit size={13} />
                  </button>
                  <button
                    title="Criar canal"
                    onClick={() => actions.openModal({ kind: 'create-channel', serverId, categoryId: cat.id })}
                    className="text-muted hover:text-fg"
                  >
                    <Icons.Plus size={16} />
                  </button>
                </span>
              )}
            </div>
            {!collapsed[cat.id] && <div className="space-y-0.5">{(byCategory[cat.id] ?? []).map(renderChannel)}</div>}
          </div>
        ))}
        {canChannels && loaded && (
          <button
            onClick={() => actions.openModal({ kind: 'create-category', serverId })}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-bold tracking-wide text-muted uppercase hover:bg-hover hover:text-soft"
          >
            <Icons.Folder size={14} />
            Criar categoria
          </button>
        )}
      </div>
    </div>
  );
}

/** Clique direito num canal da lista. */
function channelMenu(c: Channel, canChannels: boolean, canInvite: boolean): MenuEntry[] {
  const s = useLine.getState();
  const inThis = useVoice.getState().channelId === c.id;
  return [
    {
      label: 'Marcar como lido',
      icon: <Icons.Check size={15} />,
      disabled: !s.unread[c.id],
      onClick: () => actions.markRead(c.id),
    },
    c.type === 'voice' &&
      (inThis
        ? { label: 'Sair da chamada', icon: <Icons.PhoneOff size={15} />, danger: true, onClick: () => leaveVoice() }
        : {
            label: 'Entrar na chamada',
            icon: <Icons.Phone size={15} />,
            onClick: () => {
              actions.goServer(c.serverId!, c.id);
              return joinVoice(c.id);
            },
          }),
    'sep',
    canInvite && c.serverId && {
      label: 'Convidar pessoas',
      icon: <Icons.UserPlus size={15} />,
      onClick: () => actions.openModal({ kind: 'invite', serverId: c.serverId! }),
    },
    { label: 'Copiar ID do canal', icon: <Icons.Copy size={15} />, onClick: () => navigator.clipboard.writeText(c.id) },
    canChannels && 'sep',
    canChannels && {
      label: 'Excluir canal',
      icon: <Icons.Trash size={15} />,
      danger: true,
      onClick: async () => {
        if (confirm(`Excluir o canal #${c.name}? As mensagens dele serão apagadas.`)) {
          const { api } = await import('@/lib/api');
          await api.deleteChannel(c.id);
        }
      },
    },
  ];
}

function MenuItem({
  icon,
  children,
  onClick,
  close,
  danger,
  accent,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  close: () => void;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      onClick={() => {
        close();
        onClick();
      }}
      className={cx(
        'flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left font-medium',
        danger ? 'text-danger hover:bg-danger hover:text-white' : accent ? 'text-accent hover:bg-accent hover:text-on-accent' : 'text-soft hover:bg-accent hover:text-on-accent',
      )}
    >
      {children}
      {icon}
    </button>
  );
}
