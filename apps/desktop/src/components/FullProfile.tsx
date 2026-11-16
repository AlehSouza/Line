'use client';

import type { PublicUser, Server, UserProfile } from '@line/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileUrl } from '@/lib/api';
import { setIgnored, useIgnored } from '@/lib/ignored';
import { StyledName } from '@/lib/nameStyle';
import { actions, useServerLook, displayNameIn, useLine, useMemberColor } from '@/lib/store';
import { ago, formatPlayed, GameArt, since } from './Activity';
import { confirmDialog, showError, toast } from './Dialogs';
import { ConnectionList, GamesBoard, SongPlayer } from './ProfileExtras';
import { UserTagBadge } from './ServerTag';
import { MemberRoles } from './UserCard';
import { Avatar, Button, cx, DefaultServerIcon, Icons, Logo } from './ui';

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

type Tab = 'mural' | 'activity' | 'friends' | 'servers';

/** Perfil completo (clique direito → Perfil): cartão à esquerda e abas à direita. */
export function FullProfile({ userId, serverId, onClose }: { userId: string; serverId?: string | null; onClose: () => void }) {
  const me = useLine((s) => s.me);
  const other = useLine((s) => s.users[userId]);
  const friend = useLine((s) => s.friends[userId]);
  const server = useLine((s) => (serverId ? s.servers[serverId] : undefined));
  const nickname = useLine((s) => (serverId ? s.members[serverId]?.[userId]?.nickname : null));
  const roleColor = useMemberColor(serverId, userId);
  const ignored = useIgnored((s) => s.ids.includes(userId));
  const isMe = me?.id === userId;
  const user: PublicUser | undefined = isMe ? me ?? undefined : other;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mutual, setMutual] = useState<{ friends: PublicUser[]; servers: Server[] } | null>(null);
  const [tab, setTab] = useState<Tab>('activity');
  const [menu, setMenu] = useState(false);
  const [main, setMain] = useState(false);
  const look = useServerLook(serverId, userId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!other && !isMe) api.user(userId).then((u) => actions.upsertUsers([u]), () => {});
    api.profile(userId, serverId).then(
      (p) => {
        setProfile(p);
        if (p.favoriteGame || p.likedGames.length) setTab('mural');
      },
      () => {},
    );
    if (!isMe) api.mutual(userId).then(setMutual, () => setMutual({ friends: [], servers: [] }));
  }, [userId, serverId]);

  if (!user || !me) return null;
  const state = friend?.state;
  const bannerUrl = (!main && look.bannerUrl) || user.bannerUrl;
  const banner = bannerUrl ? fileUrl(bannerUrl) : null;
  const bio = (!main && look.bio) || user.bio;
  const ring = `color-mix(in srgb, ${user.avatarColor} 22%, var(--color-rail))`;
  const presence = isMe ? (me.status === 'invisible' ? 'offline' : me.presence === 'offline' ? 'online' : me.presence) : user.presence;
  const serverName = !main && serverId ? displayNameIn(useLine.getState(), serverId, userId) : user.displayName;
  const hasGames = !!(profile?.favoriteGame || profile?.likedGames.length);

  async function openDm() {
    const dm = await api.openDm([userId]);
    actions.upsertChannel(dm);
    actions.goHome(dm.id);
    onClose();
  }

  const tabs: { id: Tab; label: string }[] = [
    ...(hasGames ? [{ id: 'mural' as const, label: 'Mural' }] : []),
    { id: 'activity', label: 'Atividade' },
    ...(!isMe
      ? [
          { id: 'friends' as const, label: `${mutual?.friends.length ?? 0} ${mutual?.friends.length === 1 ? 'amigo mútuo' : 'amigos mútuos'}` },
          { id: 'servers' as const, label: `${mutual?.servers.length ?? 0} ${mutual?.servers.length === 1 ? 'servidor mútuo' : 'servidores mútuos'}` },
        ]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={user.displayName}
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex max-h-full w-full max-w-[980px] flex-col gap-6 overflow-y-auto rounded-2xl border border-edge bg-side p-6 shadow-2xl md:h-[min(800px,100%)] md:flex-row md:overflow-hidden md:p-10"
      >
        <button onClick={onClose} title="Fechar" className="absolute top-4 right-4 z-10 rounded-lg border border-edge bg-rail p-1.5 text-soft hover:text-fg">
          <Icons.X size={18} />
        </button>

        {/* Cartão */}
        <div
          className="w-full shrink-0 overflow-hidden rounded-2xl border border-edge md:w-[400px] md:overflow-y-auto"
          style={{ background: `linear-gradient(to bottom, color-mix(in srgb, ${user.avatarColor} 30%, var(--color-rail)), var(--color-rail) 45%)` }}
        >
          <div className="h-[140px]" style={banner ? undefined : { background: user.avatarColor }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
          </div>
          <div className="px-6 pb-6">
            <div className="relative z-[5] -mt-16 flex items-start gap-2">
              <span className="flex shrink-0 rounded-full border-[6px]" style={{ borderColor: ring, background: ring }}>
                <Avatar name={user.displayName} color={user.avatarColor} src={(!main && look.avatarUrl) || user.avatarUrl} size={120} presence={presence} dotRingColor={ring} dotSize={26} className="block" />
              </span>
              {user.thought && (
                <span className="relative mt-20 max-w-[200px] rounded-2xl border border-edge bg-side px-3 py-1.5 text-xs break-words text-soft shadow-lg">
                  {user.thought}
                </span>
              )}
            </div>

            <p className="mt-3 flex min-w-0 items-center gap-2 text-2xl leading-tight font-bold">
              <StyledName user={user} color={user.botStyle?.nameColor ?? roleColor} className="truncate">
                {serverName}
              </StyledName>
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-soft">
              <span>{user.bot ? 'Agente do servidor' : user.username}</span>
              {user.pronouns && <span className="text-muted">• <span data-tip="Pronomes" style={{ cursor: 'default' }}>{user.pronouns}</span></span>}
              <UserTagBadge user={user} />
            </p>
            {user.customStatus && <p className="mt-1.5 text-sm text-soft">{user.customStatus}</p>}

            {/* Ações */}
            {!user.bot && (
              <div className="mt-4 flex items-center gap-2">
                {isMe ? (
                  <Button
                    onClick={() => {
                      onClose();
                      actions.openModal({ kind: 'settings', section: 'profile' });
                    }}
                  >
                    <Icons.Edit size={16} /> Editar perfil
                  </Button>
                ) : (
                  <>
                    {state !== 'blocked' && (
                      <Button onClick={() => openDm().catch(showError)}>
                        <Icons.Message size={16} /> Mensagem
                      </Button>
                    )}
                    <FriendButton userId={userId} username={user.username} displayName={user.displayName} />
                  </>
                )}
                {!isMe && (
                  <span className="relative">
                    <SquareButton title="Mais" onClick={() => setMenu((v) => !v)} active={menu}>
                      <Icons.More size={17} />
                    </SquareButton>
                    {menu && (
                      <MoreMenu
                        user={user}
                        nickname={serverId && nickname ? nickname : null}
                        main={main}
                        onMain={() => setMain((v) => !v)}
                        ignored={ignored}
                        blocked={state === 'blocked'}
                        onClose={() => setMenu(false)}
                      />
                    )}
                  </span>
                )}
              </div>
            )}

            {profile?.favoriteSong && (
              <div className="mt-5">
                <SongPlayer song={profile.favoriteSong} />
              </div>
            )}
            {bio && <p className="mt-5 text-sm break-words whitespace-pre-wrap">{bio}</p>}

            {profile && (
              <Section title="Membro desde">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="flex items-center gap-1.5" title="No Line">
                    <LineMark /> {date(profile.createdAt)}
                  </span>
                  {!main && server && profile.joinedAt && (
                    <>
                      <span className="text-muted">•</span>
                      <span className="flex items-center gap-1.5" title={`Em ${server.name}`}>
                        <ServerMini server={server} /> {date(profile.joinedAt)}
                      </span>
                    </>
                  )}
                </span>
              </Section>
            )}
            {profile?.friendsSince && state === 'friends' && (
              <Section title="Amigos desde">
                <span className="text-sm">{date(profile.friendsSince)}</span>
              </Section>
            )}
            {!main && serverId && <RolesSection userId={userId} serverId={serverId} />}
            {!!profile?.connections.length && (
              <Section title="Conexões">
                <ConnectionList list={profile.connections} />
              </Section>
            )}
            {!isMe && profile && <NoteField userId={userId} initial={profile.note} />}
          </div>
        </div>

        {/* Abas */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex gap-6 border-b border-edge pr-10">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cx('-mb-px border-b-2 pb-3 text-sm font-semibold', tab === t.id ? 'border-fg text-fg' : 'border-transparent text-soft hover:text-fg')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-4">
            {tab === 'mural' && profile && <GamesBoard favorite={profile.favoriteGame} liked={profile.likedGames} />}
            {tab === 'activity' && <ActivityList profile={profile} />}
            {tab === 'friends' && (
              <UserList
                empty="Nenhum amigo em comum."
                items={(mutual?.friends ?? []).map((f) => ({
                  key: f.id,
                  icon: <Avatar name={f.displayName} color={f.avatarColor} src={f.avatarUrl} size={36} presence={f.presence} />,
                  label: <StyledName user={f}>{f.displayName}</StyledName>,
                  sub: f.username,
                  onClick: () => actions.openModal({ kind: 'full-profile', userId: f.id }),
                }))}
              />
            )}
            {tab === 'servers' && (
              <UserList
                empty="Nenhum servidor em comum."
                items={(mutual?.servers ?? []).map((s) => ({
                  key: s.id,
                  icon: <ServerMini server={s} size={36} />,
                  label: s.name,
                  sub: `${s.memberCount} ${s.memberCount === 1 ? 'membro' : 'membros'}`,
                  onClick: () => {
                    onClose();
                    actions.goServer(s.id);
                  },
                }))}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <p className="mb-1.5 text-xs font-bold text-soft">{title}</p>
      {children}
    </div>
  );
}

function RolesSection({ userId, serverId }: { userId: string; serverId: string }) {
  const has = useLine((s) => !!s.members[serverId]?.[userId]);
  if (!has) return null;
  return (
    <div className="mt-5">
      <p className="text-xs font-bold text-soft">Cargos</p>
      <div className="-mt-1.5">
        <MemberRoles userId={userId} serverId={serverId} />
      </div>
    </div>
  );
}

function LineMark() {
  return <Logo size={16} />;
}

function ServerMini({ server, size = 16 }: { server: Server; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-rail" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {server.iconUrl ? <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full object-cover" /> : <DefaultServerIcon />}
    </span>
  );
}

function SquareButton({ active, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...props}
      className={cx('flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-raise text-soft hover:text-fg disabled:opacity-50', active && 'text-fg', className)}
    />
  );
}

/** Botão de amizade ao lado de Mensagem: adicionar, aceitar, pendente ou amigos (desfazer). */
function FriendButton({ userId, username, displayName }: { userId: string; username: string; displayName: string }) {
  const state = useLine((s) => s.friends[userId]?.state);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .catch(showError)
      .finally(() => setBusy(false));
  };
  if (state === 'blocked') return null;
  if (state === 'outgoing')
    return (
      <SquareButton title="Pedido enviado" disabled>
        <Icons.Clock size={17} />
      </SquareButton>
    );
  if (state === 'incoming')
    return (
      <SquareButton title="Aceitar pedido de amizade" disabled={busy} onClick={() => run(async () => actions.upsertFriend(await api.acceptFriend(userId)))}>
        <Icons.UserCheck size={17} />
      </SquareButton>
    );
  if (state === 'friends')
    return (
      <SquareButton
        title="Amigos (clique para desfazer)"
        disabled={busy}
        onClick={async () =>
          (await confirmDialog({ title: 'Desfazer amizade', message: `Tirar ${displayName} dos seus amigos?`, confirmLabel: 'Desfazer amizade', danger: true })) &&
          run(async () => {
            await api.removeFriend(userId);
            actions.removeFriend(userId);
          })
        }
      >
        <Icons.UserCheck size={17} />
      </SquareButton>
    );
  return (
    <SquareButton title="Adicionar amigo" disabled={busy} onClick={() => run(async () => actions.upsertFriend(await api.addFriend(username)))}>
      <Icons.UserPlus size={17} />
    </SquareButton>
  );
}

/** Menu ⋯ do perfil. */
function MoreMenu({
  user,
  nickname,
  main,
  onMain,
  ignored,
  blocked,
  onClose,
}: {
  user: PublicUser;
  nickname: string | null;
  main: boolean;
  onMain: () => void;
  ignored: boolean;
  blocked: boolean;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [invite, setInvite] = useState(false);
  const servers = useLine((s) => s.serverOrder.map((id) => s.servers[id]).filter((sv): sv is Server => !!sv && !sv.suspended));

  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);

  const act = (fn: () => unknown) => () => {
    onClose();
    Promise.resolve().then(fn).catch(showError);
  };

  async function sendInvite(sv: Server) {
    const dm = await api.openDm([user.id]);
    actions.upsertChannel(dm);
    await api.sendMessage(dm.id, `Entra no servidor ${sv.name} comigo! Código de convite: ${sv.inviteCode}`, []);
    toast(`Convite de ${sv.name} enviado para ${user.displayName}.`);
  }

  return (
    <div ref={box} className="absolute top-full left-0 z-20 mt-1.5 w-60 rounded-xl border border-edge bg-rail p-1.5 text-sm shadow-2xl">
      {nickname && (
        <Item onClick={act(onMain)} sub={main ? nickname : user.displayName}>
          {main ? 'Ver perfil do servidor' : 'Ver perfil principal'}
        </Item>
      )}
      <Item
        onClick={act(async () => {
          await navigator.clipboard.writeText(`https://useline.tech/app/?perfil=${encodeURIComponent(user.id)}`);
          toast('Link do perfil copiado.');
        })}
      >
        Compartilhar perfil
      </Item>
      {!blocked && servers.length > 0 && (
        <div className="relative" onMouseEnter={() => setInvite(true)} onMouseLeave={() => setInvite(false)}>
          <Item onClick={() => setInvite((v) => !v)} right={<Icons.ChevronRight size={15} />}>
            Convidar para o servidor
          </Item>
          {invite && (
            <div className="absolute top-0 left-full z-30 ml-1 max-h-80 w-56 overflow-y-auto rounded-xl border border-edge bg-rail p-1.5 shadow-2xl">
              {servers.map((sv) => (
                <Item key={sv.id} onClick={act(() => sendInvite(sv))}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ServerMini server={sv} size={20} />
                    <span className="truncate">{sv.name}</span>
                  </span>
                </Item>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mx-1.5 my-1 border-t border-edge" />
      <Item
        onClick={act(async () => {
          await setIgnored(user.id, !ignored);
          toast(ignored ? `Você parou de ignorar ${user.displayName}.` : `Mensagens de ${user.displayName} vão ficar recolhidas.`);
        })}
      >
        {ignored ? 'Deixar de ignorar' : 'Ignorar'}
      </Item>
      {blocked ? (
        <Item
          onClick={act(async () => {
            await api.unblockUser(user.id);
            actions.removeFriend(user.id);
          })}
        >
          Desbloquear
        </Item>
      ) : (
        <Item
          danger
          onClick={act(
            async () =>
              (await confirmDialog({ title: `Bloquear ${user.displayName}`, message: 'A pessoa não vai poder te mandar pedidos nem mensagens diretas.', confirmLabel: 'Bloquear', danger: true })) &&
              actions.upsertFriend(await api.blockUser(user.id)),
          )}
        >
          Bloquear
        </Item>
      )}
      <Item danger onClick={act(() => actions.openModal({ kind: 'report', target: { userId: user.id } }))}>
        Denunciar perfil do usuário
      </Item>
      <div className="mx-1.5 my-1 border-t border-edge" />
      <Item
        onClick={act(async () => {
          await navigator.clipboard.writeText(user.id);
          toast('ID copiado.');
        })}
        right={<Icons.Copy size={15} />}
      >
        Copiar ID do usuário
      </Item>
    </div>
  );
}

function Item({ onClick, danger, sub, right, children }: { onClick: () => void; danger?: boolean; sub?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left font-medium',
        danger ? 'text-danger hover:bg-danger hover:text-white' : 'text-soft hover:bg-accent hover:text-on-accent',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {sub && <span className="block truncate text-xs font-normal opacity-70">{sub}</span>}
      </span>
      {right && <span className="shrink-0 opacity-80">{right}</span>}
    </button>
  );
}

/** Nota só minha sobre a pessoa: salva ao sair do campo. */
function NoteField({ userId, initial }: { userId: string; initial: string }) {
  const [note, setNote] = useState(initial);
  const saved = useRef(initial);
  const save = () => {
    const v = note.trim();
    if (v === saved.current) return;
    saved.current = v;
    api.setNote(userId, v).catch(showError);
  };
  return (
    <Section title="Nota (visível apenas para você)">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        maxLength={256}
        rows={Math.min(5, Math.max(1, note.split('\n').length))}
        placeholder="Clique para adicionar uma nota"
        className="w-full resize-none rounded-md bg-transparent text-sm outline-none placeholder:text-muted placeholder:italic focus:bg-rail/60 focus:px-2 focus:py-1"
      />
    </Section>
  );
}

/** Aba Atividade: jogando agora + jogos dos últimos 30 dias. */
export function ActivityList({ profile }: { profile: UserProfile | null }) {
  if (!profile) return <p className="text-sm text-muted">Carregando…</p>;
  const now = profile.playing;
  const list = profile.activity.filter((a) => !now || a.name !== now.name);
  if (!now && !list.length) return <p className="text-sm text-muted">Nenhuma atividade nos últimos 30 dias.</p>;
  const cover = (name: string) => profile.activity.find((a) => a.name === name);
  return (
    <div>
      <p className="mb-2.5 text-xs font-semibold text-soft">Atividade recente</p>
      <div className="space-y-2.5">
        {now && (
          <ActivityRow name={now.name} cover={cover(now.name)?.cover} icon={cover(now.name)?.icon}>
            <span className="h-1.5 w-1.5 rounded-full bg-online" /> {since(now.since)}
          </ActivityRow>
        )}
        {list.map((a) => (
          <ActivityRow key={a.name} name={a.name} cover={a.cover} icon={a.icon}>
            <Icons.Gamepad size={13} /> {ago(a.lastPlayed)}
            {a.totalSecs >= 60 && <span className="text-muted">· {formatPlayed(a.totalSecs)} no total</span>}
          </ActivityRow>
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ name, cover, icon, children }: { name: string; cover?: string | null; icon?: string | null; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-edge bg-rail/70 p-3">
      <GameArt cover={cover} icon={icon} size={58} />
      <div className="min-w-0">
        <p className="truncate font-bold">{name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-soft">{children}</p>
      </div>
    </div>
  );
}

function UserList({ items, empty }: { empty: string; items: { key: string; icon: ReactNode; label: ReactNode; sub: string; onClick: () => void }[] }) {
  if (!items.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-1">
      {items.map((it) => (
        <button key={it.key} onClick={it.onClick} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-hover">
          {it.icon}
          <span className="min-w-0">
            <span className="block truncate font-semibold">{it.label}</span>
            <span className="block truncate text-xs text-muted">{it.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
