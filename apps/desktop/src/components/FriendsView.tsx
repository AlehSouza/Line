'use client';

import { MobileBack } from './Mobile';

import type { Friend } from '@line/shared';
import type { PublicUser } from '@line/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { useMusic } from '@/lib/music';
import { joinVoice, leaveVoice, toggleCamera, useVoice } from '@/lib/voice';
import { Avatar, Button, cx, Icons, Input, presenceLabel } from './ui';
import { confirmDialog, showError } from './Dialogs';
import { openContextMenu, openMenuAt, type MenuEntry } from './ContextMenu';

type Tab = 'online' | 'all' | 'add';

export function FriendsView() {
  const [tab, setTab] = useState<Tab>('online');
  const [query, setQuery] = useState('');
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);

  const list = Object.values(friends).map((f) => ({ ...f, user: users[f.user.id] ?? f.user }));
  const q = query.trim().toLowerCase();
  const match = (f: Friend) =>
    !q || f.user.displayName.toLowerCase().includes(q) || f.user.username.toLowerCase().includes(q);
  const accepted = list.filter((f) => f.state === 'friends');
  const shown = (tab === 'online' ? accepted.filter((f) => f.user.presence !== 'offline') : accepted)
    .filter(match)
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'online', label: 'Disponíveis' },
    { id: 'all', label: 'Todos' },
  ];
  const heading = tab === 'online' ? 'Disponíveis' : 'Todos os amigos';

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 overflow-x-auto border-b border-rail px-4 shadow-sm max-md:gap-2">
          <MobileBack />
          <span className="flex shrink-0 items-center gap-2 font-bold">
            <Icons.Users className="text-muted" /> Amigos
          </span>
          <span className="h-6 w-px shrink-0 bg-edge" />
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[15px] font-medium',
                tab === t.id ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-soft',
              )}
            >
              {t.label}
              {!!t.badge && <span className="rounded-full bg-danger px-1.5 text-xs leading-5 font-bold text-white">{t.badge}</span>}
            </button>
          ))}
          <button
            onClick={() => setTab('add')}
            className={cx(
              'shrink-0 rounded-md px-2 py-0.5 text-[15px] font-semibold',
              tab === 'add' ? 'text-accent' : 'bg-accent text-on-accent hover:bg-accent-strong',
            )}
          >
            Adicionar amigo
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 max-md:px-3">
          {tab === 'add' ? (
            <AddFriend />
          ) : (
            <>
              <label className="mb-4 flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 py-2 focus-within:border-accent">
                <Icons.Search size={16} className="text-muted" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar"
                  className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
                />
              </label>
              <h3 className="pb-2 text-xs font-bold tracking-wide text-muted uppercase">
                {heading} — {shown.length}
              </h3>
              {shown.length === 0 && (
                <p className="py-10 text-center text-muted">
                  {q
                    ? 'Ninguém encontrado com esse nome.'
                    : tab === 'online'
                      ? 'Ninguém disponível agora. Que tal chamar alguém?'
                      : 'Você ainda não adicionou ninguém.'}
                </p>
              )}
              {shown.map((f) => (
                <FriendRow key={f.user.id} friend={f} />
              ))}

            </>
          )}
        </div>
      </div>
      <ActiveNow friends={accepted} />
    </div>
  );
}

export function FriendRequestsView() {
  const [tab, setTab] = useState<'incoming' | 'outgoing' | 'spam'>('incoming');
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);
  useSpamMarks((m) => m.marks);
  const spamIds = useLine(useShallow(spamRequestIds));
  const list = Object.values(friends).map((f) => ({ ...f, user: users[f.user.id] ?? f.user }));
  const spam = list.filter((f) => f.state === 'incoming' && spamIds.includes(f.user.id));
  const incoming = list.filter((f) => f.state === 'incoming' && !spamIds.includes(f.user.id));
  const outgoing = list.filter((f) => f.state === 'outgoing');
  const shown = (tab === 'incoming' ? incoming : tab === 'outgoing' ? outgoing : spam).sort((a, b) =>
    a.user.displayName.localeCompare(b.user.displayName),
  );
  const tabs = [
    { id: 'incoming' as const, label: 'Pedidos', count: incoming.length },
    { id: 'outgoing' as const, label: 'Enviados', count: outgoing.length },
    { id: 'spam' as const, label: 'Spam', count: spam.length },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 overflow-x-auto border-b border-rail px-4 shadow-sm max-md:gap-2">
        <MobileBack />
        <span className="flex shrink-0 items-center gap-2 font-bold">
          <Icons.Mail className="text-muted" /> Solicitações
        </span>
        <span className="h-6 w-px shrink-0 bg-edge" />
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[15px] font-medium',
              tab === t.id ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-soft',
            )}
          >
            {t.label}
            {t.count > 0 &&
              (t.id === 'incoming' ? (
                <span className="rounded-full bg-danger px-1.5 text-xs leading-5 font-bold text-white">{t.count}</span>
              ) : (
                <span className="text-sm text-muted">({t.count})</span>
              ))}
          </button>
        ))}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 max-md:px-3">
        <h3 className="pb-2 text-xs font-bold tracking-wide text-muted uppercase">
          {tab === 'incoming' ? 'Pedidos recebidos' : tab === 'outgoing' ? 'Pedidos enviados' : 'Possível spam'} — {shown.length}
        </h3>
        {tab === 'spam' && (
          <p className="pb-3 text-sm text-muted">
            Pedidos de quem não tem nenhum servidor nem conversa em comum com você, ou que você marcou como spam. Eles não
            contam no aviso da barra lateral.
          </p>
        )}
        {shown.length === 0 && (
          <p className="py-12 text-center text-muted">
            {tab === 'incoming'
              ? 'Nenhum pedido de amizade por enquanto.'
              : tab === 'outgoing'
                ? 'Você não tem pedidos enviados esperando resposta.'
                : 'Nenhum pedido suspeito.'}
          </p>
        )}
        {shown.map((f) => (
          <PendingRow key={f.user.id} friend={f} spam={tab === 'spam'} />
        ))}
      </div>
    </div>
  );
}

// ---------- spam ----------

const SPAM_KEY = 'line.spamMarks';
type SpamMark = 'spam' | 'ok';

function loadSpamMarks(): Record<string, SpamMark> {
  try {
    return JSON.parse(localStorage.getItem(SPAM_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** Marcações manuais ("é spam" / "não é spam"), só neste aparelho. */
const useSpamMarks = create<{ marks: Record<string, SpamMark> }>(() => ({
  marks: typeof window === 'undefined' ? {} : loadSpamMarks(),
}));

function markSpam(userId: string, mark: SpamMark) {
  const marks = { ...useSpamMarks.getState().marks, [userId]: mark };
  useSpamMarks.setState({ marks });
  try {
    localStorage.setItem(SPAM_KEY, JSON.stringify(marks));
  } catch {
    /* sem localStorage */
  }
}

/** Pedido suspeito: ninguém em comum (nenhum servidor e nenhuma conversa com a pessoa). */
function looksLikeSpam(s: ReturnType<typeof useLine.getState>, userId: string) {
  if (Object.values(s.members).some((m) => m[userId])) return false;
  if (s.dmOrder.some((id) => s.channels[id]?.recipients?.some((r) => r.id === userId))) return false;
  return true;
}

/** Ids dos pedidos recebidos que vão para a aba Spam. */
export function spamRequestIds(s: ReturnType<typeof useLine.getState>): string[] {
  const marks = useSpamMarks.getState().marks;
  return Object.values(s.friends)
    .filter((f) => f.state === 'incoming')
    .map((f) => f.user.id)
    .filter((id) => (marks[id] ? marks[id] === 'spam' : looksLikeSpam(s, id)));
}

/** Pedidos recebidos que não são spam (para o aviso da barra lateral). */
export function useIncomingCount() {
  useSpamMarks((m) => m.marks);
  return useLine((s) => {
    const spam = spamRequestIds(s);
    return Object.values(s.friends).filter((f) => f.state === 'incoming' && !spam.includes(f.user.id)).length;
  });
}

const run = (fn: () => Promise<unknown>) => fn().catch(showError);

async function openDm(userId: string) {
  const dm = await api.openDm([userId]);
  actions.upsertChannel(dm);
  actions.goHome(dm.id);
  return dm;
}

function friendMenu(user: PublicUser): MenuEntry[] {
  return [
    {
      label: 'Iniciar chamada de voz',
      icon: <Icons.Phone size={15} />,
      onClick: () => run(async () => joinVoice((await openDm(user.id)).id)),
    },
    {
      label: 'Iniciar chamada de vídeo',
      icon: <Icons.Video size={15} />,
      onClick: () =>
        run(async () => {
          await joinVoice((await openDm(user.id)).id);
          if (useVoice.getState().channelId && !useVoice.getState().camera) await toggleCamera();
        }),
    },
    'sep',
    {
      label: 'Desfazer amizade',
      icon: <Icons.UserMinus size={15} />,
      danger: true,
      onClick: async () => {
        if (
          await confirmDialog({
            title: 'Desfazer amizade',
            message: `Tirar ${user.displayName} dos seus amigos?`,
            confirmLabel: 'Desfazer amizade',
            danger: true,
          })
        )
          run(() => api.removeFriend(user.id));
      },
    },
    {
      label: 'Bloquear',
      icon: <Icons.Ban size={15} />,
      danger: true,
      onClick: async () => {
        if (
          await confirmDialog({
            title: `Bloquear ${user.displayName}`,
            message: 'A pessoa não vai poder te mandar pedidos nem mensagens diretas.',
            confirmLabel: 'Bloquear',
            danger: true,
          })
        )
          run(() => api.blockUser(user.id));
      },
    },
  ];
}

function FriendRow({ friend }: { friend: Friend }) {
  const { user } = friend;
  const activity = useActivity(user);

  return (
    <div
      className="group flex cursor-pointer items-center gap-3 border-t border-edge px-2 py-2.5 hover:bg-hover"
      onClick={() => run(() => openDm(user.id))}
      onContextMenu={(e) => openContextMenu(e, friendMenu(user))}
    >
      <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={36} presence={user.presence} ring="main" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">
          {user.displayName} <span className="hidden text-sm font-normal text-muted group-hover:inline">@{user.username}</span>
        </p>
        <p className="flex min-w-0 items-center gap-1 truncate text-sm text-muted">
          {activity ? (
            <>
              <span className="shrink-0 text-accent">{activity.icon}</span>
              <span className="truncate">{activity.line}</span>
            </>
          ) : (
            user.customStatus || presenceLabel[user.presence]
          )}
        </p>
      </div>
      <IconButton
        title="Mensagem"
        onClick={(e) => {
          e.stopPropagation();
          run(() => openDm(user.id));
        }}
      >
        <Icons.Message size={18} />
      </IconButton>
      <IconButton
        title="Mais"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openMenuAt({ x: r.right - 208, y: r.bottom + 4 }, friendMenu(user));
        }}
      >
        <Icons.MoreVertical size={18} />
      </IconButton>
    </div>
  );
}

function PendingRow({ friend, spam }: { friend: Friend; spam?: boolean }) {
  const { user, state } = friend;
  const activity = useActivity(user);
  const request = state === 'incoming' ? 'Pedido recebido' : 'Pedido enviado';
  return (
    <div className="group flex items-center gap-3 border-t border-edge px-2 py-2.5 hover:bg-hover">
      <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={36} presence={user.presence} ring="main" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">
          {user.displayName} <span className="hidden text-sm font-normal text-muted group-hover:inline">@{user.username}</span>
        </p>
        <p className="flex min-w-0 items-center gap-1 truncate text-sm text-muted">
          {activity ? (
            <>
              <span className="shrink-0 text-accent">{activity.icon}</span>
              <span className="truncate">{activity.line}</span>
            </>
          ) : (
            <span className="truncate">{user.customStatus || presenceLabel[user.presence]}</span>
          )}
          <span className="shrink-0">· {request}</span>
        </p>
      </div>
      {state === 'incoming' && (
        <IconButton
          title={spam ? 'Não é spam' : 'Marcar como spam'}
          className={spam ? 'hover:text-accent' : 'hover:text-danger'}
          onClick={() => markSpam(user.id, spam ? 'ok' : 'spam')}
        >
          {spam ? <Icons.ShieldCheck size={18} /> : <Icons.ShieldAlert size={18} />}
        </IconButton>
      )}
      {state === 'incoming' && (
        <IconButton title="Aceitar" className="hover:text-accent" onClick={() => run(() => api.acceptFriend(user.id))}>
          <Icons.Check size={18} />
        </IconButton>
      )}
      <IconButton
        title={state === 'incoming' ? 'Recusar' : 'Cancelar pedido'}
        className="hover:text-danger"
        onClick={() => run(() => api.removeFriend(user.id))}
      >
        <Icons.X size={18} />
      </IconButton>
    </div>
  );
}

function IconButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-side text-soft hover:text-fg', className)}
    />
  );
}

// ---------- Ativo agora ----------

interface Activity {
  icon: ReactNode;
  /** Linha curta (usada embaixo do nome na lista). */
  line: string;
  /** Título do cartão (ex.: canal de voz) e detalhes. */
  title: string;
  detail?: string;
  /** Canal de voz em que a pessoa está (para entrar junto). */
  channelId?: string;
  serverId?: string | null;
  /** Quem mais está no mesmo canal. */
  with: string[];
}

/** O que um amigo está fazendo agora, a partir do que o Line já sabe: chamada, música, status. */
function useActivity(user: PublicUser): Activity | null {
  const vs = useVoice((s) => s.states[user.id]);
  const states = useVoice((s) => s.states);
  const music = useMusic((s) => (vs ? s.states[vs.channelId] : undefined));
  const channel = useLine((s) => (vs ? s.channels[vs.channelId] : undefined));
  const server = useLine((s) => (vs?.serverId ? s.servers[vs.serverId] : undefined));
  if (user.presence === 'offline') return null;
  if (vs) {
    const others = Object.values(states)
      .filter((o) => o.channelId === vs.channelId && o.userId !== user.id)
      .map((o) => o.userId);
    const track = music?.tracks[music.index];
    const where = vs.serverId ? `${channel?.name ?? 'Canal de voz'}${server ? ` · ${server.name}` : ''}` : 'Chamada privada';
    if (track)
      return {
        icon: <Icons.Music size={13} />,
        line: `Ouvindo ${track.title}`,
        title: track.title,
        detail: `${track.author} · ${where}`,
        channelId: vs.channelId,
        serverId: vs.serverId,
        with: others,
      };
    return {
      icon: vs.screenStreamId ? <Icons.Screen size={13} /> : <Icons.Speaker size={13} />,
      line: vs.screenStreamId ? `Transmitindo em ${where}` : `Em chamada · ${where}`,
      title: where,
      detail: vs.screenStreamId ? 'Transmitindo a tela' : vs.cameraStreamId ? 'Com a câmera ligada' : 'Em chamada de voz',
      channelId: vs.channelId,
      serverId: vs.serverId,
      with: others,
    };
  }
  return null;
}

function ActiveNow({ friends }: { friends: Friend[] }) {
  const online = friends.filter((f) => f.user.presence !== 'offline');
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-edge max-xl:hidden">
      <h2 className="flex h-12 shrink-0 items-center px-4 text-lg font-bold">Ativo agora</h2>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        <ActiveList friends={online} />
      </div>
    </aside>
  );
}

function ActiveList({ friends }: { friends: Friend[] }) {
  const states = useVoice((s) => s.states);
  // Amigos no mesmo canal de voz (mesma música / mesma chamada) ficam juntos num cartão só.
  const groups = new Map<string, PublicUser[]>();
  const solo: PublicUser[] = [];
  for (const f of friends) {
    const vs = states[f.user.id];
    if (vs) groups.set(vs.channelId, [...(groups.get(vs.channelId) ?? []), f.user]);
    else if (f.user.customStatus || f.user.thought) solo.push(f.user);
  }
  if (!groups.size && !solo.length)
    return (
      <div className="pt-6 text-center">
        <p className="font-semibold">Tudo calmo por enquanto…</p>
        <p className="mt-1 text-sm text-muted">
          Quando um amigo entrar numa chamada, ouvir música ou mudar o status, ele aparece aqui.
        </p>
      </div>
    );
  return (
    <>
      {[...groups.entries()].map(([channelId, people]) => (
        <ActiveCard key={channelId} people={people} />
      ))}
      {solo.map((u) => (
        <ActiveCard key={u.id} people={[u]} />
      ))}
    </>
  );
}

function names(people: PublicUser[]) {
  if (people.length === 1) return people[0]!.displayName;
  if (people.length === 2) return `${people[0]!.displayName} e ${people[1]!.displayName}`;
  return `${people[0]!.displayName}, ${people[1]!.displayName} e mais ${people.length - 2}`;
}

function ActiveCard({ people }: { people: PublicUser[] }) {
  const user = people[0]!;
  const activity = useActivity(user);
  const users = useLine((s) => s.users);
  const myChannel = useVoice((s) => s.channelId);
  const status = user.customStatus || user.thought;
  if (!activity && !status) return null;
  const group = people.length > 1;
  const ids = new Set(people.map((p) => p.id));
  const others = activity ? activity.with.filter((id) => !ids.has(id)) : [];
  const open = (e: React.MouseEvent) =>
    actions.openModal({ kind: 'user', userId: user.id, at: { x: e.clientX, y: e.clientY } });
  const inside = !!activity?.channelId && myChannel === activity.channelId;

  return (
    <div
      className="overflow-hidden rounded-xl border border-edge bg-side"
      onContextMenu={group ? undefined : (e) => openContextMenu(e, friendMenu(user))}
    >
      <button onClick={group ? undefined : open} className={cx('flex w-full items-center gap-3 bg-hover/70 px-3 py-2.5 text-left', !group && 'hover:bg-hover')}>
        {group ? (
          <span className="flex shrink-0 -space-x-2.5">
            {people.slice(0, 3).map((p) => (
              <Avatar key={p.id} name={p.displayName} color={p.avatarColor} src={p.avatarUrl} size={32} ring="side" />
            ))}
          </span>
        ) : (
          <Avatar name={user.displayName} color={user.avatarColor} src={user.avatarUrl} size={32} presence={user.presence} ring="side" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{names(people)}</p>
          <p className="truncate text-xs text-muted">{activity ? activity.line : status}</p>
        </div>
      </button>
      {activity && (
        <div className="flex items-center gap-3 border-t border-edge bg-rail/40 px-3 py-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
            {activity.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{activity.title}</p>
            {activity.detail && <p className="truncate text-xs text-muted">{activity.detail}</p>}
            {others.length > 0 && (
              <div className="mt-1 flex -space-x-1.5">
                {others.slice(0, 5).map((id) => {
                  const u = users[id];
                  return u ? <Avatar key={id} name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={18} ring="side" /> : null;
                })}
                {others.length > 5 && <span className="pl-2.5 text-xs text-muted">+{others.length - 5}</span>}
              </div>
            )}
          </div>
          {inside ? (
            <Button variant="subtle" className="hover:text-danger" onClick={() => void leaveVoice()}>
              Sair
            </Button>
          ) : (
            activity.channelId &&
            activity.serverId && (
              <Button
                variant="subtle"
                onClick={() => {
                  actions.goServer(activity.serverId!, activity.channelId!);
                  void joinVoice(activity.channelId!);
                }}
              >
                Entrar
              </Button>
            )
          )}
        </div>
      )}
    </div>
  );
}

function AddFriend() {
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      const friend = await api.addFriend(username.replace(/^@/, ''));
      setStatus({
        ok: true,
        text:
          friend.state === 'friends'
            ? `Agora você e ${friend.user.displayName} são amigos!`
            : `Pedido enviado para ${friend.user.displayName}.`,
      });
      setUsername('');
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-3">
      <h2 className="font-bold uppercase">Adicionar amigo</h2>
      <p className="text-sm text-muted">Digite o nome de usuário da pessoa (o que aparece depois do @).</p>
      <div className="flex gap-2 rounded-xl border border-edge bg-rail p-2 focus-within:border-accent">
        <Input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="nome_de_usuario"
          className="border-0 bg-transparent"
        />
        <Button type="submit" disabled={!username.trim()}>
          Enviar pedido
        </Button>
      </div>
      {status && <p className={cx('text-sm', status.ok ? 'text-accent' : 'text-danger')}>{status.text}</p>}
    </form>
  );
}
