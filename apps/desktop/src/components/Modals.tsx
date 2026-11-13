'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { actions, useLine, type Modal as ModalState } from '@/lib/store';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input, Modal, presenceLabel } from './ui';

const COLORS = ['#7c6af2', '#f5c451', '#2b6cff', '#ff5a5f', '#8e4ec6', '#12a594', '#f76b15', '#d6409f', '#b5b5bf'];

export function Modals() {
  const modal = useLine((s) => s.modal);
  if (!modal) return null;
  const close = actions.closeModal;
  switch (modal.kind) {
    case 'create-server':
      return <CreateServerModal onClose={close} />;
    case 'create-channel':
      return <CreateChannelModal modal={modal} onClose={close} />;
    case 'create-category':
      return <CreateCategoryModal serverId={modal.serverId} onClose={close} />;
    case 'server-settings':
      return <ServerSettingsModal serverId={modal.serverId} onClose={close} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} onClose={close} />;
    case 'profile':
      return <ProfileModal onClose={close} />;
    case 'new-dm':
      return <NewDmModal onClose={close} />;
    case 'user':
      return <UserModal userId={modal.userId} onClose={close} />;
    case 'create-thread':
      return <CreateThreadModal modal={modal} onClose={close} />;
    case 'image':
      return <ImageViewer url={modal.url} filename={modal.filename} onClose={close} />;
  }
}

/** Executa uma ação assíncrona com estado de carregamento e erro. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CreateServerModal({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(me ? `Servidor de ${me.displayName}` : '');
  const [isPublic, setIsPublic] = useState(false);
  const [invite, setInvite] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const server =
        mode === 'create'
          ? await api.createServer({ name, isPublic })
          : await api.acceptInvite(invite.trim().split('/').pop() ?? '');
      actions.upsertServer(server);
      actions.goServer(server.id);
      onClose();
    });
  };

  return (
    <Modal
      title={mode === 'create' ? 'Crie seu servidor' : 'Entrar em um servidor'}
      subtitle={
        mode === 'create'
          ? 'Um lugar para você e sua galera. Dá pra mudar tudo depois.'
          : 'Cole o código de convite que te mandaram.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        {mode === 'create' ? (
          <>
            <Field label="Nome do servidor">
              <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
              Público (aparece em Explorar para qualquer pessoa entrar)
            </label>
          </>
        ) : (
          <Field label="Código de convite" hint="Exemplo: hTKzmak2">
            <Input autoFocus required value={invite} onChange={(e) => setInvite(e.target.value)} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            className="text-sm text-muted hover:text-fg"
            onClick={() => setMode(mode === 'create' ? 'join' : 'create')}
          >
            {mode === 'create' ? 'Tem um convite? Entrar em um servidor' : 'Prefere criar o seu?'}
          </button>
          <Button type="submit" disabled={busy}>
            {mode === 'create' ? 'Criar' : 'Entrar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateChannelModal({
  modal,
  onClose,
}: {
  modal: Extract<ModalState, { kind: 'create-channel' }>;
  onClose: () => void;
}) {
  const [type, setType] = useState<'text' | 'voice'>('text');
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const channel = await api.createChannel(modal.serverId, { name, type, categoryId: modal.categoryId });
      actions.upsertChannel(channel);
      if (channel.type === 'text') actions.goServer(modal.serverId, channel.id);
      onClose();
    });
  };

  return (
    <Modal title="Criar canal" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          {(['text', 'voice'] as const).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setType(t)}
              className={cx(
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left',
                type === t ? 'border-accent bg-raise' : 'border-edge hover:bg-hover',
              )}
            >
              {t === 'text' ? <Icons.Hash /> : <Icons.Speaker />}
              <span>
                <span className="block font-semibold">{t === 'text' ? 'Texto' : 'Voz'}</span>
                <span className="block text-xs text-muted">
                  {t === 'text' ? 'Mensagens, links e conversas' : 'Áudio, vídeo e tela (chega na fase 2)'}
                </span>
              </span>
            </button>
          ))}
        </div>
        <Field label="Nome do canal">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="novo-canal" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            Criar canal
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateCategoryModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Criar categoria" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.upsertCategory(await api.createCategory(serverId, name));
            onClose();
          });
        }}
        className="space-y-4"
      >
        <Field label="Nome da categoria">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jogos" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            Criar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CreateThreadModal({
  modal,
  onClose,
}: {
  modal: Extract<NonNullable<ModalState>, { kind: 'create-thread' }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(modal.suggestedName ?? '');
  const { busy, error, run } = useAction();
  return (
    <Modal
      title="Criar thread"
      subtitle={modal.messageId ? 'A conversa sobre essa mensagem continua num painel ao lado.' : 'Uma conversa paralela dentro deste canal.'}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const thread = await api.createThread(modal.channelId, name, modal.messageId);
            actions.upsertChannel(thread);
            onClose();
            actions.openThread(thread.id);
          });
        }}
        className="space-y-4"
      >
        <Field label="Nome da thread">
          <Input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sobre o assunto" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            Criar thread
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ImageViewer({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-8" onMouseDown={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={filename} className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl" onMouseDown={(e) => e.stopPropagation()} />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onMouseDown={(e) => e.stopPropagation()}
        className="text-sm text-soft hover:text-fg hover:underline"
      >
        Abrir original
      </a>
    </div>
  );
}

function ServerSettingsModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [isPublic, setIsPublic] = useState(server?.isPublic ?? false);
  const [color, setColor] = useState(server?.iconColor ?? COLORS[0]!);
  const { busy, error, run } = useAction();
  if (!server) return null;

  return (
    <Modal
      title="Configurações do servidor"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button
            variant="danger"
            className="mr-auto"
            onClick={() => {
              if (prompt(`Para excluir, digite o nome do servidor: ${server.name}`) === server.name) {
                run(async () => {
                  await api.deleteServer(server.id);
                  actions.removeServer(server.id);
                  onClose();
                });
              }
            }}
          >
            Excluir servidor
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                actions.upsertServer(await api.updateServer(server.id, { name, description, isPublic, iconColor: color }));
                onClose();
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Descrição" hint="Aparece em Explorar quando o servidor é público.">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            rows={3}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Cor do ícone">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
          Servidor público (aparece em Explorar)
        </label>
        <Field label={`Membros (${Object.keys(members ?? {}).length})`}>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-edge p-1">
            {Object.values(members ?? {}).map((m) => {
              const u = users[m.userId];
              if (!u) return null;
              return (
                <div key={m.userId} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-hover">
                  <Avatar name={u.displayName} color={u.avatarColor} size={24} />
                  <span className="flex-1 truncate text-sm">
                    {u.displayName} <span className="text-muted">@{u.username}</span>
                  </span>
                  {m.userId !== server.ownerId && (
                    <button
                      className="text-xs text-danger hover:underline"
                      onClick={() => {
                        if (confirm(`Expulsar ${u.displayName}?`)) run(() => api.kick(server.id, m.userId));
                      }}
                    >
                      Expulsar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const isOwner = useLine((s) => s.me?.id === s.servers[serverId]?.ownerId);
  const [copied, setCopied] = useState(false);
  const { error, run } = useAction();
  if (!server) return null;

  return (
    <Modal title={`Convide amigos para ${server.name}`} subtitle="Mande este código; a pessoa usa em “Entrar em um servidor”." onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2 rounded-lg border border-edge bg-rail p-1.5">
          <Input readOnly value={server.inviteCode} className="border-0 bg-transparent font-mono text-base" />
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(server.inviteCode).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copiado!' : 'Copiar'}
          </Button>
        </div>
        {isOwner && (
          <button
            className="text-xs text-muted hover:text-fg"
            onClick={() => run(async () => actions.upsertServer(await api.resetInvite(server.id)))}
          >
            Gerar novo código (o antigo para de funcionar)
          </button>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function ProfileModal({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [customStatus, setCustomStatus] = useState(me?.customStatus ?? '');
  const [color, setColor] = useState(me?.avatarColor ?? COLORS[0]!);
  const { busy, error, run } = useAction();
  if (!me) return null;

  return (
    <Modal
      title="Meu perfil"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                actions.setMe(
                  await api.updateMe({ displayName, bio, avatarColor: color, customStatus: customStatus.trim() || null }),
                );
                onClose();
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-4 rounded-xl bg-rail p-4">
          <Avatar name={displayName || me.username} color={color} size={64} />
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{displayName || me.username}</p>
            <p className="text-sm text-muted">@{me.username}</p>
            {customStatus && <p className="truncate text-sm text-soft">{customStatus}</p>}
          </div>
        </div>
        <Field label="Nome de exibição">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
        </Field>
        <Field label="Status personalizado">
          <Input
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value)}
            maxLength={128}
            placeholder="Jogando, estudando, no rolê…"
          />
        </Field>
        <Field label="Sobre mim">
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={190}
            rows={3}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <Field label="Cor do avatar">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function NewDmModal({ onClose }: { onClose: () => void }) {
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);
  const [selected, setSelected] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [groupName, setGroupName] = useState('');
  const { busy, error, run } = useAction();
  const list = Object.values(friends).filter((f) => f.state === 'friends');

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const targets = [...selected, ...(username.trim() ? [username.trim().replace(/^@/, '')] : [])];

  return (
    <Modal
      title="Nova conversa"
      subtitle="Escolha amigos ou digite um nome de usuário. Duas pessoas ou mais viram um grupo."
      onClose={onClose}
      footer={
        <Button
          disabled={busy || targets.length === 0}
          onClick={() =>
            run(async () => {
              const dm = await api.openDm(targets, targets.length > 1 ? groupName || undefined : undefined);
              actions.upsertChannel(dm);
              actions.goHome(dm.id);
              onClose();
            })
          }
        >
          {targets.length > 1 ? 'Criar grupo' : 'Abrir conversa'}
        </Button>
      }
    >
      <div className="space-y-3">
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@nome_de_usuario" />
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {list.length === 0 && <p className="text-sm text-muted">Você ainda não tem amigos adicionados.</p>}
          {list.map((f) => {
            const u = users[f.user.id] ?? f.user;
            return (
              <label key={u.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
                <Avatar name={u.displayName} color={u.avatarColor} size={32} presence={u.presence} />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{u.displayName}</span>
                  <span className="block text-xs text-muted">@{u.username}</span>
                </span>
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} className="h-4 w-4 accent-[var(--color-accent)]" />
              </label>
            );
          })}
        </div>
        {targets.length > 1 && (
          <Field label="Nome do grupo (opcional)">
            <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={100} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function UserModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const user = useLine((s) => s.users[userId]);
  const me = useLine((s) => s.me);
  const friend = useLine((s) => s.friends[userId]);
  const { busy, error, run } = useAction();
  if (!user) return null;
  const isMe = me?.id === userId;

  return (
    <Modal title={user.displayName} onClose={onClose} width={380}>
      <div className="space-y-3">
        <Avatar name={user.displayName} color={user.avatarColor} size={72} presence={user.presence} />
        <div>
          <p className="text-xl font-bold">{user.displayName}</p>
          <p className="text-sm text-muted">
            @{user.username} · {presenceLabel[user.presence]}
          </p>
        </div>
        {user.customStatus && <p className="text-sm text-soft">{user.customStatus}</p>}
        {user.bio && (
          <div className="rounded-lg bg-rail p-3">
            <p className="pb-1 text-xs font-bold tracking-wide text-muted uppercase">Sobre mim</p>
            <p className="text-sm whitespace-pre-wrap text-soft">{user.bio}</p>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        {!isMe && (
          <div className="flex gap-2">
            <Button
              disabled={busy}
              className="flex-1"
              onClick={() =>
                run(async () => {
                  const dm = await api.openDm([user.id]);
                  actions.upsertChannel(dm);
                  actions.goHome(dm.id);
                  onClose();
                })
              }
            >
              Enviar mensagem
            </Button>
            {!friend && (
              <Button variant="subtle" disabled={busy} onClick={() => run(async () => void (await api.addFriend(user.username)))}>
                Adicionar amigo
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {COLORS.map((c) => (
        <button
          type="button"
          key={c}
          title={c}
          onClick={() => onChange(c)}
          className={cx('h-8 w-8 rounded-full ring-offset-2 ring-offset-side', value === c && 'ring-2 ring-fg')}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}
