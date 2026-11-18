'use client';

import { useMemo, useState } from 'react';
import { hasPerm, Perm } from '@line/shared';
import { api } from '@/lib/api';
import { actions, channelPermsOf, mentionsToText, useLine } from '@/lib/store';
import { Avatar, Button, Checkbox, cx, ErrorText, Icons, Input, Modal } from './ui';
import { EmojiTextarea } from './EmojiField';
import { toast } from './Dialogs';

/** Até quantos lugares dá para encaminhar de uma vez (igual ao servidor). */
const MAX = 5;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Encaminhar mensagem: só para canais de texto do mesmo servidor (onde a pessoa pode escrever)
 * ou para a conversa privada com um amigo. Nunca para outro servidor.
 */
export function ForwardModal({ messageId, channelId, onClose }: { messageId: string; channelId: string; onClose: () => void }) {
  const message = useLine((s) => s.messages[channelId]?.items.find((m) => m.id === messageId));
  const source = useLine((s) => s.channels[channelId]);
  const serverId = source?.serverId ?? null;
  const server = useLine((s) => (serverId ? s.servers[serverId] : null));
  const channels = useLine((s) => s.channels);
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);
  const meId = useLine((s) => s.me?.id);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const needsFiles = !!message?.attachments.length;
  const serverChannels = useMemo(() => {
    if (!serverId) return [];
    const s = useLine.getState();
    return Object.values(channels)
      .filter((c) => c.serverId === serverId && c.type === 'text' && c.base !== 'activity')
      .filter((c) => {
        const p = channelPermsOf(s, c.id, meId);
        return hasPerm(p, Perm.SendMessages) && (!needsFiles || hasPerm(p, Perm.AttachFiles));
      })
      .sort((a, b) => a.position - b.position);
  }, [channels, serverId, meId, needsFiles]);
  const friendList = useMemo(
    () => Object.values(friends).filter((f) => f.state === 'friends').map((f) => users[f.user.id] ?? f.user).sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [friends, users],
  );

  const q = norm(query.trim());
  const shownChannels = serverChannels.filter((c) => !q || norm(c.name).includes(q));
  const shownFriends = friendList.filter((u) => !q || norm(u.displayName).includes(q) || norm(u.username).includes(q));

  const toggle = (key: string) => {
    setError('');
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : p.length >= MAX ? p : [...p, key]));
  };

  async function send() {
    if (!message || !picked.length) return;
    setBusy(true);
    setError('');
    try {
      const ids: string[] = [];
      for (const key of picked) {
        if (key.startsWith('c:')) {
          ids.push(key.slice(2));
          continue;
        }
        const userId = key.slice(2);
        const s = useLine.getState();
        const existing = Object.values(s.channels).find((c) => c.type === 'dm' && c.recipients?.some((r) => r.id === userId));
        const dm = existing ?? (await api.openDm([userId]));
        if (!existing) actions.upsertChannel(dm);
        ids.push(dm.id);
      }
      await api.forwardMessage(message.id, ids, note.trim());
      toast(ids.length > 1 ? `Mensagem encaminhada para ${ids.length} lugares.` : 'Mensagem encaminhada.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const preview = message ? (message.content ? mentionsToText(message.content, serverId) : '') : '';
  const files = message?.attachments.length ?? 0;

  return (
    <Modal
      title="Encaminhar mensagem"
      subtitle={serverId ? `Para canais de ${server?.name ?? 'este servidor'} ou para amigos. Até ${MAX} de uma vez.` : `Para amigos, no privado. Até ${MAX} de uma vez.`}
      onClose={onClose}
      footer={
        <Button disabled={busy || !picked.length || !message} onClick={() => void send()}>
          {busy ? 'Enviando...' : picked.length > 1 ? `Enviar (${picked.length})` : 'Enviar'}
        </Button>
      }
    >
      <div className="space-y-3">
        {message ? (
          <div className="rounded-lg border-l-2 border-accent bg-raise px-3 py-2 text-sm">
            <p className="text-xs font-semibold text-muted">{message.author.displayName}</p>
            {preview && <p className="line-clamp-3 break-words whitespace-pre-wrap text-soft">{preview}</p>}
            {files > 0 && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                <Icons.Paperclip size={12} /> {files === 1 ? '1 anexo' : `${files} anexos`}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Essa mensagem não está mais disponível.</p>
        )}
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar canal ou amigo" autoFocus />
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {shownChannels.length > 0 && (
            <div>
              <p className="mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase">Canais deste servidor</p>
              {shownChannels.map((c) => (
                <Row key={c.id} active={picked.includes(`c:${c.id}`)} onToggle={() => toggle(`c:${c.id}`)} disabled={picked.length >= MAX && !picked.includes(`c:${c.id}`)}>
                  <span className="flex size-8 items-center justify-center rounded-lg bg-raise text-muted">
                    <Icons.Hash size={16} />
                  </span>
                  <span className="flex-1 truncate text-sm font-medium">{c.name}</span>
                </Row>
              ))}
            </div>
          )}
          {shownFriends.length > 0 && (
            <div>
              <p className="mb-1 px-2 text-[11px] font-bold tracking-wide text-muted uppercase">Amigos</p>
              {shownFriends.map((u) => (
                <Row key={u.id} active={picked.includes(`u:${u.id}`)} onToggle={() => toggle(`u:${u.id}`)} disabled={picked.length >= MAX && !picked.includes(`u:${u.id}`)}>
                  <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={32} presence={u.presence} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{u.displayName}</span>
                    <span className="block truncate text-xs text-muted">@{u.username}</span>
                  </span>
                </Row>
              ))}
            </div>
          )}
          {!shownChannels.length && !shownFriends.length && (
            <p className="px-2 py-4 text-center text-sm text-muted">{q ? 'Nada encontrado.' : 'Nenhum canal ou amigo para encaminhar.'}</p>
          )}
        </div>
        <EmojiTextarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Adicionar um comentário (opcional)" rows={2} maxLength={2000} className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent" />
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}

function Row({ active, disabled, onToggle, children }: { active: boolean; disabled?: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover', active && 'bg-accent/10', disabled && 'cursor-not-allowed opacity-50')}>
      {children}
      <Checkbox checked={active} onChange={() => !disabled && onToggle()} />
    </label>
  );
}
