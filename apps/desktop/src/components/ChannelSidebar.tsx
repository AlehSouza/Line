'use client';

import type { Channel } from '@line/shared';
import { useMemo, useState } from 'react';
import { actions, useLine } from '@/lib/store';
import { joinVoice, useVoice } from '@/lib/voice';
import { cx, Icons } from './ui';
import { VoiceChannelMembers } from './Voice';

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const server = useLine((s) => s.servers[serverId]);
  const me = useLine((s) => s.me);
  const allChannels = useLine((s) => s.channels);
  const allCategories = useLine((s) => s.categories);
  const unread = useLine((s) => s.unread);
  const activeId = useLine((s) => (s.view.kind === 'server' ? s.view.channelId : null));
  const loaded = useLine((s) => !!s.loadedServers[serverId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { categories, byCategory, loose } = useMemo(() => {
    const channels = Object.values(allChannels)
      .filter((c) => c.serverId === serverId)
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
    return { categories, byCategory, loose };
  }, [allChannels, allCategories, serverId]);

  if (!server) return null;
  const isOwner = me?.id === server.ownerId;

  const renderChannel = (c: Channel) => {
    const active = c.id === activeId;
    const hasUnread = !!unread[c.id] && !active;
    const Icon = c.type === 'voice' ? Icons.Speaker : Icons.Hash;
    return (
      <div key={c.id}>
        <div className="group relative">
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
            <Icon size={18} className="shrink-0 opacity-70" />
            <span className={cx('truncate', hasUnread && 'font-semibold')}>{c.name}</span>
          </button>
          {hasUnread && <span className="absolute top-1/2 -left-2 h-2 w-1 -translate-y-1/2 rounded-r bg-fg" />}
          {isOwner && (
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
        {c.type === 'voice' && <VoiceChannelMembers channelId={c.id} />}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex h-12 w-full items-center justify-between border-b border-rail px-4 font-bold shadow-sm hover:bg-hover"
        >
          <span className="truncate">{server.name}</span>
          <Icons.Chevron size={16} className={cx('transition-transform', menuOpen && 'rotate-180')} />
        </button>
        {menuOpen && (
          <div
            className="absolute top-13 right-2 left-2 z-20 space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-xl"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <MenuItem
              icon={<Icons.Link size={16} />}
              accent
              onClick={() => actions.openModal({ kind: 'invite', serverId })}
              close={() => setMenuOpen(false)}
            >
              Convidar pessoas
            </MenuItem>
            {isOwner && (
              <>
                <MenuItem
                  icon={<Icons.Settings size={16} />}
                  onClick={() => actions.openModal({ kind: 'server-settings', serverId })}
                  close={() => setMenuOpen(false)}
                >
                  Configurações do servidor
                </MenuItem>
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
        {!loaded && <p className="px-2 text-sm text-muted">Carregando…</p>}
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
              {isOwner && (
                <button
                  title="Criar canal"
                  onClick={() => actions.openModal({ kind: 'create-channel', serverId, categoryId: cat.id })}
                  className="text-muted hover:text-fg"
                >
                  <Icons.Plus size={16} />
                </button>
              )}
            </div>
            {!collapsed[cat.id] && <div className="space-y-0.5">{(byCategory[cat.id] ?? []).map(renderChannel)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
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
        danger ? 'text-danger hover:bg-danger hover:text-white' : accent ? 'text-accent hover:bg-accent hover:text-rail' : 'text-soft hover:bg-accent hover:text-rail',
      )}
    >
      {children}
      {icon}
    </button>
  );
}
