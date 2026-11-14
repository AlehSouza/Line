'use client';

import { mobile } from '@/lib/mobile';

import { ProfileEditor } from './ProfileEditor';
import { NicknameDialog, ServerSettings } from './ServerSettings';
import { UserCard } from './UserCard';
import { VoiceInviteModal, VoiceStatusModal } from './VoiceInvite';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { hasPerm, Perm } from '@line/shared';
import { actions, permsOf, useLine, type Modal as ModalState } from '@/lib/store';
import { ServerImages, type ServerImage } from './ServerImages';
import { SettingsModal } from './Settings';
import { Avatar, Button, Checkbox, cx, ErrorText, Field, Icons, Input, Modal, presenceLabel } from './ui';
import { confirmDialog } from './Dialogs';

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
    case 'edit-category':
      return <EditCategoryModal categoryId={modal.categoryId} onClose={close} />;
    case 'edit-channel':
      return <EditChannelModal channelId={modal.channelId} onClose={close} />;
    case 'nickname':
      return <NicknameDialog serverId={modal.serverId} userId={modal.userId} onClose={close} />;
    case 'server-settings':
      return <ServerSettings serverId={modal.serverId} initial={modal.section} onClose={close} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} onClose={close} />;
    case 'profile':
      return <ProfileModal onClose={close} />;
    case 'settings':
      return <SettingsModal onClose={close} initial={modal.section} />;
    case 'create-poll':
      return <CreatePollModal channelId={modal.channelId} onClose={close} />;
    case 'new-dm':
      return <NewDmModal onClose={close} />;
    case 'user':
      return <UserCard userId={modal.userId} at={modal.at} hover={modal.hover} onClose={close} />;
    case 'create-thread':
      return <CreateThreadModal modal={modal} onClose={close} />;
    case 'image':
      return <ImageViewer url={modal.url} filename={modal.filename} onClose={close} />;
    case 'voice-invite':
      return <VoiceInviteModal serverId={modal.serverId} channelId={modal.channelId} onClose={close} />;
    case 'voice-status':
      return <VoiceStatusModal channelId={modal.channelId} onClose={close} />;
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
      mobile.showNav();
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
              <Checkbox checked={isPublic} onChange={setIsPublic} />
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
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const serverRoles = useLine((s) => s.roles[modal.serverId]);
  const category = useLine((s) => (modal.categoryId ? s.categories[modal.categoryId] : undefined));
  const server = useLine((s) => s.servers[modal.serverId]);
  const memberRefs = useLine((s) => s.members[modal.serverId]);
  const users = useLine((s) => s.users);
  const { busy, error, run } = useAction();

  // Quem pode ser escolhido para o canal privado (o dono sempre vê, então não aparece).
  const members = Object.keys(memberRefs ?? {})
    .filter((id) => id !== server?.ownerId && users[id])
    .map((id) => users[id])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const toggleMember = (id: string) =>
    setMemberIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleRole = (id: string) => setRoleIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const roles = (serverRoles ?? []).filter((r) => r.id !== modal.serverId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const channel = await api.createChannel(modal.serverId, {
        name,
        type,
        categoryId: modal.categoryId,
        ...(isPrivate ? { isPrivate: true, memberIds, roleIds } : {}),
      });
      actions.upsertChannel(channel);
      if (channel.type === 'text') {
        actions.goServer(modal.serverId, channel.id);
        mobile.showMain();
      }
      onClose();
    });
  };

  const types = [
    { id: 'text' as const, icon: <Icons.Hash size={18} />, label: 'Texto', hint: 'Envie mensagens, imagens, GIFs, emojis, opiniões e piadas' },
    { id: 'voice' as const, icon: <Icons.Speaker size={18} />, label: 'Voz', hint: 'Passe tempo com a turma com voz, vídeo e compartilhamento de tela' },
  ];

  return (
    <Modal title="Criar canal" subtitle={category ? `em ${category.name}` : undefined} onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <p className="mb-2 text-sm font-semibold text-soft">Tipo de canal</p>
          <div className="space-y-1">
            {types.map((t) => (
              <label
                key={t.id}
                className={cx(
                  'flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5',
                  type === t.id ? 'bg-raise' : 'hover:bg-hover',
                )}
              >
                <input type="radio" name="channel-type" className="sr-only" checked={type === t.id} onChange={() => setType(t.id)} />
                <span
                  className={cx(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                    type === t.id ? 'border-accent' : 'border-muted',
                  )}
                >
                  {type === t.id && <span className="h-2.5 w-2.5 rounded-full bg-accent" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-semibold">
                    {t.icon}
                    {t.label}
                  </span>
                  <span className="block text-sm text-muted">{t.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold text-soft">Nome do canal</p>
          <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
            {type === 'text' ? <Icons.Hash size={18} className="text-muted" /> : <Icons.Speaker size={18} className="text-muted" />}
            <input
              autoFocus
              required
              value={name}
              maxLength={100}
              onChange={(e) => setName(type === 'text' ? e.target.value.replace(/\s/g, '-').toLowerCase() : e.target.value)}
              placeholder="novo-canal"
              className="h-10 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 font-semibold">
              <Icons.Lock size={16} />
              Canal privado
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={isPrivate}
              onClick={() => setIsPrivate((v) => !v)}
              className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', isPrivate ? 'bg-accent' : 'bg-edge')}
            >
              <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', isPrivate ? 'left-[22px]' : 'left-0.5')} />
            </button>
          </div>
          <p className="mt-1 text-sm text-muted">Somente os cargos e membros selecionados (e os administradores) poderão ver esse canal.</p>
          {isPrivate && (
            <div className="mt-3 max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-1.5">
              {roles.length > 0 && <p className="px-2 pt-1 pb-0.5 text-xs font-bold text-muted uppercase">Cargos</p>}
              {roles.map((r) => (
                <label key={r.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
                  <span className="flex h-7 w-7 items-center justify-center" style={{ color: r.color ?? '#99aab5' }}>
                    <Icons.Shield size={18} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                  <Checkbox checked={roleIds.includes(r.id)} onChange={() => toggleRole(r.id)} />
                </label>
              ))}
              {roles.length > 0 && <p className="px-2 pt-2 pb-0.5 text-xs font-bold text-muted uppercase">Membros</p>}
              {members.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">Ainda não há outros membros no servidor.</p>}
              {members.map((u) => (
                <label key={u.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
                  <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{u.displayName}</span>
                    <span className="block truncate text-xs text-muted">@{u.username}</span>
                  </span>
                  <Checkbox checked={memberIds.includes(u.id)} onChange={() => toggleMember(u.id)} />
                </label>
              ))}
            </div>
          )}
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
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

function EditChannelModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useLine((s) => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const { busy, error, run } = useAction();
  if (!channel) return null;
  const isText = channel.type !== 'voice';
  const changed = name.trim() !== channel.name || topic.trim() !== (channel.topic ?? '');
  return (
    <Modal title="Editar canal" subtitle={isText ? `#${channel.name}` : channel.name} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.upsertChannel(await api.updateChannel(channelId, { name: name.trim(), topic: topic.trim() }));
            onClose();
          });
        }}
        className="space-y-5"
      >
        <div>
          <p className="mb-2 text-sm font-semibold text-soft">Nome do canal</p>
          <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
            {isText ? <Icons.Hash size={18} className="text-muted" /> : <Icons.Speaker size={18} className="text-muted" />}
            <input
              autoFocus
              required
              value={name}
              maxLength={100}
              onChange={(e) => setName(isText ? e.target.value.replace(/\s/g, '-').toLowerCase() : e.target.value)}
              className="h-10 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
          </div>
        </div>
        <Field label="Descrição do canal" hint="Aparece ao lado do nome, no topo do canal.">
          <Input value={topic} maxLength={1024} placeholder="Diga a todos como usar este canal" onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirmDialog({ title: `Excluir ${isText ? '#' : ''}${channel.name}`, message: 'As mensagens do canal serão apagadas.', confirmLabel: 'Excluir', danger: true }))) return;
              run(async () => {
                await api.deleteChannel(channelId);
                onClose();
              });
            }}
          >
            Excluir
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !changed}>
              Salvar
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function EditCategoryModal({ categoryId, onClose }: { categoryId: string; onClose: () => void }) {
  const category = useLine((s) => s.categories[categoryId]);
  const [name, setName] = useState(category?.name ?? '');
  const { busy, error, run } = useAction();
  if (!category) return null;
  return (
    <Modal title="Editar categoria" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.upsertCategory(await api.renameCategory(categoryId, name));
            onClose();
          });
        }}
        className="space-y-4"
      >
        <Field label="Nome da categoria">
          <Input autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirmDialog({ title: `Excluir a categoria ${category.name}`, message: 'Os canais dela continuam, só ficam sem categoria.', confirmLabel: 'Excluir', danger: true }))) return;
              run(async () => {
                await api.deleteCategory(categoryId);
                actions.removeCategory(categoryId);
                onClose();
              });
            }}
          >
            Excluir
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || name.trim() === category.name}>
              Salvar
            </Button>
          </div>
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

function CreatePollModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const { busy, error, run } = useAction();
  const filled = options.filter((o) => o.trim()).length;
  const setOption = (i: number, v: string) => setOptions((list) => list.map((o, j) => (j === i ? v : o)));

  return (
    <Modal title="Criar enquete" subtitle="Pergunte algo e deixe a galera votar." onClose={onClose} width={480}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.addMessage(await api.createPoll(channelId, question, options, multi));
            onClose();
          });
        }}
        className="space-y-4"
      >
        <Field label="Pergunta">
          <Input autoFocus required maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Qual jogo hoje?" />
        </Field>
        <div className="space-y-2">
          <span className="block text-xs font-bold tracking-wide text-muted uppercase">Opções</span>
          {options.map((o, i) => (
            <div key={i} className="flex gap-2">
              <Input maxLength={100} value={o} onChange={(e) => setOption(i, e.target.value)} placeholder={`Opção ${i + 1}`} />
              {options.length > 2 && (
                <button
                  type="button"
                  title="Remover opção"
                  onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}
                  className="rounded-md px-2 text-muted hover:bg-hover hover:text-danger"
                >
                  <Icons.X size={16} />
                </button>
              )}
            </div>
          ))}
          {options.length < 10 && (
            <button type="button" onClick={() => setOptions((list) => [...list, ''])} className="flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
              <Icons.Plus size={16} /> Adicionar opção
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-soft">
          <Checkbox checked={multi} onChange={setMulti} />
          Permitir escolher mais de uma opção
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !question.trim() || filled < 2}>
            Publicar enquete
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

export function ServerOverview({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const isOwner = useLine((s) => s.me?.id === s.servers[serverId]?.ownerId);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [isPublic, setIsPublic] = useState(server?.isPublic ?? false);
  const [color, setColor] = useState(server?.iconColor ?? COLORS[0]!);
  const [icon, setIcon] = useState<ServerImage>({ id: null, url: server?.iconUrl ?? null });
  const [banner, setBanner] = useState<ServerImage>({ id: null, url: server?.bannerUrl ?? null });
  const [imageError, setImageError] = useState('');
  const { busy, error, run } = useAction();
  if (!server) return null;
  const uploading = icon.uploading || banner.uploading;

  return (
    <div className="space-y-4">
        <ServerImages name={name} color={color} icon={icon} banner={banner} setIcon={setIcon} setBanner={setBanner} onError={setImageError} />
        <ErrorText>{imageError}</ErrorText>
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
        <Field label="Cor do ícone" hint="Usada quando o servidor não tem imagem.">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <Checkbox checked={isPublic} onChange={setIsPublic} />
          Servidor público (aparece em Explorar)
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-end gap-2 border-t border-edge pt-4">
          {isOwner && (
          <Button
            variant="danger"
            className="mr-auto"
            onClick={async () => {
              if (await confirmDialog({ title: `Excluir ${server.name}`, message: 'Todos os canais e mensagens do servidor serão apagados. Não dá para desfazer.', confirmLabel: 'Excluir servidor', danger: true, requireText: server.name })) {
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
          )}
          <Button
            disabled={busy || uploading}
            onClick={() =>
              run(async () => {
                actions.upsertServer(
                  await api.updateServer(server.id, {
                    name,
                    description,
                    isPublic,
                    iconColor: color,
                    ...(icon.changed ? { iconId: icon.id } : {}),
                    ...(banner.changed ? { bannerId: banner.id } : {}),
                  }),
                );
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
              })
            }
          >
            {uploading ? 'Enviando imagem…' : saved ? 'Salvo!' : 'Salvar alterações'}
          </Button>
        </div>
    </div>
  );
}

function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const isOwner = useLine((s) => hasPerm(permsOf(s, serverId, s.me?.id), Perm.ManageServer));
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
  return (
    <Modal title="Meu perfil" onClose={onClose} width={900}>
      <ProfileEditor onSaved={onClose} onCancel={onClose} />
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
                <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={32} presence={u.presence} />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{u.displayName}</span>
                  <span className="block text-xs text-muted">@{u.username}</span>
                </span>
                <Checkbox checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
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
