'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, Icons } from './ui';

const BOX_W = 520;
const BOX_H = 380;
const FRAMES = {
  avatar: { w: 300, h: 300, outW: 512, outH: 512, radius: 9999 },
  banner: { w: 480, h: 160, outW: 1200, outH: 400, radius: 12 },
  /** Ícone do servidor: quadrado com cantos arredondados (squircle da barra lateral). */
  icon: { w: 300, h: 300, outW: 512, outH: 512, radius: 84 },
  /** Banner do servidor, no topo da lista de canais. */
  serverBanner: { w: 480, h: 270, outW: 960, outH: 540, radius: 12 },
};
export type CropKind = keyof typeof FRAMES;

/** "Editar mídia": arrasta para enquadrar e usa o zoom; devolve a imagem já recortada. */
export function ImageCropper({
  file,
  kind,
  onApply,
  onCancel,
}: {
  file: File;
  kind: CropKind;
  onApply: (file: File) => void;
  onCancel: () => void;
}) {
  const frame = FRAMES[kind];
  const [url, setUrl] = useState<string | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Cria o link da imagem dentro do efeito: no modo dev o React monta duas vezes e
  // revogar um link criado fora dele deixava a imagem sem carregar.
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const base = img ? Math.max(frame.w / img.naturalWidth, frame.h / img.naturalHeight) : 1;
  const scale = base * zoom;
  const dw = img ? img.naturalWidth * scale : 0;
  const dh = img ? img.naturalHeight * scale : 0;
  const clamp = (o: { x: number; y: number }, s = scale) => {
    if (!img) return o;
    const mx = Math.max(0, (img.naturalWidth * s - frame.w) / 2);
    const my = Math.max(0, (img.naturalHeight * s - frame.h) / 2);
    return { x: Math.min(mx, Math.max(-mx, o.x)), y: Math.min(my, Math.max(-my, o.y)) };
  };

  function setZoomClamped(z: number) {
    const next = Math.min(3, Math.max(1, z));
    setZoom(next);
    setOff((o) => clamp(o, base * next));
  }

  function onDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
  }
  function onMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setOff(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
  }

  async function apply() {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = frame.outW;
    canvas.height = frame.outH;
    const ctx = canvas.getContext('2d')!;
    const sx = -((frame.w - dw) / 2 + off.x) / scale;
    const sy = -((frame.h - dh) / 2 + off.y) / scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, frame.w / scale, frame.h / scale, 0, 0, frame.outW, frame.outH);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.92));
    if (!blob) return;
    onApply(new File([blob], `${kind}.webp`, { type: 'image/webp' }));
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-4" onMouseDown={onCancel}>
      <div
        role="dialog"
        aria-label="Editar mídia"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[568px] overflow-hidden rounded-2xl border border-edge bg-side shadow-2xl"
      >
        <header className="flex items-center gap-3 px-4 py-3">
          <button onClick={onCancel} title="Voltar" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
            <Icons.ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold">Editar mídia</h2>
        </header>

        <div className="px-6">
          <div
            className="relative mx-auto cursor-grab touch-none overflow-hidden rounded-xl bg-rail select-none active:cursor-grabbing"
            style={{ width: '100%', maxWidth: BOX_W, height: BOX_H }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={(e) => setZoomClamped(zoom - e.deltaY * 0.002)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) => setImg(e.currentTarget)}
              className="pointer-events-none absolute top-1/2 left-1/2 max-w-none"
              style={{ width: dw || undefined, height: dh || undefined, transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`, opacity: img ? 1 : 0 }}
            />
            )}
            {/* Área de corte: o resto fica escurecido. */}
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-white/90"
              style={{
                width: frame.w,
                height: frame.h,
                borderRadius: frame.radius,
                boxShadow: '0 0 0 9999px rgba(10, 8, 20, 0.65)',
              }}
            />
          </div>

          <div className="mx-auto mt-4 flex max-w-[360px] items-center gap-3 text-muted">
            <button onClick={() => setZoomClamped(zoom - 0.2)} title="Diminuir" className="rounded p-1 hover:text-fg">
              <Icons.ZoomOut size={18} />
            </button>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoomClamped(Number(e.target.value))}
              className="h-1.5 flex-1 cursor-pointer accent-[var(--color-accent)]"
              aria-label="Zoom"
            />
            <button onClick={() => setZoomClamped(zoom + 0.2)} title="Aumentar" className="rounded p-1 hover:text-fg">
              <Icons.ZoomIn size={18} />
            </button>
          </div>
        </div>

        <footer className="mt-4 flex items-center justify-between gap-2 bg-rail/60 px-6 py-4">
          <button
            onClick={() => {
              setZoom(1);
              setOff({ x: 0, y: 0 });
            }}
            className="text-sm text-soft hover:text-fg hover:underline"
          >
            Redefinir
          </button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancelar
            </Button>
            <Button disabled={!img} onClick={() => void apply()}>
              Aplicar
            </Button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
