'use client';

import type { CallLook } from '@line/shared';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, fileUrl } from '@/lib/api';
import { StyledName } from '@/lib/nameStyle';
import { useLine } from '@/lib/store';
import { ColorPicker } from './ColorPicker';
import { showError } from './Dialogs';
import { Avatar, cx, Icons } from './ui';

/** Opacidade fixa do visual: nunca fica 100% para não brigar com a foto da pessoa. */
const LAYER_OPACITY = 0.5;

/** Visual de chamada de cada pessoa (vem do perfil; busca uma vez por sessão). */
const useLooks = create<Record<string, CallLook | null>>(() => ({}));
const asked = new Set<string>();

export function setCallLook(userId: string, look: CallLook | null) {
  asked.add(userId);
  useLooks.setState({ [userId]: look });
}

export function useCallLook(userId: string | undefined): CallLook | null {
  const look = useLooks((s) => (userId ? s[userId] : undefined));
  useEffect(() => {
    if (!userId || asked.has(userId)) return;
    asked.add(userId);
    api.profile(userId).then((p) => useLooks.setState({ [userId]: p.callLook ?? null }), () => useLooks.setState({ [userId]: null }));
  }, [userId]);
  return look ?? null;
}

/** Camadas do visual por trás da foto no quadro da chamada (fundo meio transparente e borda). */
export function CallLookLayers({ look }: { look: CallLook | null }) {
  if (!look) return null;
  return (
    <>
      {look.bg === 'color' && look.color && <span className="pointer-events-none absolute inset-0" style={{ background: look.color, opacity: LAYER_OPACITY }} />}
      {look.bg === 'image' && look.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileUrl(look.image)}
          alt=""
          draggable={false}
          // Imagem que não carrega (arquivo sumiu do servidor) não mostra o ícone de quebrada.
          onError={(e) => (e.currentTarget.style.display = 'none')}
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ opacity: LAYER_OPACITY }}
        />
      )}
      {look.border && (
        <span
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{ boxShadow: `inset 0 0 0 3px color-mix(in srgb, ${look.border} 70%, transparent)` }}
        />
      )}
    </>
  );
}

/** Foto no quadro da chamada, com a borda escolhida em volta. */
export function CallLookAvatar({ look, children }: { look: CallLook | null; children: React.ReactNode }) {
  return (
    <span className="relative flex rounded-full" style={look?.ring ? { boxShadow: `0 0 0 3px ${look.ring}` } : undefined}>
      {children}
    </span>
  );
}

/** Aba "Chamada" do Editar perfil: prévia do quadro e as opções. Salva sozinho. */
export function CallLookEditor() {
  const me = useLine((s) => s.me);
  const saved = useCallLook(me?.id);
  const [look, setLook] = useState<CallLook>({});
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const loaded = useRef(false);

  useEffect(() => {
    if (saved && !loaded.current) {
      loaded.current = true;
      setLook(saved);
    }
  }, [saved]);

  if (!me) return null;

  /** Muda na hora e salva um pouquinho depois (o seletor de cor dispara muitas mudanças). */
  function change(next: CallLook) {
    loaded.current = true;
    setLook(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const clean = next.bg || next.border || next.ring ? next : null;
      setCallLook(me!.id, clean);
      api.updateProfileExtras({ callLook: clean }).catch(showError);
    }, 500);
  }

  async function upload(f: File) {
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') return showError(new Error('Escolha uma imagem (PNG, JPG, GIF ou WebP).'));
    if (f.size > 8 * 1024 * 1024) return showError(new Error('A imagem precisa ter até 8 MB.'));
    setUploading(true);
    try {
      const a = await api.uploadAttachment(f, f.name || 'imagem');
      change({ ...look, bg: 'image', image: a.url });
    } catch (e) {
      showError(e);
    } finally {
      setUploading(false);
    }
  }

  const bg = look.bg ?? null;
  return (
    <div className="space-y-5">
      <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl" style={{ background: `color-mix(in srgb, ${me.avatarColor} 35%, #1a1a1f)` }}>
        <CallLookLayers look={look} />
        <CallLookAvatar look={look}>
          <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={72} />
        </CallLookAvatar>
        <button
          type="button"
          title="Trocar imagem de fundo"
          disabled={uploading}
          onClick={() => file.current?.click()}
          className="absolute top-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-50"
        >
          {uploading ? <Icons.Refresh size={14} className="animate-spin" /> : <Icons.Edit size={15} />}
        </button>
        <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 overflow-hidden rounded-md bg-black/60 px-2 py-0.5 text-sm font-medium whitespace-nowrap">
          <span className="min-w-0 truncate"><StyledName user={me}>{me.displayName}</StyledName></span>
        </span>
      </div>
      <p className="-mt-3 text-xs text-muted">Como os outros te veem na chamada quando a câmera está desligada. Fica sempre meio transparente para a sua foto aparecer.</p>

      <div>
        <p className="mb-2 text-xs font-bold text-soft">Fundo</p>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              [null, 'Padrão'],
              ['color', 'Cor sólida'],
              ['image', 'Imagem'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => (id === 'image' && !look.image ? file.current?.click() : change({ ...look, bg: id, color: id === 'color' ? look.color ?? me.avatarColor : look.color }))}
              className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', bg === id ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
            >
              {label}
            </button>
          ))}
        </div>
        {bg === 'color' && (
          <div className="mt-3 flex items-center gap-2 text-xs text-soft">
            <ColorPicker value={look.color ?? me.avatarColor} onChange={(c) => change({ ...look, color: c })} className="size-8 rounded-lg border-2 border-white/70 shadow" style={{ background: look.color ?? me.avatarColor }} />
            Cor do fundo
          </div>
        )}
        {bg === 'image' && (
          <button type="button" disabled={uploading} onClick={() => file.current?.click()} className="mt-3 flex items-center gap-1.5 text-xs text-soft hover:text-fg hover:underline disabled:opacity-50">
            <Icons.Camera size={14} /> {uploading ? 'Enviando…' : 'Trocar imagem'}
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-bold text-soft">Borda da foto</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => change({ ...look, ring: look.ring ? null : me.avatarColor })}
            className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', look.ring ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
          >
            {look.ring ? 'Com borda' : 'Sem borda'}
          </button>
          {look.ring && (
            <ColorPicker value={look.ring} onChange={(c) => change({ ...look, ring: c })} className="size-8 rounded-lg border-2 border-white/70 shadow" style={{ background: look.ring }} />
          )}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-bold text-soft">Borda do quadro</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => change({ ...look, border: look.border ? null : me.avatarColor })}
            className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', look.border ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
          >
            {look.border ? 'Com borda' : 'Sem borda'}
          </button>
          {look.border && (
            <ColorPicker value={look.border} onChange={(c) => change({ ...look, border: c })} className="size-8 rounded-lg border-2 border-white/70 shadow" style={{ background: look.border }} />
          )}
        </div>
      </div>
    </div>
  );
}
