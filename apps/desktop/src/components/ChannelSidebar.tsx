'use client';

import { hasPerm, Perm, type Channel } from '@line/shared';
import { useMemo, useState } from 'react';
import { fileUrl } from '@/lib/api';
import { actions, permsOf, useLine, mentionsToText, withoutCardCodes } from '@/lib/store';
import { mobile } from '@/lib/mobile';
import { joinVoice, leaveVoice, useVoice } from '@/lib/voice';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { channelIcon, cx, Icons, ListSkeleton } from './ui';
import { CollapsedVoiceChannel, VoiceChannelMembers } from './Voice';
import { CallTimer } from './VoiceInvite';
import { confirmDialog, showError } from './Dialogs';
import { isChannelMuted, isMutedAnywhere, isServerMuted, mentionCount, muteServer, serverNotify, unmuteServer } from '@/lib/notify';
import { channelNotifyItems, MentionBadge, MutedIcon } from './Notifications';

/** Furo no canto do ícone do canal onde fica o cadeado (centro do sub-ícone de 11 px). */
const SUB_ICON_MASK = 'radial-gradient(circle at 16.5px 1.5px, transparent 6.5px, #000 7px)';

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const server = useLine((s) => s.servers[serverId]);
  const me = useLine((s) => s.me);
  const allChannels = useLine((s) => s.channels);
  const allCategories = useLine((s) => s.categories);
  const unread = useLine((s) => s.unread);
  // Notificações: silenciados, menções e "ocultar silenciados" (lib/notify).
  useLine((s) => s.notify);
  useLine((s) => s.mentionCounts);
  const st = useLine.getState();
  const hideMuted = !!serverNotify(st, serverId).hideMuted;
  const activeId = useLine((s) => (s.view.kind === 'server' ? s.view.channelId : null));
  const openThreadId = useLine((s) => s.threadId);
  const loaded = useLine((s) => !!s.loadedServers[serverId]);
  const [menuOpen, setMenuOpen] = useState(false);
  const perms = useLine((s) => permsOf(s, serverId, s.me?.id));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Arrastar e soltar: o que está sendo arrastado e onde vai cair.
  const [drag, setDrag] = useState<{ kind: 'channel' | 'category'; id: string } | null>(null);
  const [over, setOver] = useState<{ kind: 'channel' | 'category' | 'loose'; id: string; pos: 'above' | 'below' } | null>(null);

  const suspended = !!server?.suspended;
  const { categories, byCategory, loose, threads } = useMemo(() => {
    // Servidor suspenso: nenhum canal nem categoria na lista.
    const all = suspended ? [] : Object.values(allChannels).filter((c) => c.serverId === serverId);
    const threads: Record<string, Channel[]> = {};
    for (const t of all) if (t.type === 'thread' && t.parentId) (threads[t.parentId] ??= []).push(t);
    // Threads mais ativas primeiro.
    for (const list of Object.values(threads))
      list.sort((a, b) => (b.lastMessageAt ?? b.id).localeCompare(a.lastMessageAt ?? a.id));
    const channels = all
      .filter((c) => c.type !== 'thread')
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const categories = Object.values(allCategories)
      .filter((c) => !suspended && c.serverId === serverId)
      .sort((a, b) => a.position - b.position);
    const byCategory: Record<string, Channel[]> = {};
    const loose: Channel[] = [];
    for (const c of channels) {
      if (c.categoryId && allCategories[c.categoryId]) (byCategory[c.categoryId] ??= []).push(c);
      else loose.push(c);
    }
    return { categories, byCategory, loose, threads };
  }, [allChannels, allCategories, serverId, suspended]);

  if (!server) return null;
  const isOwner = me?.id === server.ownerId;
  // "Gerenciar canais" libera criar/editar/excluir canais e categorias.
  const canChannels = hasPerm(perms, Perm.ManageChannels);
  const canSettings = hasPerm(perms, Perm.ManageServer) || hasPerm(perms, Perm.ManageRoles) || hasPerm(perms, Perm.KickMembers) || hasPerm(perms, Perm.ManageNicknames) || hasPerm(perms, Perm.ManageSoundboard) || hasPerm(perms, Perm.ManageAgent);
  const canNick = hasPerm(perms, Perm.ChangeNickname) || hasPerm(perms, Perm.ManageNicknames);

  /** Metade de cima ou de baixo do item, para saber se solta antes ou depois dele. */
  const half = (e: React.DragEvent): 'above' | 'below' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? 'above' : 'below';
  };
  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const startDrag = (e: React.DragEvent, kind: 'channel' | 'category', id: string) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
    setDrag({ kind, id });
  };

  /** Monta a nova ordem (categorias e canais com a categoria de cada um) e salva no servidor. */
  const drop = () => {
    const d = drag;
    const o = over;
    endDrag();
    if (!d || !o || o.id === d.id) return;
    const catIds = categories.map((k) => k.id);
    const lists: Record<string, Channel[]> = { '': [...loose] };
    for (const k of categories) lists[k.id] = [...(byCategory[k.id] ?? [])];

    if (d.kind === 'category') {
      // Categoria solta sobre outra categoria ou sobre um canal dela.
      const target = o.kind === 'category' ? o.id : o.kind === 'channel' ? allChannels[o.id]?.categoryId : null;
      if (!target || target === d.id) return;
      const from = catIds.indexOf(d.id);
      catIds.splice(from, 1);
      const to = catIds.indexOf(target);
      catIds.splice(o.pos === 'below' || o.kind === 'channel' ? to + 1 : to, 0, d.id);
    } else {
      const moving = allChannels[d.id];
      if (!moving) return;
      for (const key of Object.keys(lists)) lists[key] = lists[key].filter((c) => c.id !== d.id);
      if (o.kind === 'channel') {
        const key = allChannels[o.id]?.categoryId && lists[allChannels[o.id]!.categoryId!] ? allChannels[o.id]!.categoryId! : '';
        const i = lists[key].findIndex((c) => c.id === o.id);
        lists[key].splice(o.pos === 'below' ? i + 1 : i, 0, moving);
      } else if (o.kind === 'category') {
        // Em cima do nome da categoria: entra como o primeiro canal dela.
        lists[o.id]?.unshift(moving);
      } else {
        lists[''].push(moving);
      }
    }

    const order = [
      ...lists[''].map((c) => ({ id: c.id, categoryId: null as string | null })),
      ...catIds.flatMap((k) => (lists[k] ?? []).map((c) => ({ id: c.id, categoryId: k as string | null }))),
    ];
    // Atualiza na hora; o servidor confirma e manda para todo mundo.
    order.forEach((x, i) => {
      const c = allChannels[x.id];
      if (c && (c.position !== i || c.categoryId !== x.categoryId)) actions.upsertChannel({ ...c, position: i, categoryId: x.categoryId });
    });
    catIds.forEach((id, i) => {
      const k = allCategories[id];
      if (k && k.position !== i) actions.upsertCategory({ ...k, position: i });
    });
    void (async () => {
      const { api } = await import('@/lib/api');
      await api.setChannelLayout(serverId, catIds, order).catch(showError);
    })();
  };

  const renderChannel = (c: Channel) => {
    const active = c.id === activeId;
    const muted = isChannelMuted(st, c.id);
    if (muted && hideMuted && !active) return null;
    const hasUnread = !!unread[c.id] && !active && !isMutedAnywhere(st, c.id);
    const mentions = active ? 0 : mentionCount(st, c.id);
    const Icon = channelIcon(c);
    return (
      <div key={c.id}>
        <div
          className={cx('group relative', drag?.id === c.id && 'opacity-40')}
          onContextMenu={(e) => openContextMenu(e, channelMenu(c, canChannels, hasPerm(perms, Perm.CreateInvite)))}
          draggable={canChannels}
          onDragStart={(e) => startDrag(e, 'channel', c.id)}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            e.stopPropagation();
            if (drag.kind === 'category') {
              // Categoria arrastada sobre um canal: cai depois da categoria desse canal.
              if (c.categoryId) setOver({ kind: 'category', id: c.categoryId, pos: 'below' });
              return;
            }
            setOver({ kind: 'channel', id: c.id, pos: half(e) });
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            drop();
          }}
        >
          {over?.kind === 'channel' && over.id === c.id && drag?.kind === 'channel' && drag.id !== c.id && (
            <span className={cx('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-accent', over.pos === 'above' ? '-top-px' : '-bottom-px')} />
          )}
          <button
            onClick={() => {
              actions.goServer(serverId, c.id);
              mobile.showMain();
              if (c.type === 'voice' && useVoice.getState().channelId !== c.id) void joinVoice(c.id);
            }}
            onDoubleClick={() => canChannels && actions.openModal({ kind: 'edit-channel', channelId: c.id })}
            className={cx(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[15px]',
              active ? 'bg-hover text-fg' : hasUnread ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-soft',
              muted && !active && 'opacity-50 hover:opacity-80',
            )}
          >
            <span className="relative shrink-0">
              {/* O sub-ícone (cadeado/olho) recorta o ícone com máscara, sem fundo próprio:
                  assim acompanha o hover e o canal ativo. */}
              <span
                className="block"
                style={c.isPrivate && (c.base || c.type !== 'text' || c.nsfw) ? { mask: SUB_ICON_MASK, WebkitMask: SUB_ICON_MASK } : undefined}
              >
                <Icon size={18} className="block opacity-70" />
              </span>
              {c.isPrivate && (c.base || c.type !== 'text' || c.nsfw) && (
                <span className="absolute -top-1 -right-1 rounded-full p-px opacity-70" title={c.base ? 'Escondido: só você e os administradores veem' : 'Canal privado'}>
                  {c.base ? <Icons.EyeOff size={9} /> : <Icons.Lock size={9} />}
                </span>
              )}
            </span>
            <span className={cx('truncate', hasUnread && 'font-semibold', canChannels && 'group-hover:pr-5')}>{c.type === 'thread' ? withoutCardCodes(mentionsToText(c.name, c.serverId)) : c.name}</span>
            {muted && <MutedIcon className={cx(canChannels && 'group-hover:hidden')} />}
            {mentions > 0 && <MentionBadge count={mentions} className={cx('ml-auto', canChannels && 'group-hover:hidden')} />}
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
              title="Editar canal"
              onClick={() => actions.openModal({ kind: 'edit-channel', channelId: c.id })}
              className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 text-muted group-hover:block hover:text-fg"
            >
              <Icons.Settings size={14} />
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
            className="absolute z-30 max-md:top-13 max-md:right-2 max-md:left-2 md:top-13 md:left-[calc(100%-2.5rem)] md:w-56 space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-xl"
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
            <MenuItem
              icon={<Icons.Bell size={16} />}
              onClick={() => actions.openModal({ kind: 'notify-settings', serverId })}
              close={() => setMenuOpen(false)}
            >
              Configurações de notificação
            </MenuItem>
            {isServerMuted(useLine.getState(), serverId) ? (
              <MenuItem icon={<Icons.Bell size={16} />} onClick={() => unmuteServer(serverId)} close={() => setMenuOpen(false)}>
                Reativar servidor
              </MenuItem>
            ) : (
              <MenuItem icon={<Icons.BellOff size={16} />} onClick={() => muteServer(serverId, null)} close={() => setMenuOpen(false)}>
                Silenciar servidor
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
                  if (!(await confirmDialog({ title: `Sair de ${server.name}`, message: 'Você pode voltar depois com um convite.', confirmLabel: 'Sair', danger: true }))) return;
                  const { api } = await import('@/lib/api');
                  await api.leaveServer(serverId).catch(showError);
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
        {(loose.length > 0 || drag?.kind === 'channel') && (
          <div
            className={cx('space-y-0.5', !loose.length && 'rounded-md border border-dashed px-2 py-1.5 text-xs text-muted', over?.kind === 'loose' ? 'border-accent' : 'border-edge')}
            onDragOver={(e) => {
              if (drag?.kind !== 'channel') return;
              e.preventDefault();
              setOver({ kind: 'loose', id: '', pos: 'below' });
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop();
            }}
          >
            {loose.length ? loose.map(renderChannel) : 'Solte aqui para tirar da categoria'}
          </div>
        )}
        {categories.filter((cat) => canChannels || byCategory[cat.id]?.length).map((cat) => (
          <div key={cat.id} className={cx('relative', drag?.id === cat.id && 'opacity-40')}>
            {over?.kind === 'category' && over.id === cat.id && drag?.kind === 'category' && drag.id !== cat.id && (
              <span className={cx('pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded bg-accent', over.pos === 'above' ? '-top-2' : '-bottom-2')} />
            )}
            <div
              className={cx(
                'group flex items-center justify-between rounded px-1 pb-1',
                over?.kind === 'category' && over.id === cat.id && drag?.kind === 'channel' && 'bg-accent/15',
              )}
              draggable={canChannels}
              onDragStart={(e) => startDrag(e, 'category', cat.id)}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                setOver({ kind: 'category', id: cat.id, pos: half(e) });
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop();
              }}
            >
              <button
                onClick={() => setCollapsed((c) => ({ ...c, [cat.id]: !c[cat.id] }))}
                onDoubleClick={() => canChannels && actions.openModal({ kind: 'edit-category', categoryId: cat.id })}
                className="flex items-center gap-0.5 text-xs font-bold tracking-wide text-muted uppercase hover:text-soft"
              >
                <Icons.Chevron size={12} className={cx('transition-transform', collapsed[cat.id] && '-rotate-90')} />
                {cat.isPrivate && (cat.base ? <Icons.EyeOff size={10} className="mr-0.5" /> : <Icons.Lock size={10} className="mr-0.5" />)}
                {cat.name}
              </button>
              {canChannels && (
                <span className="flex items-center gap-1.5">
                  <button
                    title="Editar categoria"
                    onClick={() => actions.openModal({ kind: 'edit-category', categoryId: cat.id })}
                    className="hidden text-muted group-hover:block hover:text-fg"
                  >
                    <Icons.Settings size={13} />
                  </button>
                  {!cat.base && (
                    <button
                      title="Criar canal"
                      onClick={() => actions.openModal({ kind: 'create-channel', serverId, categoryId: cat.id })}
                      className="text-muted hover:text-fg"
                    >
                      <Icons.Plus size={16} />
                    </button>
                  )}
                </span>
              )}
            </div>
            {collapsed[cat.id] ? (
              // Recolhida: o canal aberto continua à vista; os de voz com gente, em uma linha de avatares.
              <div className="space-y-0.5">
                {(byCategory[cat.id] ?? [])
                  .filter((c) => c.type === 'voice' || c.id === activeId)
                  .map((c) =>
                    c.type !== 'voice' ? (
                      renderChannel(c)
                    ) : (
                    <CollapsedVoiceChannel
                      key={c.id}
                      channel={c}
                      active={c.id === activeId}
                      onOpen={() => {
                        actions.goServer(serverId, c.id);
                        mobile.showMain();
                        if (useVoice.getState().channelId !== c.id) void joinVoice(c.id);
                      }}
                    />
                    ),
                  )}
              </div>
            ) : (
              <div className="space-y-0.5">{(byCategory[cat.id] ?? []).map(renderChannel)}</div>
            )}
          </div>
        ))}
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
      disabled: !s.unread[c.id] && !s.mentionCounts[c.id],
      onClick: () => actions.markRead(c.id),
    },
    c.type !== 'voice' && 'sep',
    ...(c.type !== 'voice' ? channelNotifyItems(c.id) : []),
    c.type === 'voice' &&
      (inThis
        ? { label: 'Sair da chamada', icon: <Icons.PhoneOff size={15} />, danger: true, onClick: () => leaveVoice() }
        : {
            label: 'Entrar na chamada',
            icon: <Icons.Phone size={15} />,
            onClick: () => {
              actions.goServer(c.serverId!, c.id);
              mobile.showMain();
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
      label: 'Editar canal',
      icon: <Icons.Settings size={15} />,
      onClick: () => actions.openModal({ kind: 'edit-channel', channelId: c.id }),
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
