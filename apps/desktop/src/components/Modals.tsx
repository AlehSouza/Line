'use client';

import { FriendNickModal, UserNoteModal } from './PersonMenu';
import { imageMenuItems, openContextMenu } from './ContextMenu';
import { CoverArt } from './Attachments';
import { ServerNotifyModal } from './Notifications';
import { FullProfile } from './FullProfile';
import { NameStyleModal } from './NameStyleModal';
import { ServerProfileModal } from './ServerProfile';
import { mobile } from '@/lib/mobile';

import { ProfileEditor } from './ProfileEditor';
import { NicknameDialog, ServerSettings } from './ServerSettings';
import { MutualServersModal, UserCard } from './UserCard';
import { VoiceInviteModal, VoiceStatusModal } from './VoiceInvite';
import { ReportModal } from './ReportModal';
import { ForwardModal } from './Forward';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { api, fileUrl } from '@/lib/api';
import { mediaUrlOf } from '@/lib/mediaUrl';
import { hasPerm, Perm, type Channel, type Message, type Role } from '@line/shared';
import { inviteCodeFromText, inviteLink } from '@/lib/invite';
import { InvitePage } from './InviteCard';
import { actions, channelPermsOf, mentionsToText, withoutCardCodes, permsOf, useLine, type Modal as ModalState } from '@/lib/store';
import { Composer, ThreadChip, threadsOf, ViewerReactButton, ViewerReactions } from './ChatView';
import { ServerImages, type ServerImage } from './ServerImages';
import { SettingsModal } from './Settings';
import { Avatar, Button, Checkbox, cx, ErrorText, Field, Icons, Input, Modal, presenceLabel, Select } from './ui';
import { EmojiButton, EmojiInput, EmojiTextarea } from './EmojiField';
import { confirmDialog } from './Dialogs';
import { channelRating, RatingPicker } from './Rating';
import { ChannelLookEditor } from './ChannelLook';
import type { ChannelLook, Rating } from '@line/shared';


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
    case 'notify-settings':
      return <ServerNotifyModal serverId={modal.serverId} onClose={close} />;
    case 'invite':
      return <InviteModal serverId={modal.serverId} onClose={close} />;
    case 'invite-page':
      return <InvitePage code={modal.code} onClose={close} />;
    case 'profile':
      return <ProfileModal onClose={close} />;
    case 'settings':
      return <SettingsModal key={modal.section ?? 'account'} onClose={close} initial={modal.section} />;
    case 'create-poll':
      return <CreatePollModal channelId={modal.channelId} onClose={close} />;
    case 'user-note':
      return <UserNoteModal userId={modal.userId} onClose={close} />;
    case 'friend-nick':
      return <FriendNickModal userId={modal.userId} onClose={close} />;
    case 'new-dm':
      return <NewDmModal base={modal.base} onClose={close} />;
    case 'user':
      return <UserCard userId={modal.userId} at={modal.at} hover={modal.hover} onClose={close} />;
    case 'full-profile':
      return <FullProfile userId={modal.userId} serverId={modal.serverId} onClose={close} />;
    case 'mutual-servers':
      return <MutualServersModal servers={modal.servers} onClose={close} />;
    case 'server-profile':
      return <ServerProfileModal serverId={modal.serverId} onClose={close} />;
    case 'name-style':
      return <NameStyleModal onClose={close} />;
    case 'create-thread':
      return <CreateThreadModal modal={modal} onClose={close} />;
    case 'image':
      return <ImageViewer url={modal.url} filename={modal.filename} channelId={modal.channelId} messageId={modal.messageId} attachmentId={modal.attachmentId} onClose={close} />;
    case 'gallery':
      return <GalleryViewer items={modal.items} start={modal.index} channelId={modal.channelId} onClose={close} />;
    case 'voice-invite':
      return <VoiceInviteModal serverId={modal.serverId} channelId={modal.channelId} onClose={close} />;
    case 'voice-status':
      return <VoiceStatusModal channelId={modal.channelId} onClose={close} />;
    case 'report':
      return <ReportModal target={modal.target} onClose={close} />;
    case 'forward':
      return <ForwardModal messageId={modal.messageId} channelId={modal.channelId} onClose={close} />;
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
  const [rating, setRating] = useState<Rating>('L');
  const [invite, setInvite] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const server =
        mode === 'create'
          ? await api.createServer({ name, isPublic, rating })
          : await api.acceptInvite(inviteCodeFromText(invite));
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
          : 'Cole o link ou o código de convite que te mandaram.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        {mode === 'create' ? (
          <>
            <Field label="Nome do servidor">
              <EmojiInput autoFocus required value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <label className="flex items-center gap-3 text-sm">
              <Checkbox checked={isPublic} onChange={setIsPublic} />
              Público (aparece em Explorar para qualquer pessoa entrar)
            </label>
            <RatingPicker value={rating} onChange={(r) => r && setRating(r)} />
          </>
        ) : (
          <Field label="Link ou código de convite" hint="Exemplo: hTKzmak2">
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

function PrivateSwitch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5 font-semibold">
        <Icons.Lock size={16} />
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-edge')}
      >
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

function RoleOption({ role, checked, onToggle }: { role: Role; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover">
      <span className="flex h-7 w-7 items-center justify-center" style={{ color: role.color ?? '#99aab5' }}>
        <Icons.Shield size={18} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{role.name}</span>
      <Checkbox checked={checked} onChange={onToggle} />
    </label>
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
  const nameRef = useRef<HTMLInputElement>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [rating, setRating] = useState<Rating | null>(null);
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
      actions.upsertChannel(rating ? await api.updateChannel(channel.id, { rating, nsfw: rating === '18' }) : channel);
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
              ref={nameRef}
              autoFocus
              required
              value={name}
              maxLength={100}
              onChange={(e) => setName(type === 'text' ? e.target.value.replace(/\s/g, '-') : e.target.value)}
              placeholder="novo-canal"
              className="h-10 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
            <EmojiButton target={nameRef} />
          </div>
        </div>

        <div>
          <PrivateSwitch on={isPrivate} onToggle={() => setIsPrivate((v) => !v)} label="Exclusivo de cargos" />
          <p className="mt-1 text-sm text-muted">
            Somente os cargos e membros selecionados (e os administradores) poderão ver esse canal.
            {category?.isPrivate && ' A categoria já é exclusiva de cargos, então o canal segue a restrição dela.'}
          </p>
          {isPrivate && (
            <div className="mt-3 max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-1.5">
              {roles.length > 0 && <p className="px-2 pt-1 pb-0.5 text-xs font-bold text-muted uppercase">Cargos</p>}
              {roles.map((r) => (
                <RoleOption key={r.id} role={r} checked={roleIds.includes(r.id)} onToggle={() => toggleRole(r.id)} />
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

        <RatingPicker value={rating} onChange={setRating} none="Igual ao servidor" noneHint="O canal segue a classificação do servidor." />

        <ErrorText>{error}</ErrorText>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="subtle" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || (isPrivate && !roleIds.length && !memberIds.length)}>
            Criar canal
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Lista de cargos e membros com caixinhas (canal privado / quem pode interagir). */
function AudienceList({
  serverId,
  roleIds,
  memberIds,
  onRoles,
  onMembers,
}: {
  serverId: string;
  roleIds: string[];
  memberIds: string[];
  onRoles: (ids: string[]) => void;
  onMembers: (ids: string[]) => void;
}) {
  const serverRoles = useLine((s) => s.roles[serverId]);
  const ownerId = useLine((s) => s.servers[serverId]?.ownerId);
  const memberRefs = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const roles = (serverRoles ?? []).filter((r) => r.id !== serverId);
  // O dono sempre pode tudo, então não aparece.
  const members = Object.keys(memberRefs ?? {})
    .filter((id) => id !== ownerId && users[id])
    .map((id) => users[id])
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <div className="mt-3 max-h-80 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-1.5">
      {roles.length > 0 && <p className="px-2 pt-1 pb-0.5 text-xs font-bold text-muted uppercase">Cargos</p>}
      {roles.map((r) => (
        <RoleOption key={r.id} role={r} checked={roleIds.includes(r.id)} onToggle={() => onRoles(toggle(roleIds, r.id))} />
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
          <Checkbox checked={memberIds.includes(u.id)} onChange={() => onMembers(toggle(memberIds, u.id))} />
        </label>
      ))}
    </div>
  );
}

const sameSet = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

function EditChannelModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useLine((s) => s.channels[channelId]);
  const category = useLine((s) => (channel?.categoryId ? s.categories[channel.categoryId] : undefined));
  const [name, setName] = useState(channel?.name ?? '');
  const nameRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [isPrivate, setIsPrivate] = useState(!!channel?.isPrivate);
  const [roleIds, setRoleIds] = useState<string[]>(channel?.roleIds ?? []);
  const [memberIds, setMemberIds] = useState<string[]>(channel?.memberIds ?? []);
  const [restricted, setRestricted] = useState(!!channel?.interactRestricted);
  const [interactRoleIds, setInteractRoleIds] = useState<string[]>(channel?.interactRoleIds ?? []);
  const [interactMemberIds, setInteractMemberIds] = useState<string[]>(channel?.interactMemberIds ?? []);
  const [rating, setRating] = useState<Rating | null>(channel ? channelRating(channel) : null);
  const [look, setLook] = useState<ChannelLook | null>(channel?.look ?? null);
  const [tab, setTab] = useState<'general' | 'look'>('general');
  const { busy, error, run } = useAction();
  if (!channel) return null;
  const isText = channel.type !== 'voice';
  const lookChanged = !isText && JSON.stringify(look ?? null) !== JSON.stringify(channel.look ?? null);
  const hasAccess = !!channel.serverId && (channel.type === 'text' || channel.type === 'voice');
  const accessChanged =
    isPrivate !== !!channel.isPrivate ||
    restricted !== !!channel.interactRestricted ||
    (isPrivate && (!sameSet(roleIds, channel.roleIds) || !sameSet(memberIds, channel.memberIds))) ||
    (restricted && (!sameSet(interactRoleIds, channel.interactRoleIds) || !sameSet(interactMemberIds, channel.interactMemberIds)));
  const ratingChanged = rating !== channelRating(channel);
  const changed = name.trim() !== channel.name || topic.trim() !== (channel.topic ?? '') || accessChanged || ratingChanged || lookChanged;
  const emptyPrivate = isPrivate && !roleIds.length && !memberIds.length;
  return (
    <Modal title="Editar canal" subtitle={isText ? `#${channel.name}` : channel.name} onClose={onClose} width={520} tall>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.upsertChannel(
              await api.updateChannel(channelId, {
                name: name.trim(),
                topic: topic.trim(),
                ...(hasAccess && ratingChanged ? { rating: rating ?? '', nsfw: rating === '18' } : {}),
                ...(lookChanged ? { look } : {}),
                ...(hasAccess && accessChanged
                  ? {
                      access: {
                        isPrivate,
                        roleIds: isPrivate ? roleIds : [],
                        memberIds: isPrivate ? memberIds : [],
                        interactRestricted: restricted,
                        interactRoleIds: restricted ? interactRoleIds : [],
                        interactMemberIds: restricted ? interactMemberIds : [],
                      },
                    }
                  : {}),
              }),
            );
            onClose();
          });
        }}
        className="space-y-5"
      >
        {!isText && (
          <div className="flex gap-6 border-b border-edge">
            {(
              [
                ['general', 'Geral'],
                ['look', 'Personalização'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cx('-mb-px border-b-2 pb-2.5 text-sm font-medium', tab === id ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {tab === 'look' && !isText && <ChannelLookEditor look={look} onChange={setLook} title={name.trim() || channel.name} />}
        <div className={cx('space-y-5', tab !== 'general' && 'hidden')}>
        <div>
          <p className="mb-2 text-sm font-semibold text-soft">Nome do canal</p>
          <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
            {isText ? <Icons.Hash size={18} className="text-muted" /> : <Icons.Speaker size={18} className="text-muted" />}
            <input
              ref={nameRef}
              autoFocus
              required
              value={name}
              maxLength={100}
              onChange={(e) => setName(isText ? e.target.value.replace(/\s/g, '-') : e.target.value)}
              className="h-10 flex-1 bg-transparent outline-none placeholder:text-muted"
            />
            <EmojiButton target={nameRef} />
          </div>
        </div>
        <Field label="Descrição do canal" hint="Aparece ao lado do nome, no topo do canal.">
          <EmojiInput value={topic} maxLength={1024} placeholder="Diga a todos como usar este canal" onChange={(e) => setTopic(e.target.value)} />
        </Field>
        {hasAccess && channel.serverId && (
          <>
            <RatingPicker value={rating} onChange={setRating} none="Igual ao servidor" noneHint="O canal segue a classificação do servidor." />
            <div>
              <PrivateSwitch on={isPrivate} onToggle={() => setIsPrivate((v) => !v)} label="Quem pode ver" />
              <p className="mt-1 text-sm text-muted">
                {isPrivate
                  ? `Só os cargos e membros marcados (e os administradores) veem ${isText ? 'e leem este canal' : 'e entram neste canal'}.`
                  : 'Desligado: todos com a permissão "Ver canais" enxergam o canal.'}
                {category?.isPrivate && ' A categoria já é exclusiva de cargos, então o canal também segue a restrição dela.'}
              </p>
              {isPrivate && (
                <AudienceList serverId={channel.serverId} roleIds={roleIds} memberIds={memberIds} onRoles={setRoleIds} onMembers={setMemberIds} />
              )}
            </div>
            <div>
              <PrivateSwitch on={restricted} onToggle={() => setRestricted((v) => !v)} label={isText ? 'Quem pode enviar mensagens' : 'Quem pode falar'} />
              <p className="mt-1 text-sm text-muted">
                {restricted
                  ? isText
                    ? 'Só os marcados (e os administradores) enviam mensagens, anexos e conversas. Os outros só leem.'
                    : 'Só os marcados (e os administradores) falam e ligam câmera ou tela. Os outros entram e só escutam.'
                  : 'Desligado: vale o que cada cargo pode fazer no servidor.'}
              </p>
              {restricted && (
                <AudienceList
                  serverId={channel.serverId}
                  roleIds={interactRoleIds}
                  memberIds={interactMemberIds}
                  onRoles={setInteractRoleIds}
                  onMembers={setInteractMemberIds}
                />
              )}
            </div>
          </>
        )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirmDialog({ title: `Excluir ${isText ? '#' : ''}${channel.name}`, message: 'Essa ação não poderá ser desfeita, tem certeza? As mensagens do canal serão apagadas.', confirmLabel: 'Excluir', danger: true }))) return;
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
            <Button type="submit" disabled={busy || !name.trim() || !changed || emptyPrivate}>
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
  const inside = useLine((s) => Object.values(s.channels).filter((c) => c.categoryId === categoryId && c.type !== 'thread').length);
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
          <EmojiInput autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!(await confirmDialog({ title: `Excluir a categoria ${category.name}`, message: inside > 0 ? `Essa ação não poderá ser desfeita, tem certeza? ${inside === 1 ? 'O canal que ainda está nela também será excluído' : `Os ${inside} canais que ainda estão nela também serão excluídos`}, com todas as mensagens. Para manter, tire ${inside === 1 ? 'ele' : 'eles'} da categoria antes.` : 'Essa ação não poderá ser desfeita, tem certeza?', confirmLabel: 'Excluir', danger: true }))) return;
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
  const [isPrivate, setIsPrivate] = useState(false);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const serverRoles = useLine((s) => s.roles[serverId]);
  const roles = (serverRoles ?? []).filter((r) => r.id !== serverId);
  const toggleRole = (id: string) => setRoleIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const { busy, error, run } = useAction();
  return (
    <Modal title="Criar categoria" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            actions.upsertCategory(await api.createCategory(serverId, name, isPrivate ? roleIds : undefined));
            onClose();
          });
        }}
        className="space-y-5"
      >
        <Field label="Nome da categoria">
          <EmojiInput autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jogos" />
        </Field>
        <div>
          <PrivateSwitch on={isPrivate} onToggle={() => setIsPrivate((v) => !v)} label="Exclusiva de cargos" />
          <p className="mt-1 text-sm text-muted">
            Somente os cargos selecionados (e os administradores) poderão ver a categoria e todos os canais dentro dela.
          </p>
          {isPrivate && (
            <div className="mt-3 max-h-60 space-y-0.5 overflow-y-auto rounded-lg border border-edge p-1.5">
              {roles.length === 0 && <p className="px-2 py-1.5 text-sm text-muted">Crie um cargo nas configurações do servidor primeiro.</p>}
              {roles.map((r) => (
                <RoleOption key={r.id} role={r} checked={roleIds.includes(r.id)} onToggle={() => toggleRole(r.id)} />
              ))}
            </div>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim() || (isPrivate && !roleIds.length)}>
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
      title="Criar conversa"
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
        <Field label="Nome da conversa">
          <EmojiInput autoFocus required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sobre o assunto" />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            Criar conversa
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
          <EmojiInput autoFocus required maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Qual jogo hoje?" />
        </Field>
        <div className="space-y-2">
          <span className="block text-xs font-bold tracking-wide text-muted uppercase">Opções</span>
          {options.map((o, i) => (
            <div key={i} className="flex gap-2">
              <EmojiInput wrapClassName="flex-1" maxLength={100} value={o} onChange={(e) => setOption(i, e.target.value)} placeholder={`Opção ${i + 1}`} />
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

/** Caixa de texto do chat embaixo do visualizador: manda a mensagem na thread da mensagem dona da
 * mídia (cria a thread se ainda não existe, como o "Responder em thread" da barra de ações). */
function ViewerComposer({ channelId, messageId, attachmentId, onClose }: { channelId?: string; messageId?: string; attachmentId?: string; onClose: () => void }) {
  const parent = useLine((s) => (channelId ? s.channels[channelId] : undefined));
  const message = useLine((s) => (channelId && messageId ? s.messages[channelId]?.items.find((m) => m.id === messageId) : undefined));
  // Mensagem com várias mídias: cada uma tem a própria thread; com uma só, vale a da mensagem.
  const mediaId = message && message.attachments.length > 1 ? message.attachments.find((a) => a.id === attachmentId)?.id : undefined;
  const summary = message ? threadsOf(message).find((t) => (mediaId ? t.attachmentId === mediaId : !t.attachmentId)) : undefined;
  const threadId = useLine((s) => {
    if (summary) return summary.id;
    if (!messageId) return null;
    return (
      Object.values(s.channels).find(
        (c) => c.type === 'thread' && c.threadMessageId === messageId && (c.threadAttachmentId ?? undefined) === mediaId,
      )?.id ?? null
    );
  });
  const thread = useLine((s) => (threadId ? s.channels[threadId] : undefined));
  const canCreate = useLine((s) => hasPerm(channelPermsOf(s, channelId, s.me?.id), Perm.CreateThreads));
  const target = useMemo<Channel | null>(() => {
    if (!parent || !message) return null;
    if (parent.type === 'thread') return parent;
    if (thread) return thread;
    if (parent.type !== 'text' || !parent.serverId || !canCreate) return null;
    const plain = message.content ? withoutCardCodes(mentionsToText(message.content, parent.serverId)) : '';
    const media = mediaId ? message.attachments.find((a) => a.id === mediaId) : undefined;
    const name = (plain.split('\n')[0] || media?.filename || message.attachments[0]?.filename || 'Conversa').slice(0, 60);
    return {
      ...parent,
      id: `draft:${message.id}${media ? `:${media.id}` : ''}`,
      type: 'thread',
      name,
      parentId: parent.id,
      threadMessageId: message.id,
      // Mensagem com várias mídias: a thread responde só a esta.
      threadAttachmentId: media?.id ?? null,
      messageCount: 0,
    };
  }, [parent, message, thread, canCreate, mediaId]);
  if (!target) return null;
  const open = (id: string) => {
    actions.openThread(id);
    onClose();
  };
  return (
    <div className="w-full max-w-[760px] text-left" onMouseDown={(e) => e.stopPropagation()}>
      {/* Bento: respostas e emoji (quadrado, 44x44) na mesma altura, mesmo raio da caixa de texto,
          bordas alinhadas com ela e o mesmo gap de 8px entre colunas e entre as linhas.
          As classes com ! vencem as padrão do ThreadChip (margem, raio e padding do chat). */}
      <div className="mb-2 grid h-11 grid-cols-[minmax(0,1fr)_auto] gap-2 px-4">
        {summary && parent?.type !== 'thread' ? (
          <ThreadChip thread={summary} onClick={() => open(summary.id)} className="m-0! h-11 min-w-0 rounded-xl! bg-raise px-3! py-0! hover:bg-hover" />
        ) : (
          <span />
        )}
        <ViewerReactButton message={message!} attachmentId={ownMedia(message!, attachmentId)} />
      </div>
      <Composer
        channel={target}
        placeholder={target.id.startsWith('draft:') ? 'Começar uma conversa…' : `Responder em ${target.name}…`}
        onSent={open}
      />
    </div>
  );
}

/** Mídia com reação própria: só quando a mensagem tem várias (com uma só, vale a da mensagem). */
const ownMedia = (m: Message, attachmentId?: string) => (m.attachments.length > 1 ? m.attachments.find((a) => a.id === attachmentId)?.id : undefined);

/** Reações da mídia aberta, acima dela. */
function MediaReactions({ channelId, messageId, attachmentId }: { channelId?: string; messageId?: string; attachmentId?: string }) {
  const message = useLine((s) => (channelId && messageId ? s.messages[channelId]?.items.find((m) => m.id === messageId) : undefined));
  // Espaço sempre reservado: a primeira reação não empurra (nem encolhe) a imagem.
  return (
    <div className="flex h-9 max-w-[760px] shrink-0 items-end justify-center [&>div]:mt-0" onMouseDown={(e) => e.stopPropagation()}>
      {message && <ViewerReactions message={message} attachmentId={ownMedia(message, attachmentId)} />}
    </div>
  );
}

/** Setas e Esc do visualizador, sem atrapalhar quem está digitando na caixa de texto. */
function viewerKey(e: KeyboardEvent, onClose: () => void, go?: (d: number) => void) {
  const el = e.target as HTMLElement | null;
  const field = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el as HTMLTextAreaElement) : null;
  if (e.key === 'Escape') {
    if (!e.defaultPrevented && !field?.value) onClose();
  } else if (go && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !field?.value) {
    go(e.key === 'ArrowRight' ? 1 : -1);
  }
}

function ImageViewer({ url, filename, channelId, messageId, attachmentId, onClose }: { url: string; filename: string; channelId?: string; messageId?: string; attachmentId?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => viewerKey(e, onClose);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-8 pb-2" onMouseDown={onClose}>
      {/* Área fixa da mídia: a caixa de texto não pula enquanto a imagem carrega. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3">
      <MediaReactions channelId={channelId} messageId={messageId} attachmentId={attachmentId} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={filename} className="max-h-[calc(100vh-210px)] min-h-0 max-w-full rounded-lg object-contain shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => openContextMenu(e, imageMenuItems(url, filename))}
      />
      </div>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onMouseDown={(e) => e.stopPropagation()}
        className="text-sm text-soft hover:text-fg hover:underline"
      >
        Abrir original
      </a>
      <ViewerComposer channelId={channelId} messageId={messageId} attachmentId={attachmentId} onClose={onClose} />
    </div>
  );
}

/** Mídias de uma grade do chat em tela cheia: setas (ou ← →) passam, Esc fecha. */
function GalleryViewer({ items, start, channelId, onClose }: { items: { url: string; filename: string; contentType: string; messageId?: string; attachmentId?: string; width?: number; height?: number; preview?: string; nsfw?: boolean; sensitive?: 'nsfw' | 'spoiler' }[]; start: number; channelId?: string; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [revealed, setRevealed] = useState<number[]>([]);
  const n = items.length;
  const go = (d: number) => setI((x) => (x + d + n) % n);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => viewerKey(e, onClose, go);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, n]);
  const item = items[i]!;
  // Link da mídia (relativo); sensível vem assinado do servidor.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(item.nsfw ? null : fileUrl(item.url));
    if (item.nsfw && item.attachmentId) void mediaUrlOf(item.attachmentId, item.url, true).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [item.url, item.nsfw, item.attachmentId]);
  const video = item.contentType.startsWith('video/');
  const arrow = 'absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80';
  const covered = !!item.sensitive && !revealed.includes(i);
  const media = 'max-h-[calc(100vh-210px)] max-w-full rounded-lg shadow-2xl';
  // Coberta: a mídia real nem é carregada; um espaço no formato dela com a prévia borrada.
  const coverBox: CSSProperties =
    item.width && item.height
      ? { aspectRatio: `${item.width} / ${item.height}`, width: `min(${item.width}px, 90vw, calc((100vh - 210px) * ${item.width / item.height}))` }
      : { width: 'min(640px, 90vw)', height: 'min(400px, calc(100vh - 210px))' };
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-8 pb-2" onMouseDown={onClose}>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3">
      <MediaReactions channelId={channelId} messageId={item.messageId} attachmentId={item.attachmentId} />
      <div className="relative flex min-h-0 max-w-full items-center justify-center overflow-hidden rounded-lg" onMouseDown={(e) => e.stopPropagation()}>
        {covered || !src ? (
          <span className="relative block max-w-full shadow-2xl" style={coverBox}>
            <CoverArt preview={item.preview} />
          </span>
        ) : video ? (
          <video key={src} src={src} controls autoPlay className={media} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt={item.filename}
            className={cx(media, 'object-contain')}
            onContextMenu={(e) => openContextMenu(e, imageMenuItems(src, item.filename))}
          />
        )}
        {covered && (
          // Mesmo aviso do chat: a mídia fica em foco, mas coberta até a pessoa escolher ver.
          <div className={cx('absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg p-5 text-center text-fg', item.preview && 'bg-main/55')}>
            {item.sensitive === 'nsfw' ? <Icons.EyeOff size={40} className="text-soft" /> : <Icons.Warning size={40} className="text-soft" />}
            <p className="mt-1 text-sm font-bold tracking-wide uppercase">{item.sensitive === 'nsfw' ? 'Aviso: conteúdo sensível' : 'Spoiler'}</p>
            <p className="max-w-[300px] text-[13px] leading-snug text-muted">
              {item.sensitive === 'nsfw'
                ? 'Esta mídia pode ter conteúdo sensível (nudez, violência, palavrões, pornografia) que algumas pessoas acham ofensivo.'
                : 'Quem enviou marcou esta mídia como spoiler.'}
            </p>
            <button onClick={() => setRevealed((l) => [...l, i])} className="mt-2 rounded-full bg-hover px-5 py-2 text-sm font-semibold text-fg hover:bg-edge">
              {item.sensitive === 'nsfw' ? 'Mostrar mesmo assim' : 'Mostrar spoiler'}
            </button>
          </div>
        )}
        {!!item.sensitive && !covered && (
          <button
            onClick={() => setRevealed((l) => l.filter((x) => x !== i))}
            title="Borrar de novo"
            className="absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/90 shadow hover:bg-black/80 hover:text-white"
          >
            <Icons.EyeOff size={15} />
          </button>
        )}
      </div>
      </div>
      {n > 1 && (
        <>
          <button title="Anterior" onMouseDown={(e) => e.stopPropagation()} onClick={() => go(-1)} className={cx(arrow, 'left-4')}>
            <Icons.ChevronLeft size={22} />
          </button>
          <button title="Próxima" onMouseDown={(e) => e.stopPropagation()} onClick={() => go(1)} className={cx(arrow, 'right-4')}>
            <Icons.ChevronRight size={22} />
          </button>
        </>
      )}
      <div className="flex items-center gap-3 text-sm text-soft" onMouseDown={(e) => e.stopPropagation()}>
        {n > 1 && <span>{i + 1} de {n}</span>}
        {!covered && src && (
          <a href={src} target="_blank" rel="noreferrer" className="hover:text-fg hover:underline">
            Abrir original
          </a>
        )}
      </div>
      <ViewerComposer channelId={channelId} messageId={item.messageId} attachmentId={item.attachmentId} onClose={onClose} />
    </div>
  );
}

/** Rigor da detecção automática de conteúdo sensível nas mídias enviadas no servidor (Nenhuma desliga). */
const NSFW_LEVELS = [
  { value: 'none', label: 'Nenhuma', hint: 'Sem detecção automática. Quem envia ainda pode marcar o anexo como Spoiler ou conteúdo sensível.' },
  { value: 'light', label: 'Leve', hint: 'Marca como conteúdo sensível só o que é completamente explícito: sexo explícito, genitália à mostra e afins.' },
  { value: 'moderate', label: 'Moderada', hint: 'Tudo do Leve, mais o que incita sexo: se esfregar, poses e situações insinuantes.' },
  { value: 'high', label: 'Alta', hint: 'Tudo do Leve e do Moderado, mais qualquer mínima sugestão sexual.' },
];

export function ServerOverview({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const isOwner = useLine((s) => s.me?.id === s.servers[serverId]?.ownerId);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [isPublic, setIsPublic] = useState(server?.isPublic ?? false);
  const [ownerBadge, setOwnerBadge] = useState(server?.showOwnerBadge ?? true);
  const [nsfwLevel, setNsfwLevel] = useState<'none' | 'light' | 'moderate' | 'high'>(server?.nsfwLevel ?? 'moderate');
  const [rating, setRating] = useState<Rating | null>(server?.rating ?? null);
  const [icon, setIcon] = useState<ServerImage>({ id: null, url: server?.iconUrl ?? null });
  const [banner, setBanner] = useState<ServerImage>({ id: null, url: server?.bannerUrl ?? null });
  const [imageError, setImageError] = useState('');
  const { busy, error, run } = useAction();
  if (!server) return null;
  const uploading = icon.uploading || banner.uploading;

  return (
    <div className="space-y-4">
        <ServerImages icon={icon} banner={banner} setIcon={setIcon} setBanner={setBanner} onError={setImageError} />
        <ErrorText>{imageError}</ErrorText>
        <Field label="Nome">
          <EmojiInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Descrição" hint="Aparece em Explorar quando o servidor é público.">
          <EmojiTextarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
            rows={3}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <label className="flex items-center gap-3 text-sm">
          <Checkbox checked={isPublic} onChange={setIsPublic} />
          Servidor público (aparece em Explorar)
        </label>
        <div id="server-rating">
          <RatingPicker
            value={rating}
            onChange={(r) => r && setRating(r)}
            noneHint="Este servidor ainda não tem classificação. Enquanto isso, ele não aparece em Explorar."
          />
        </div>
        <Field label="Censura de mídias" group hint={NSFW_LEVELS.find((l) => l.value === nsfwLevel)?.hint}>
          <Select value={nsfwLevel} onChange={(v) => setNsfwLevel(v as typeof nsfwLevel)} options={NSFW_LEVELS} />
        </Field>
        {isOwner && (
          <label className="flex items-center gap-3 text-sm">
            <Checkbox checked={ownerBadge} onChange={setOwnerBadge} />
            Mostrar o emblema de dono (★) ao lado do meu nome na lista de membros
          </label>
        )}
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
                    ...(isOwner && ownerBadge !== (server.showOwnerBadge ?? true) ? { showOwnerBadge: ownerBadge } : {}),
                    ...(nsfwLevel !== (server.nsfwLevel ?? 'moderate') ? { nsfwLevel } : {}),
                    ...(rating && rating !== server.rating ? { rating } : {}),
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
    <Modal title={`Convide amigos para ${server.name}`} subtitle="Mande este link; no chat ele vira um cartão com o botão Juntar-se." onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2 rounded-lg border border-edge bg-rail p-1.5">
          <Input readOnly value={inviteLink(server.inviteCode)} className="border-0 bg-transparent font-mono text-sm" />
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(inviteLink(server.inviteCode)).catch(() => {});
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
            Gerar novo link (o antigo para de funcionar)
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


/** Nova conversa. Com `base` (pessoas da conversa aberta), quem for adicionado forma um grupo novo com todos. */
function NewDmModal({ base = [], onClose }: { base?: string[]; onClose: () => void }) {
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);
  const [selected, setSelected] = useState<string[]>([]);
  const [username, setUsername] = useState('');
  const [groupName, setGroupName] = useState('');
  const { busy, error, run } = useAction();
  const adding = base.length > 0;
  const list = Object.values(friends).filter((f) => f.state === 'friends' && !base.includes(f.user.id));

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const added = [...selected, ...(username.trim() ? [username.trim().replace(/^@/, '')] : [])];
  const targets = [...base, ...added];

  return (
    <Modal
      title={adding ? 'Adicionar pessoas' : 'Nova conversa'}
      subtitle={
        adding
          ? 'Quem você adicionar entra num grupo novo junto com as pessoas desta conversa.'
          : 'Escolha amigos ou digite um nome de usuário. Duas pessoas ou mais viram um grupo.'
      }
      onClose={onClose}
      footer={
        <Button
          disabled={busy || added.length === 0}
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
        {adding && (
          <div className="flex flex-wrap gap-1.5">
            {base.map((id) => {
              const u = users[id];
              if (!u) return null;
              return (
                <span key={id} className="flex items-center gap-1.5 rounded-full bg-rail py-0.5 pr-2.5 pl-0.5 text-xs font-medium text-soft">
                  <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={20} />
                  {u.displayName}
                </span>
              );
            })}
          </div>
        )}
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
            <EmojiInput value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={100} />
          </Field>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

