'use client';

import { useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { ImageCropper, type CropKind } from './ImageCropper';
import { ImagePick } from './ProfileEditor';
import { initials } from './ui';

export type ServerImage = { id: string | null; url: string | null; changed?: boolean; uploading?: boolean };

/**
 * "Perfil do servidor": ícone (squircle da barra lateral) e banner (topo da lista de canais).
 * Usa o mesmo "Editar mídia" do perfil; GIF vai sem recorte para manter a animação.
 */
export function ServerImages({
  name,
  color,
  icon,
  banner,
  setIcon,
  setBanner,
  onError,
}: {
  name: string;
  color: string;
  icon: ServerImage;
  banner: ServerImage;
  setIcon: (i: ServerImage) => void;
  setBanner: (i: ServerImage) => void;
  onError: (msg: string) => void;
}) {
  const [crop, setCrop] = useState<{ file: File; kind: CropKind } | null>(null);
  const src = (u: string | null) => (u ? (u.startsWith('blob:') ? u : fileUrl(u)) : null);

  function pick(file: File, kind: CropKind) {
    if (file.type === 'image/gif' || !file.type.startsWith('image/')) return finish(file, kind);
    setCrop({ file, kind });
  }
  function finish(file: File, kind: CropKind) {
    if (kind === 'icon') void upload(file, icon, setIcon);
    else void upload(file, banner, setBanner);
  }
  async function upload(file: File, previous: ServerImage, set: (i: ServerImage) => void) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return onError('Escolha uma imagem (PNG, JPG, GIF ou WebP).');
    if (file.size > 8 * 1024 * 1024) return onError('A imagem precisa ter até 8 MB.');
    onError('');
    const local = URL.createObjectURL(file);
    set({ id: null, url: local, uploading: true });
    try {
      const a = await api.uploadAttachment(file, file.name || 'imagem');
      set({ id: a.id, url: local, changed: true });
    } catch (e) {
      set(previous);
      onError(`Não deu para enviar a imagem: ${(e as Error).message}`);
    }
  }

  const iconSrc = src(icon.url);
  const bannerSrc = src(banner.url);
  return (
    <div className="flex gap-4">
      <div className="shrink-0 text-center">
        <p className="mb-1.5 text-xs font-bold tracking-wide text-muted uppercase">Ícone</p>
        <ImagePick onFile={(f) => pick(f, 'icon')} className="h-20 w-20 overflow-hidden rounded-[24px]">
          {iconSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-xl font-bold text-rail" style={{ background: color }}>
              {initials(name || '?')}
            </span>
          )}
        </ImagePick>
        {icon.url && (
          <button className="mt-1 text-xs text-muted hover:text-danger hover:underline" onClick={() => setIcon({ id: null, url: null, changed: true })}>
            Remover
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-xs font-bold tracking-wide text-muted uppercase">Banner</p>
        <ImagePick onFile={(f) => pick(f, 'serverBanner')} className="aspect-video w-full overflow-hidden rounded-xl border border-edge">
          {bannerSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bannerSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-rail text-sm text-muted">Clique para escolher (PNG, JPG, GIF)</span>
          )}
        </ImagePick>
        {banner.url && (
          <button className="mt-1 text-xs text-muted hover:text-danger hover:underline" onClick={() => setBanner({ id: null, url: null, changed: true })}>
            Remover banner
          </button>
        )}
      </div>
      {crop && (
        <ImageCropper
          file={crop.file}
          kind={crop.kind}
          onCancel={() => setCrop(null)}
          onApply={(f) => {
            setCrop(null);
            finish(f, crop.kind);
          }}
        />
      )}
    </div>
  );
}
