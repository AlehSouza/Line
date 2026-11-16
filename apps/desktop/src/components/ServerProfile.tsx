'use client';

import { hasPerm, Perm } from '@line/shared';
import { useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, permsOf, useLine } from '@/lib/store';
import { toast } from './Dialogs';
import { EmojiInput, EmojiTextarea } from './EmojiField';
import { ImagePick } from './ProfileEditor';
import { Avatar, Button, ErrorText, Field, Modal } from './ui';

type Img = { id: string | null; url: string | null; changed: boolean; uploading?: boolean };

/** "Editar perfil por servidor": apelido, foto, banner e bio que só valem neste servidor. */
export function ServerProfileModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const me = useLine((s) => s.me);
  const server = useLine((s) => s.servers[serverId]);
  const member = useLine((s) => (s.me ? s.members[serverId]?.[s.me.id] : undefined));
  const canNick = useLine((s) => {
    const p = permsOf(s, serverId, s.me?.id);
    return hasPerm(p, Perm.ChangeNickname) || hasPerm(p, Perm.ManageNicknames);
  });
  const [nick, setNick] = useState(member?.nickname ?? '');
  const [bio, setBio] = useState(member?.profile?.bio ?? '');
  const [avatar, setAvatar] = useState<Img>({ id: null, url: member?.profile?.avatarUrl ?? null, changed: false });
  const [banner, setBanner] = useState<Img>({ id: null, url: member?.profile?.bannerUrl ?? null, changed: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!me || !server) return null;

  async function upload(file: File, set: (i: Img) => void, prev: Img) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return setError('Escolha uma imagem (PNG, JPG, GIF ou WebP).');
    if (file.size > 8 * 1024 * 1024) return setError('A imagem precisa ter até 8 MB.');
    setError('');
    const local = URL.createObjectURL(file);
    set({ id: null, url: local, changed: true, uploading: true });
    try {
      const a = await api.uploadAttachment(file, file.name || 'imagem');
      set({ id: a.id, url: local, changed: true });
    } catch (e) {
      set(prev);
      setError((e as Error).message);
    }
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (canNick && (nick.trim() || null) !== (member?.nickname ?? null)) {
        actions.upsertMember(await api.setNickname(serverId, me!.id, nick.trim() || null));
      }
      actions.upsertMember(
        await api.setServerProfile(serverId, {
          bio: bio.trim(),
          ...(avatar.changed ? { avatarId: avatar.id } : {}),
          ...(banner.changed ? { bannerId: banner.id } : {}),
        }),
      );
      toast('Perfil do servidor salvo.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const src = (u: string | null) => (u ? (u.startsWith('blob:') ? u : fileUrl(u)) : null);
  const shownBanner = src(banner.url) ?? (me.bannerUrl ? fileUrl(me.bannerUrl) : null);
  const shownAvatar = avatar.url ?? me.avatarUrl;
  const uploading = avatar.uploading || banner.uploading;

  return (
    <Modal
      title="Editar perfil por servidor"
      subtitle={`Só aparece em ${server.name}. O que ficar vazio usa o seu Perfil Principal.`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || uploading} onClick={() => void save()}>
            {uploading ? 'Enviando imagem…' : busy ? 'Salvando…' : 'Salvar'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="overflow-hidden rounded-xl border border-edge bg-rail">
          <ImagePick onFile={(f) => void upload(f, setBanner, banner)} className="h-24 w-full">
            <div className="h-full w-full" style={shownBanner ? undefined : { background: me.avatarColor }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {shownBanner && <img src={shownBanner} alt="" className="h-full w-full object-cover" />}
            </div>
          </ImagePick>
          <div className="-mt-9 px-4 pb-3">
            <span className="inline-block rounded-full border-4 border-rail">
              <ImagePick onFile={(f) => void upload(f, setAvatar, avatar)} round className="rounded-full">
                {shownAvatar?.startsWith('blob:') ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shownAvatar} alt="" className="h-16 w-16 rounded-full object-cover" />
                ) : (
                  <Avatar name={me.displayName} color={me.avatarColor} src={shownAvatar} size={64} />
                )}
              </ImagePick>
            </span>
            <div className="flex flex-wrap gap-x-3 text-xs">
              {avatar.url && (
                <button className="text-soft hover:text-danger hover:underline" onClick={() => setAvatar({ id: null, url: null, changed: true })}>
                  Usar a foto do perfil principal
                </button>
              )}
              {banner.url && (
                <button className="text-soft hover:text-danger hover:underline" onClick={() => setBanner({ id: null, url: null, changed: true })}>
                  Usar o banner do perfil principal
                </button>
              )}
            </div>
          </div>
        </div>
        <Field label="Apelido" hint={canNick ? undefined : 'Você não tem permissão para mudar o apelido neste servidor.'}>
          <EmojiInput value={nick} disabled={!canNick} onChange={(e) => setNick(e.target.value)} maxLength={32} placeholder={me.displayName} />
        </Field>
        <Field label="Sobre mim neste servidor">
          <EmojiTextarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={190}
            rows={3}
            placeholder={me.bio || 'Vazio usa a bio do perfil principal'}
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </Field>
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
