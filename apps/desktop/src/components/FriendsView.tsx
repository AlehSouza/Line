'use client';

import type { Friend } from '@line/shared';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { Avatar, Button, cx, Icons, Input, presenceLabel } from './ui';

type Tab = 'online' | 'all' | 'pending' | 'add';

export function FriendsView() {
  const [tab, setTab] = useState<Tab>('online');
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);

  const list = Object.values(friends).map((f) => ({ ...f, user: users[f.user.id] ?? f.user }));
  const pending = list.filter((f) => f.state !== 'friends');
  const accepted = list.filter((f) => f.state === 'friends');
  const shown =
    tab === 'online'
      ? accepted.filter((f) => f.user.presence !== 'offline')
      : tab === 'all'
        ? accepted
        : tab === 'pending'
          ? pending
          : [];

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'online', label: 'Disponíveis' },
    { id: 'all', label: 'Todos' },
    { id: 'pending', label: 'Pendentes', badge: pending.filter((f) => f.state === 'incoming').length },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rail px-4 shadow-sm">
        <span className="flex items-center gap-2 font-bold">
          <Icons.Users className="text-muted" /> Amigos
        </span>
        <span className="h-6 w-px bg-edge" />
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              'flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[15px] font-medium',
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
            'rounded-md px-2 py-0.5 text-[15px] font-semibold',
            tab === 'add' ? 'text-accent' : 'bg-accent text-rail hover:bg-accent-strong',
          )}
        >
          Adicionar amigo
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === 'add' ? (
          <AddFriend />
        ) : (
          <>
            <h3 className="pb-2 text-xs font-bold tracking-wide text-muted uppercase">
              {tab === 'online' ? 'Disponíveis' : tab === 'all' ? 'Todos os amigos' : 'Pendentes'} — {shown.length}
            </h3>
            {shown.length === 0 && (
              <p className="py-12 text-center text-muted">
                {tab === 'pending'
                  ? 'Nenhum pedido pendente.'
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
  );
}

function FriendRow({ friend }: { friend: Friend }) {
  const { user, state } = friend;
  const run = (fn: () => Promise<unknown>) => fn().catch((e) => alert(e.message));

  return (
    <div className="group flex items-center gap-3 rounded-lg border-t border-edge px-2 py-2.5 hover:bg-hover">
      <Avatar name={user.displayName} color={user.avatarColor} size={36} presence={user.presence} ring="main" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">
          {user.displayName} <span className="hidden text-sm font-normal text-muted group-hover:inline">@{user.username}</span>
        </p>
        <p className="truncate text-sm text-muted">
          {state === 'incoming'
            ? 'Pedido de amizade recebido'
            : state === 'outgoing'
              ? 'Pedido de amizade enviado'
              : user.customStatus || presenceLabel[user.presence]}
        </p>
      </div>
      {state === 'friends' && (
        <IconButton
          title="Mensagem"
          onClick={() =>
            run(async () => {
              const dm = await api.openDm([user.id]);
              actions.upsertChannel(dm);
              actions.goHome(dm.id);
            })
          }
        >
          <Icons.Message size={18} />
        </IconButton>
      )}
      {state === 'incoming' && (
        <IconButton title="Aceitar" className="hover:text-accent" onClick={() => run(() => api.acceptFriend(user.id))}>
          <Icons.Check size={18} />
        </IconButton>
      )}
      <IconButton
        title={state === 'friends' ? 'Desfazer amizade' : state === 'incoming' ? 'Recusar' : 'Cancelar pedido'}
        className="hover:text-danger"
        onClick={() => {
          if (state !== 'friends' || confirm(`Desfazer amizade com ${user.displayName}?`)) run(() => api.removeFriend(user.id));
        }}
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
      className={cx('flex h-9 w-9 items-center justify-center rounded-full bg-side text-soft hover:text-fg', className)}
    />
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
