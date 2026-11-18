'use client';

import { mobile } from '@/lib/mobile';

import { hasPerm, Perm, type FavoriteSong, type PublicUser, type Role, type Server, type UserStatus } from '@line/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, useServerLook, displayNameIn, permsOf, topPosition, useLine, useMemberColor } from '@/lib/store';
import { joinVoice, useVoice } from '@/lib/voice';
import { Avatar, Button, cx, DefaultServerIcon, ErrorText, Icons, Modal, presenceLabel } from './ui';
import { UserTagBadge } from './ServerTag';
import { EmojiButton } from './EmojiField';
import { StatusPicker } from './StatusPicker';
import { confirmDialog } from './Dialogs';
import { StyledName } from '@/lib/nameStyle';
import { SongPlayer } from './ProfileExtras';
import { cardStyle } from './InlineProfileEdit';
import { MoreMenu } from './FullProfile';
import { useIgnored } from '@/lib/ignored';

export { statusOptions } from './StatusPicker';

const W = 340;

/** Mini cartão de perfil que abre ao clicar em alguém (ou na sua própria caixa de usuário). */
export function UserCard({
  userId,
  at,
  hover,
  onClose,
}: {
  userId: string;
  at?: { x: number; y: number; above?: boolean };
  /** Aberto ao passar o mouse numa menção: sem fundo bloqueando a tela, fecha ao tirar o mouse. */
  hover?: boolean;
  onClose: () => void;
}) {
  const me = useLine((s) => s.me);
  const other = useLine((s) => s.users[userId]);
  const friend = useLine((s) => s.friends[userId]);
  const isMe = me?.id === userId;
  const user: PublicUser | undefined = isMe ? me ?? undefined : other;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [mutual, setMutual] = useState<{ friends: PublicUser[]; servers: Server[] } | null>(null);
  const [text, setText] = useState('');
  const dmRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [song, setSong] = useState<FavoriteSong | null>(null);
  const [cardColors, setCardColors] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  // Nome na cor do cargo mais alto no servidor aberto, igual à lista de membros.
  const viewServer = useViewServer();
  const look = useServerLook(viewServer, userId);
  const ignored = useIgnored((s) => s.ids.includes(userId));
  const [editMenu, setEditMenu] = useState(false);
  const roleColor = useMemberColor(viewServer, userId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (isMe) return;
    api
      .mutual(userId)
      .then(setMutual)
      .catch(() => setMutual({ friends: [], servers: [] }));
  }, [userId, isMe]);

  useEffect(() => {
    api.profile(userId).then(
      (p) => {
        setSong(p.favoriteSong ?? null);
        setCardColors(p.cardColors ?? null);
      },
      () => {},
    );
  }, [userId]);

  // Posiciona perto do clique sem sair da tela.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 400;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!at) return setPos({ left: (vw - W) / 2, top: Math.max(12, (vh - h) / 2) });
    // Ancorado em cima de um elemento (a caixa do usuário): abre logo acima dele.
    if (at.above) return setPos({ left: Math.min(Math.max(12, at.x), vw - W - 12), top: Math.max(12, at.y - h - 8) });
    const left = at.x + 16 + W < vw ? at.x + 16 : Math.max(12, at.x - 16 - W);
    const top = Math.min(Math.max(12, at.y - 40), vh - h - 12);
    setPos({ left, top: Math.max(12, top) });
  }, [at, mutual, menu, song]);

  if (!user || !me) return null;
  const state = friend?.state;
  const bannerUrl = look.bannerUrl ?? user.bannerUrl;
  const banner = bannerUrl ? fileUrl(bannerUrl) : null;
  const shownName = look.nickname || user.displayName;
  const shownBio = look.bio ?? user.bio;
  /** Cor do cartão (nome, borda do avatar e anel do status). */
  const nameColor = user.botStyle?.nameColor ?? roleColor ?? 'var(--color-fg)';
  // Anel em volta do avatar e da bolinha: cor escura do tema (o fundo do cartão), como um recorte.
  const ring = `color-mix(in srgb, ${user.avatarColor} 22%, var(--color-rail))`;
  const presence = isMe ? (me.status === 'invisible' ? 'offline' : me.presence === 'offline' ? 'online' : me.presence) : user.presence;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openDm(message?: string) {
    const dm = await api.openDm([userId]);
    actions.upsertChannel(dm);
    if (message) actions.addMessage(await api.sendMessage(dm.id, message, []));
    actions.goHome(dm.id);
    onClose();
  }

  async function setStatus(status: UserStatus, minutes?: number) {
    await run(async () => actions.setMe(await api.updateMe({ status, statusMinutes: minutes })));
  }

  return (
    <div className={cx('fixed inset-0 z-50', hover && 'pointer-events-none')} onMouseDown={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-label={user.displayName}
        onMouseDown={(e) => {
          e.stopPropagation();
          // Clicou dentro do cartão: ele passa a ficar aberto como um clique normal.
          if (hover) hoverCard.pin();
        }}
        onMouseEnter={hover ? hoverCard.cancel : undefined}
        onMouseLeave={hover ? hoverCard.leave : undefined}
        className="pointer-events-auto fixed overflow-hidden rounded-2xl border border-edge shadow-2xl"
        style={{
          width: W,
          left: pos?.left ?? -9999,
          top: pos?.top ?? 0,
          ...(cardColors?.length
            ? cardStyle(cardColors, user.avatarColor)
            : { background: `linear-gradient(to bottom, color-mix(in srgb, ${user.avatarColor} 30%, var(--color-rail)), var(--color-rail) 60%)` }),
        }}
      >
        {/* Banner com ações no canto */}
        <div className="relative h-[105px]" style={banner ? undefined : { background: user.avatarColor }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
          <div className="absolute top-2.5 right-2.5 flex gap-1.5">
            {!isMe && !user.bot && !state && (
              <TopButton title="Adicionar amigo" onClick={() => run(async () => actions.upsertFriend(await api.addFriend(user.username)))}>
                <Icons.UserPlus size={17} />
              </TopButton>
            )}
            {!isMe && state === 'incoming' && (
              <TopButton title="Aceitar pedido de amizade" onClick={() => run(async () => actions.upsertFriend(await api.acceptFriend(userId)))}>
                <Icons.UserCheck size={17} />
              </TopButton>
            )}
            {!isMe && state === 'outgoing' && (
              <TopButton title="Pedido enviado" disabled>
                <Icons.Clock size={17} />
              </TopButton>
            )}
            {isMe ? (
              <span className="relative">
                <TopButton
                  title="Editar perfil"
                  onClick={() => {
                    if (viewServer) return setEditMenu((v) => !v);
                    onClose();
                    actions.openModal({ kind: 'settings', section: 'profile' });
                  }}
                >
                  <Icons.Edit size={17} />
                </TopButton>
                {editMenu && viewServer && (
                  <div className="absolute top-full right-0 z-10 mt-1.5 w-64 rounded-xl border border-edge bg-rail p-1.5 shadow-2xl">
                    <button
                      onClick={() => actions.openModal({ kind: 'server-profile', serverId: viewServer })}
                      className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-hover"
                    >
                      <span className="block text-sm font-semibold">Editar perfil por servidor</span>
                      <span className="block text-xs text-muted">Visível apenas para este servidor</span>
                    </button>
                    <button
                      onClick={() => actions.openModal({ kind: 'settings', section: 'profile' })}
                      className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-hover"
                    >
                      <span className="block text-sm font-semibold">Editar o Perfil Principal</span>
                      <span className="block text-xs text-muted">Perfil padrão e visível para todos</span>
                    </button>
                  </div>
                )}
              </span>
            ) : user.bot ? null : (
            <span className="relative">
              <TopButton title="Mais" onClick={() => setMenu((v) => !v)}>
                <Icons.More size={17} />
              </TopButton>
              {menu && (
                <MoreMenu
                  user={user}
                  nickname={null}
                  main={false}
                  onMain={() => {}}
                  onFullProfile={() => actions.openModal({ kind: 'full-profile', userId, serverId: viewServer })}
                  ignored={ignored}
                  blocked={state === 'blocked'}
                  onClose={() => setMenu(false)}
                  align="right"
                />
              )}
            </span>
            )}
          </div>
        </div>

        <div className="px-4 pb-4">
          {/* Avatar + balão de pensamento */}
          <div className="relative z-[5] -mt-12 flex items-start gap-2">
            {/* Borda de 4px na cor do fundo do cartão (recorte), sem sombra; flex evita o vão da linha de texto. */}
            <button
              type="button"
              title="Ver perfil completo"
              onClick={() => actions.openModal({ kind: 'full-profile', userId, serverId: viewServer })}
              className="flex shrink-0 rounded-full border-4"
              style={{ borderColor: ring, background: ring }}
            >
              <Avatar
                name={user.displayName}
                color={user.avatarColor}
                src={look.avatarUrl ?? user.avatarUrl}
                size={88}
                presence={presence}
                dotRingColor={ring}
                dotSize={20}
                className="block"
              />
            </button>
            {user.thought && (
              <span className="relative mt-14 max-w-[190px] rounded-2xl border border-edge bg-side px-3 py-1.5 text-xs break-words text-soft shadow-lg">
                <span className="absolute top-1 -left-1.5 h-2.5 w-2.5 rounded-full border border-edge bg-side" />
                {user.thought}
              </span>
            )}
          </div>

          <p className="mt-2 flex min-w-0 items-center gap-2 text-xl leading-tight font-bold">
            <StyledName user={user} color={nameColor} className="truncate">
              {shownName}
            </StyledName>
            <UserTagBadge user={user} />
          </p>
          {/* Agente: o nome de usuário dele é um código interno, não aparece em lugar nenhum. */}
          <p className="truncate text-sm text-soft">
            {user.bot ? 'Agente do servidor' : user.username}
            {user.pronouns && <span className="text-muted"> • <span data-tip="Pronomes" style={{ cursor: 'default' }}>{user.pronouns}</span></span>}
          </p>
          {user.customStatus && <p className="mt-1.5 text-sm text-soft">{user.customStatus}</p>}

          {!isMe && mutual && (mutual.friends.length > 0 || mutual.servers.length > 0) && (
            <div className="mt-2.5 flex items-center gap-2 text-xs text-soft">
              {mutual.friends.length > 0 && (
                <span className="flex -space-x-1.5">
                  {mutual.friends.slice(0, 3).map((f) => (
                    <span key={f.id} className="rounded-full ring-2 ring-rail">
                      <Avatar name={f.displayName} color={f.avatarColor} src={f.avatarUrl} size={18} />
                    </span>
                  ))}
                </span>
              )}
              <span className="flex min-w-0 items-center gap-1">
                {mutual.friends.length > 0 && (
                  <span>{`${mutual.friends.length} ${mutual.friends.length === 1 ? 'amigo' : 'amigos'} em comum`}</span>
                )}
                {mutual.friends.length > 0 && mutual.servers.length > 0 && <span>•</span>}
                {mutual.servers.length > 0 && (
                  <button
                    type="button"
                    className="cursor-pointer hover:text-fg hover:underline"
                    onClick={() => actions.openModal({ kind: 'mutual-servers', servers: mutual.servers })}
                  >
                    {`${mutual.servers.length} ${mutual.servers.length === 1 ? 'servidor' : 'servidores'} em comum`}
                  </button>
                )}
              </span>
            </div>
          )}

          {song && (
            <div className="mt-3">
              <SongPlayer song={song} colors={cardColors} />
            </div>
          )}
          {shownBio && <p className="mt-3 max-h-60 overflow-y-auto pr-1 text-sm break-words whitespace-pre-wrap">{shownBio}</p>}

          {!isMe && <InVoice userId={userId} onClose={onClose} />}
          <MemberRoles userId={userId} />

          <ErrorText>{error}</ErrorText>

          {isMe ? (
            <div className="mt-4 space-y-2">
              <StatusPicker status={me.status} until={me.statusUntil ?? null} onPick={(st, m) => void setStatus(st, m)} />
            </div>
          ) : user.bot ? null : state === 'blocked' ? (
            <p className="mt-4 rounded-lg bg-side/70 px-3 py-2 text-sm text-muted">Você bloqueou essa pessoa.</p>
          ) : (
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void run(() => openDm(text.trim() || undefined));
              }}
            >
              <div className="relative">
                <input
                  ref={dmRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={4000}
                  placeholder={`Conversar com @${user.username}`}
                  className="w-full rounded-lg border border-edge bg-side/70 py-2.5 pr-9 pl-3 text-sm outline-none placeholder:text-muted focus:border-accent"
                />
                <EmojiButton target={dmRef} className="absolute top-1/2 right-2.5 -translate-y-1/2" />
              </div>
            </form>
          )}
          {!isMe && <p className="sr-only">{presenceLabel[user.presence]}</p>}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_ROLE_COLOR = '#99aab5';

/** Abre/fecha o cartão de perfil ao passar o mouse sobre uma @menção. */
const hoverCard = (() => {
  let openTimer: number | undefined;
  let closeTimer: number | undefined;
  const isHoverOpen = () => {
    const m = useLine.getState().modal;
    return m?.kind === 'user' && !!m.hover;
  };
  return {
    enter(userId: string, el: HTMLElement) {
      window.clearTimeout(closeTimer);
      window.clearTimeout(openTimer);
      const m = useLine.getState().modal;
      if (m && !(m.kind === 'user' && m.hover)) return; // outro modal aberto
      if (m?.kind === 'user' && m.userId === userId) return;
      openTimer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        actions.openModal({ kind: 'user', userId, at: { x: r.right, y: r.top + 40 }, hover: true });
      }, 350);
    },
    leave() {
      window.clearTimeout(openTimer);
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => isHoverOpen() && actions.closeModal(), 250);
    },
    cancel() {
      window.clearTimeout(closeTimer);
    },
    pin() {
      window.clearTimeout(closeTimer);
      const m = useLine.getState().modal;
      if (m?.kind === 'user' && m.hover) actions.openModal({ ...m, hover: false });
    },
  };
})();

/** @menção a um usuário no chat: mostra o cartão dele ao passar o mouse (ou ao clicar). */
export function UserMention({
  username,
  serverId,
  className,
  children,
}: {
  username: string;
  /** Em canal de servidor, mostra @apelido (ou nome de exibição) de quem é membro; em DMs fica o @username. */
  serverId?: string | null;
  className: string;
  children: ReactNode;
}) {
  const userId = useLine((s) => {
    const name = username.toLowerCase();
    if (s.me?.username.toLowerCase() === name) return s.me.id;
    return Object.values(s.users).find((u) => u.username.toLowerCase() === name)?.id;
  });
  // Membro do servidor ou agente (bot): mostra o apelido/nome, nunca o @usuário com id do agente.
  const label = useLine((s) =>
    userId && ((serverId && s.members[serverId]?.[userId]) || s.users[userId]?.bot) ? `@${displayNameIn(s, serverId, userId)}` : null,
  );
  const mentioned = useLine((s) => (userId ? (s.me?.id === userId ? s.me : s.users[userId]) : undefined));
  if (!userId) return <span className={className}>{children}</span>;
  return (
    <span
      className={cx(className, 'cursor-pointer hover:underline')}
      onMouseEnter={(e) => hoverCard.enter(userId, e.currentTarget)}
      onMouseLeave={hoverCard.leave}
      onClick={(e) => {
        hoverCard.cancel();
        const r = e.currentTarget.getBoundingClientRect();
        actions.openModal({ kind: 'user', userId, at: { x: r.right, y: r.top + 40 } });
      }}
    >
      <StyledName user={mentioned}>{label ?? children}</StyledName>
    </span>
  );
}

/** Servidor que está aberto agora (os cargos do cartão são dele). */
function useViewServer(): string | null {
  return useLine((s) => (s.view.kind === 'server' ? s.view.serverId : null));
}

/** "Em voz": canal de voz em que a pessoa está, se eu consigo ver esse canal. */
function InVoice({ userId, onClose }: { userId: string; onClose: () => void }) {
  const channelId = useVoice((v) => v.states[userId]?.channelId ?? null);
  const myChannel = useVoice((v) => v.channelId);
  const channel = useLine((s) => (channelId ? s.channels[channelId] : undefined));
  const server = useLine((s) => (channel?.serverId ? s.servers[channel.serverId] : undefined));
  const [busy, setBusy] = useState(false);
  if (!channel || !server) return null;
  const here = myChannel === channel.id;
  return (
    <div className="mt-3 rounded-xl border border-edge bg-side/70 p-3">
      <p className="text-xs font-bold text-soft">Em voz</p>
      <div className="mt-2 flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-edge bg-rail">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {server.iconUrl ? <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full object-cover" /> : <DefaultServerIcon />}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 truncate text-sm font-semibold">
            <Icons.Speaker size={14} className="shrink-0 text-muted" />
            <span className="truncate">{channel.name}</span>
          </span>
          <span className="block truncate text-xs text-muted">em {server.name}</span>
        </span>
      </div>
      <Button
        variant="subtle"
        className="mt-3 w-full"
        disabled={here || busy}
        onClick={async () => {
          setBusy(true);
          try {
            actions.goServer(server.id, channel.id);
            mobile.showMain();
            await joinVoice(channel.id);
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        {here ? 'Você já está nessa chamada' : 'Entrar na chamada de voz'}
      </Button>
    </div>
  );
}

/** Tags de cargos da pessoa no servidor aberto, com + e x para quem pode gerenciar cargos. */
/** Se a lista de cargos tem algo para mostrar: cargos da pessoa ou o "+" de quem pode dar cargos. */
export function useHasMemberRoles(userId: string, serverId: string): boolean {
  return useLine((s) => {
    const member = s.members[serverId]?.[userId];
    const roles = s.roles[serverId];
    if (!member || !roles) return false;
    if (roles.some((r) => r.id !== serverId && member.roleIds.includes(r.id))) return true;
    if (!hasPerm(permsOf(s, serverId, s.me?.id), Perm.ManageRoles)) return false;
    const myTop = topPosition(s, serverId, s.me?.id);
    return roles.some((r) => r.id !== serverId && r.position < myTop && !member.roleIds.includes(r.id));
  });
}

export function MemberRoles({ userId, serverId: fixed }: { userId: string; serverId?: string | null }) {
  const viewServer = useViewServer();
  const serverId = fixed !== undefined ? fixed : viewServer;
  const member = useLine((s) => (serverId ? s.members[serverId]?.[userId] : undefined));
  const roles = useLine((s) => (serverId ? s.roles[serverId] : undefined));
  const canRoles = useLine((s) => hasPerm(permsOf(s, serverId, s.me?.id), Perm.ManageRoles));
  const myTop = useLine((s) => (serverId ? topPosition(s, serverId, s.me?.id) : 0));
  const [picker, setPicker] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const [error, setError] = useState('');
  if (!serverId || !member || !roles) return null;
  const mine = roles.filter((r) => r.id !== serverId && member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position);
  const assignable = roles.filter((r) => r.id !== serverId && r.position < myTop && !member.roleIds.includes(r.id));
  const canAdd = canRoles && assignable.length > 0;
  if (mine.length === 0 && !canAdd) return null;

  async function toggle(roleId: string, on: boolean) {
    setError('');
    try {
      actions.upsertMember(await api.setMemberRole(serverId!, userId, roleId, on));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {mine.map((r) => (
          <span key={r.id} className="flex items-center gap-1.5 rounded-md border border-edge bg-side py-0.5 pr-1.5 pl-2 text-xs font-medium">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color ?? DEFAULT_ROLE_COLOR }} />
            {r.name}
            {canRoles && r.position < myTop && (
              <button title="Tirar cargo" onClick={() => void toggle(r.id, false)} className="text-muted hover:text-danger">
                <Icons.X size={12} />
              </button>
            )}
          </span>
        ))}
        {canAdd && (
          <span className="relative">
            <button
              title="Dar cargo"
              onClick={(e) => {
                anchor.current = e.currentTarget;
                setPicker((v) => !v);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-edge bg-side text-muted hover:text-fg"
            >
              <Icons.Plus size={13} />
            </button>
            {picker && <RolePicker anchor={anchor.current} roles={assignable} onPick={(id) => {
              setPicker(false);
              void toggle(id, true);
            }} onClose={() => setPicker(false)} />}
          </span>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Lista de cargos para dar, com busca "Cargo" no topo. */
function RolePicker({ anchor, roles, onPick, onClose }: { anchor: HTMLElement | null; roles: Role[]; onPick: (id: string) => void; onClose: () => void }) {
  // Fica fixo na tela (por cima do cartão, que corta o que passa da borda); abre para cima se não couber embaixo.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    const h = box.current?.offsetHeight ?? 300;
    if (!r) return;
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - 6 - h) : below;
    setPos({ left: Math.min(r.left, window.innerWidth - 248), top });
  }, [anchor]);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);
  const q = text.trim().toLowerCase();
  const list = [...roles].sort((a, b) => b.position - a.position).filter((r) => !q || r.name.toLowerCase().includes(q));
  return (
    <div ref={box} style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }} className="fixed z-[70] w-60 rounded-lg border border-edge bg-rail p-1.5 shadow-2xl">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && list[0] && onPick(list[0].id)}
        placeholder="Cargo"
        className="mb-1 w-full rounded-md border border-accent bg-side px-2.5 py-2 text-sm outline-none placeholder:text-muted"
      />
      <div className="max-h-56 overflow-y-auto">
        {list.map((r) => (
          <button
            key={r.id}
            onClick={() => onPick(r.id)}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm font-medium text-soft hover:bg-hover hover:text-fg"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color ?? DEFAULT_ROLE_COLOR }} />
            <span className="truncate">{r.name}</span>
          </button>
        ))}
        {!list.length && <p className="px-2.5 py-2 text-sm text-muted">Nenhum cargo encontrado.</p>}
      </div>
    </div>
  );
}

function TopButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cx(
        'flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-black/75 disabled:opacity-60',
        className,
      )}
    />
  );
}

function MenuItem({ icon, danger, onClick, children }: { icon: ReactNode; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx('flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm', danger ? 'text-danger hover:bg-danger/10' : 'text-soft hover:bg-hover hover:text-fg')}
    >
      {icon}
      {children}
    </button>
  );
}

/** Lista dos servidores em comum (aberta pelo "N servidores em comum" do cartão). Mostra até 8, depois rola. */
export function MutualServersModal({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  return (
    <Modal title="Servidores em comum" onClose={onClose} width={420} fixedBody>
      {/* 8 cartões de 60px + 7 espaços de 8px = 536px; acima disso a lista rola e o título fica parado. */}
      <div className="-mr-2 min-h-0 overflow-y-auto pr-2" style={{ maxHeight: 536 }}>
        <div className="flex flex-col gap-2">
          {servers.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onClose();
                actions.goServer(s.id);
              }}
              className="group relative flex h-[60px] shrink-0 items-center gap-3 overflow-hidden rounded-xl border border-edge bg-raise px-3 text-left hover:border-accent/60 hover:bg-hover"
            >
              {s.bannerUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(s.bannerUrl)} alt="" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-15" />
              )}
              <span
                className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-rail"
              >
                {s.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl(s.iconUrl)} alt="" className="h-full w-full object-cover" />
                ) : (
                  <DefaultServerIcon />
                )}
              </span>
              <span className="relative min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{s.name}</span>
                <span className="block truncate text-xs text-soft">
                  {s.memberCount} {s.memberCount === 1 ? 'membro' : 'membros'}
                </span>
              </span>
              <Icons.ChevronRight size={16} className="relative shrink-0 text-muted group-hover:text-fg" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
