'use client';

import type { PublicUser, Server, UserStatus } from '@line/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { Avatar, Button, cx, ErrorText, Icons, PresenceDot, presenceLabel } from './ui';

export const statusOptions: { value: UserStatus; label: string; hint?: string; presence: 'online' | 'idle' | 'dnd' | 'offline' }[] = [
  { value: 'online', label: 'Disponível', presence: 'online' },
  { value: 'idle', label: 'Ausente', presence: 'idle' },
  { value: 'dnd', label: 'Não perturbe', hint: 'Você não vai receber notificações', presence: 'dnd' },
  { value: 'invisible', label: 'Invisível', hint: 'Você aparece offline, mas usa tudo normalmente', presence: 'offline' },
];

const W = 340;

/** Mini cartão de perfil que abre ao clicar em alguém (ou na sua própria caixa de usuário). */
export function UserCard({ userId, at, onClose }: { userId: string; at?: { x: number; y: number; above?: boolean }; onClose: () => void }) {
  const me = useLine((s) => s.me);
  const other = useLine((s) => s.users[userId]);
  const friend = useLine((s) => s.friends[userId]);
  const isMe = me?.id === userId;
  const user: PublicUser | undefined = isMe ? me ?? undefined : other;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [mutual, setMutual] = useState<{ friends: PublicUser[]; servers: Server[] } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

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
  }, [at, statusOpen, mutual, menu]);

  if (!user || !me) return null;
  const state = friend?.state;
  const banner = user.bannerUrl ? fileUrl(user.bannerUrl) : null;
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

  async function setStatus(status: UserStatus) {
    setStatusOpen(false);
    await run(async () => actions.setMe(await api.updateMe({ status })));
  }

  const current = statusOptions.find((o) => o.value === me.status) ?? statusOptions[0]!;

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-label={user.displayName}
        onMouseDown={(e) => e.stopPropagation()}
        className="fixed overflow-hidden rounded-2xl border border-edge shadow-2xl"
        style={{
          width: W,
          left: pos?.left ?? -9999,
          top: pos?.top ?? 0,
          background: `linear-gradient(to bottom, color-mix(in srgb, ${user.avatarColor} 30%, var(--color-rail)), var(--color-rail) 60%)`,
        }}
      >
        {/* Banner com ações no canto */}
        <div className="relative h-[105px]" style={banner ? undefined : { background: user.avatarColor }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
          <div className="absolute top-2.5 right-2.5 flex gap-1.5">
            {!isMe && !state && (
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
            <span className="relative">
              <TopButton title="Mais" onClick={() => setMenu((v) => !v)}>
                <Icons.More size={17} />
              </TopButton>
              {menu && (
                <div className="absolute top-full right-0 z-10 mt-1.5 w-52 rounded-lg border border-edge bg-side p-1 shadow-xl">
                  <MenuItem
                    icon={<Icons.Copy size={16} />}
                    onClick={() => {
                      void navigator.clipboard?.writeText(user.username);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? 'Copiado!' : 'Copiar nome de usuário'}
                  </MenuItem>
                  {!isMe && state === 'friends' && (
                    <MenuItem
                      danger
                      icon={<Icons.UserMinus size={16} />}
                      onClick={() => confirm(`Desfazer amizade com ${user.displayName}?`) && run(() => api.removeFriend(userId))}
                    >
                      Desfazer amizade
                    </MenuItem>
                  )}
                  {!isMe && state !== 'blocked' && (
                    <MenuItem
                      danger
                      icon={<Icons.Ban size={16} />}
                      onClick={() => confirm(`Bloquear ${user.displayName}?`) && run(async () => actions.upsertFriend(await api.blockUser(userId)))}
                    >
                      Bloquear
                    </MenuItem>
                  )}
                  {!isMe && state === 'blocked' && (
                    <MenuItem
                      icon={<Icons.Ban size={16} />}
                      onClick={() =>
                        run(async () => {
                          await api.unblockUser(userId);
                          actions.removeFriend(userId);
                        })
                      }
                    >
                      Desbloquear
                    </MenuItem>
                  )}
                </div>
              )}
            </span>
          </div>
        </div>

        <div className="px-4 pb-4">
          {/* Avatar + balão de pensamento */}
          <div className="-mt-12 flex items-start gap-2">
            <span className="shrink-0 rounded-full border-[5px] border-rail bg-rail">
              <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={88} presence={presence} ring="rail" dotSize={20} />
            </span>
            {user.thought && (
              <span className="relative mt-14 max-w-[190px] rounded-2xl border border-edge bg-side px-3 py-1.5 text-xs break-words text-soft shadow-lg">
                <span className="absolute top-1 -left-1.5 h-2.5 w-2.5 rounded-full border border-edge bg-side" />
                {user.thought}
              </span>
            )}
          </div>

          <p className="mt-2 truncate text-xl leading-tight font-bold" style={{ color: `color-mix(in srgb, ${user.avatarColor} 75%, var(--color-fg))` }}>
            {user.displayName}
          </p>
          <p className="truncate text-sm text-soft">
            {user.username}
            {user.pronouns && <span className="text-muted"> • {user.pronouns}</span>}
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
              <span>
                {[
                  mutual.friends.length && `${mutual.friends.length} ${mutual.friends.length === 1 ? 'amigo' : 'amigos'} em comum`,
                  mutual.servers.length && `${mutual.servers.length} ${mutual.servers.length === 1 ? 'servidor' : 'servidores'} em comum`,
                ]
                  .filter(Boolean)
                  .join(' • ')}
              </span>
            </div>
          )}

          {user.bio && <p className="mt-3 line-clamp-4 text-sm break-words whitespace-pre-wrap">{user.bio}</p>}

          <ErrorText>{error}</ErrorText>

          {isMe ? (
            <div className="mt-4 space-y-2">
              <div className="rounded-lg border border-edge bg-side/70">
                <button
                  onClick={() => setStatusOpen((v) => !v)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-hover"
                >
                  <PresenceDot presence={current.presence} ring="side" />
                  <span className="flex-1 font-medium">{current.label}</span>
                  <Icons.Chevron size={16} className={cx('text-muted transition-transform', statusOpen && 'rotate-180')} />
                </button>
                {statusOpen && (
                  <div className="border-t border-edge p-1">
                    {statusOptions.map((o) => (
                      <button
                        key={o.value}
                        onClick={() => void setStatus(o.value)}
                        className={cx('flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent/10', me.status === o.value && 'bg-accent/15')}
                      >
                        <PresenceDot presence={o.presence} ring="side" className="mt-1.5 shrink-0" />
                        <span>
                          <span className="block text-sm">{o.label}</span>
                          {o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button
                variant="subtle"
                className="w-full"
                onClick={() => {
                  onClose();
                  actions.openModal({ kind: 'settings', section: 'profile' });
                }}
              >
                <Icons.Edit size={16} /> Editar perfil
              </Button>
            </div>
          ) : state === 'blocked' ? (
            <p className="mt-4 rounded-lg bg-side/70 px-3 py-2 text-sm text-muted">Você bloqueou essa pessoa.</p>
          ) : (
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void run(() => openDm(text.trim() || undefined));
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={4000}
                placeholder={`Conversar com @${user.username}`}
                className="w-full rounded-lg border border-edge bg-side/70 px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-accent"
              />
            </form>
          )}
          {!isMe && <p className="sr-only">{presenceLabel[user.presence]}</p>}
        </div>
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
