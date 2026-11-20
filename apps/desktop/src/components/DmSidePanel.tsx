'use client';

import type { Channel, PublicUser } from '@line/shared';
import { create } from 'zustand';
import { StyledName } from '@/lib/nameStyle';
import { actions, useLine } from '@/lib/store';
import { joinVoice, toggleCamera, useVoice } from '@/lib/voice';
import { openContextMenu, userMenu } from './ContextMenu';
import { PinsButton } from './Pins';
import { SearchBox, SearchResults } from './SearchPanel';
import { UserCard } from './UserCard';
import { Avatar, cx, Icons } from './ui';

const KEY = 'line:dm-panel';
function loadOpen() {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** Coluna da direita das conversas diretas: aberta por padrão, e a busca que aparece no lugar dela. */
export const useDmPanel = create<{ open: boolean; query: { channelId: string; text: string } | null }>(() => ({
  open: typeof window === 'undefined' ? true : loadOpen(),
  query: null,
}));

function toggleOpen() {
  const open = !useDmPanel.getState().open;
  useDmPanel.setState({ open });
  try {
    localStorage.setItem(KEY, open ? '1' : '0');
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
}

const btn = 'rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg';

/** Botões do topo da conversa direta: ligar, câmera, fixadas, adicionar pessoa, perfil/membros e busca. */
export function DmHeaderActions({ channel }: { channel: Channel }) {
  const meId = useLine((s) => s.me?.id);
  const inCall = useVoice((v) => v.channelId === channel.id);
  const open = useDmPanel((p) => p.open);
  const searching = useDmPanel((p) => p.query?.channelId === channel.id);
  const isGroup = channel.type === 'group_dm';
  const others = (channel.recipients ?? []).filter((r) => r.id !== meId).map((r) => r.id);
  return (
    <div className="flex items-center gap-1">
      {!inCall && (
        <>
          <button title="Ligar" onClick={() => joinVoice(channel.id)} className={btn}>
            <Icons.Phone size={20} />
          </button>
          <button
            title="Ligar com câmera"
            onClick={async () => {
              await joinVoice(channel.id);
              if (useVoice.getState().channelId === channel.id && !useVoice.getState().camera) await toggleCamera();
            }}
            className={btn}
          >
            <Icons.Video size={20} />
          </button>
        </>
      )}
      <PinsButton channel={channel} canPin />
      <button title="Adicionar pessoas à conversa" onClick={() => actions.openModal({ kind: 'new-dm', base: others })} className={btn}>
        <Icons.UserPlus size={20} />
      </button>
      <button
        title={open ? (isGroup ? 'Esconder membros' : 'Esconder perfil') : isGroup ? 'Mostrar membros' : 'Mostrar perfil'}
        onClick={toggleOpen}
        className={cx(btn, 'max-lg:hidden', open && !searching && 'text-fg')}
      >
        {isGroup ? <Icons.Users size={20} /> : <Icons.CircleUser size={20} />}
      </button>
      <div className="w-56 max-lg:hidden">
        <SearchBox
          key={channel.id}
          dm={channel}
          active={searching}
          onSearch={(text) => useDmPanel.setState({ query: { channelId: channel.id, text } })}
          onClear={() => useDmPanel.setState({ query: null })}
        />
      </div>
    </div>
  );
}

/** Coluna da direita: cartão da pessoa (1:1), membros (grupo) ou resultados da busca. */
export function DmSidePanel({ channel }: { channel: Channel }) {
  const open = useDmPanel((p) => p.open);
  const query = useDmPanel((p) => (p.query?.channelId === channel.id ? p.query.text : null));
  const meId = useLine((s) => s.me?.id);
  if (!query && !open) return null;
  const isGroup = channel.type === 'group_dm';
  const otherId = !isGroup ? channel.recipients?.find((r) => r.id !== meId)?.id : undefined;
  return (
    <aside className={cx('hidden shrink-0 flex-col border-l border-rail bg-side lg:flex', query ? 'w-[420px]' : 'w-[356px]')}>
      {query ? (
        <>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
            <h2 className="font-bold">Resultados</h2>
            <button title="Fechar" onClick={() => useDmPanel.setState({ query: null })} className={cx(btn, 'ml-auto')}>
              <Icons.X size={18} />
            </button>
          </div>
          <SearchResults key={query} channelId={channel.id} query={query} />
        </>
      ) : isGroup ? (
        <GroupMembers channel={channel} />
      ) : otherId ? (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <UserCard key={otherId} userId={otherId} inline onClose={() => {}} />
        </div>
      ) : null}
    </aside>
  );
}

/** Membros do grupo; clicar em alguém abre o cartão, igual à lista de membros do servidor. */
function GroupMembers({ channel }: { channel: Channel }) {
  const users = useLine((s) => s.users);
  const me = useLine((s) => s.me);
  const list = (channel.recipients ?? [])
    .map((r): PublicUser => (r.id === me?.id ? me : users[r.id] ?? r))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
  const others = list.filter((u) => u.id !== me?.id).map((u) => u.id);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
      <h3 className="px-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Membros — {list.length}</h3>
      {list.map((u) => (
        <button
          key={u.id}
          onClick={(e) => actions.openModal({ kind: 'user', userId: u.id, at: { x: e.clientX, y: e.clientY } })}
          onContextMenu={(e) => openContextMenu(e, userMenu(u.id, { x: e.clientX, y: e.clientY }))}
          className={cx('flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover', u.presence === 'offline' && 'opacity-40 hover:opacity-100')}
        >
          <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={32} presence={u.presence} />
          <span className="min-w-0">
            <StyledName user={u} className="block truncate text-[15px] font-medium">
              {u.displayName}
            </StyledName>
            {u.customStatus && <span className="block truncate text-xs text-muted">{u.customStatus}</span>}
          </span>
        </button>
      ))}
      <button
        onClick={() => actions.openModal({ kind: 'new-dm', base: others })}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-edge bg-main/60 px-3 py-2 text-sm font-semibold text-soft hover:bg-hover hover:text-fg"
      >
        <Icons.UserPlus size={16} /> Adicionar pessoas
      </button>
    </div>
  );
}
