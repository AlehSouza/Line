'use client';

import type { ChannelLook } from '@line/shared';
import { useRef, useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { ColorPicker } from './ColorPicker';
import { showError } from './Dialogs';
import { cx, Icons, Slider } from './ui';

/** Intensidade da cor por cima quando ninguém escolheu ainda. */
export const DEFAULT_LOOK_OPACITY = 40;
const DEFAULT_LOOK_COLOR = '#000000';

/** Fundo da área da chamada: a imagem do canal e a cor por cima. Fica atrás de tudo. */
export function ChannelBackdrop({ look }: { look: ChannelLook | null | undefined }) {
  if (!look || (!look.image && !look.color)) return null;
  const opacity = (look.opacity ?? DEFAULT_LOOK_OPACITY) / 100;
  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden bg-rail">
      {look.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileUrl(look.image)}
          alt=""
          draggable={false}
          // Imagem que não carrega (arquivo sumiu do servidor) não mostra o ícone de quebrada.
          onError={(e) => (e.currentTarget.style.display = 'none')}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {look.color && opacity > 0 && <span className="absolute inset-0" style={{ background: look.color, opacity }} />}
    </div>
  );
}

/** Aba "Personalização" do Editar canal (voz): papel de parede, cor da sobreposição e intensidade. */
export function ChannelLookEditor({ look, onChange, title }: { look: ChannelLook | null; onChange: (look: ChannelLook | null) => void; title: string }) {
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const color = look?.color ?? null;
  const opacity = look?.opacity ?? DEFAULT_LOOK_OPACITY;

  function change(next: ChannelLook) {
    onChange(next.image || next.color ? next : null);
  }

  async function upload(f: File) {
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') return showError(new Error('Escolha uma imagem (PNG, JPG, GIF ou WebP).'));
    if (f.size > 8 * 1024 * 1024) return showError(new Error('A imagem precisa ter até 8 MB.'));
    setUploading(true);
    try {
      const a = await api.uploadAttachment(f, f.name || 'imagem');
      // Primeira imagem já vem com um véu escuro para os quadros e textos continuarem legíveis.
      change({ ...look, image: a.url, color: look?.color ?? DEFAULT_LOOK_COLOR, opacity });
    } catch (e) {
      showError(e);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-edge"
        style={{
          background:
            'radial-gradient(120% 80% at 50% 110%, color-mix(in srgb, var(--color-accent) 70%, transparent) 0%, color-mix(in srgb, var(--color-accent) 25%, transparent) 45%, transparent 75%), linear-gradient(to bottom, var(--color-rail), color-mix(in srgb, var(--color-accent) 18%, var(--color-rail)))',
        }}
      >
        <ChannelBackdrop look={look} />
        <div className="relative flex flex-col items-center gap-1 px-4 text-center">
          <span className="max-w-full truncate text-xl font-bold text-white drop-shadow">{title}</span>
          <span className="text-xs text-white/80 drop-shadow">Assim todos veem a chamada deste canal.</span>
        </div>
        <button
          type="button"
          title={look?.image ? 'Trocar papel de parede' : 'Escolher papel de parede'}
          disabled={uploading}
          onClick={() => file.current?.click()}
          className="absolute top-2.5 right-2.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 disabled:opacity-50"
        >
          {uploading ? <Icons.Refresh size={14} className="animate-spin" /> : <Icons.Edit size={15} />}
        </button>
      </div>

      <div>
        <p className="mb-2 text-sm font-semibold text-soft">Papel de parede</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => file.current?.click()}
            className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-sm font-semibold text-soft hover:bg-raise disabled:opacity-50"
          >
            <Icons.Camera size={15} /> {uploading ? 'Enviando…' : look?.image ? 'Trocar imagem' : 'Enviar imagem'}
          </button>
          {look?.image && (
            <button
              type="button"
              onClick={() => change({ ...look, image: null })}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm font-semibold text-soft hover:bg-raise"
            >
              Remover
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted">PNG, JPG, GIF ou WebP de até 8 MB. Aparece atrás das pessoas na chamada.</p>
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
        <p className="mb-2 text-sm font-semibold text-soft">Cor da sobreposição</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => change({ ...look, color: null })}
            className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', !color ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
          >
            Nenhuma
          </button>
          <button
            type="button"
            onClick={() => !color && change({ ...look, color: DEFAULT_LOOK_COLOR, opacity })}
            className={cx('rounded-lg border px-3 py-1.5 text-sm font-semibold', color ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
          >
            Cor
          </button>
          {color && (
            <ColorPicker
              value={color}
              onChange={(c) => change({ ...look, color: c, opacity })}
              title="Escolher a cor"
              className="size-8 rounded-lg border-2 border-white/70 shadow"
              style={{ background: color }}
            />
          )}
        </div>
      </div>

      {color && (
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-semibold text-soft">Intensidade da sobreposição</span>
            <span className="text-muted tabular-nums">{opacity}%</span>
          </div>
          <Slider value={opacity} onChange={(v) => change({ ...look, color, opacity: v })} className="w-full" label="Intensidade da sobreposição" />
          <p className="mt-1 text-xs text-muted">Quanto mais alto, mais a cor cobre o papel de parede.</p>
        </div>
      )}
    </div>
  );
}
