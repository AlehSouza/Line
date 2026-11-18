// Seletor de cor próprio do Line (substitui o <input type="color"> nativo).
// Área de saturação/brilho, barra de matiz e campo que aceita só hexadecimal (#RRGGBB).
import { createPortal } from 'react-dom';
import { placeAround, useFloating } from '@/lib/floating';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(' ');

type Hsv = { h: number; s: number; v: number };

const HEX = /^#[0-9a-f]{6}$/i;

export function normalizeHex(raw: string): string | null {
  let t = raw.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toLowerCase()}` : null;
}

function hexToHsv(hex: string): Hsv {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const move = (ev: PointerEvent | React.PointerEvent) => {
      const r = el.getBoundingClientRect();
      onMove(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    move(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { ref, start };
}

/** Painel do seletor (área SV + matiz + campo hex). */
export function ColorPanel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(normalizeHex(value) ?? '#7c6af2'));
  const [text, setText] = useState((normalizeHex(value) ?? '#7c6af2').toUpperCase());
  const last = useRef(normalizeHex(value));

  // Valor mudou de fora (ex.: clicou numa cor pronta): sincroniza.
  useEffect(() => {
    const hex = normalizeHex(value);
    if (hex && hex !== last.current) {
      last.current = hex;
      setHsv(hexToHsv(hex));
      setText(hex.toUpperCase());
    }
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    last.current = hex;
    setText(hex.toUpperCase());
    onChange(hex);
  };

  const sv = useDrag((x, y) => commit({ ...hsv, s: x, v: 1 - y }));
  const hue = useDrag((x) => commit({ ...hsv, h: Math.min(359.9, x * 360) }));
  const hex = hsvToHex(hsv);
  const valid = HEX.test(text);

  return (
    <div className="w-60 select-none">
      <div
        ref={sv.ref}
        onPointerDown={sv.start}
        className="relative h-36 w-full cursor-crosshair overflow-hidden rounded-lg"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
      >
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>
      <div
        ref={hue.ref}
        onPointerDown={hue.start}
        className="relative mt-3 h-3 w-full cursor-pointer rounded-full"
        style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="h-8 w-8 shrink-0 rounded-md border border-edge" style={{ background: hex }} />
        <input
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-label="Cor em hexadecimal"
          onChange={(e) => {
            // Só aceita dígitos hexadecimais, sempre com # na frente.
            const clean = '#' + e.target.value.replace(/[^0-9a-f]/gi, '').slice(0, 6).toUpperCase();
            setText(clean);
            if (HEX.test(clean)) {
              const h = clean.toLowerCase();
              last.current = h;
              setHsv(hexToHsv(h));
              onChange(h);
            }
          }}
          onBlur={() => setText(hex.toUpperCase())}
          className={cx(
            'min-w-0 flex-1 rounded-lg border bg-rail px-3 py-1.5 font-mono text-sm uppercase text-fg outline-none',
            valid ? 'border-edge focus:border-accent' : 'border-danger',
          )}
        />
      </div>
    </div>
  );
}

/** Botão que abre o seletor de cor do Line num balão. */
export function ColorPicker({
  value,
  onChange,
  title,
  className,
  style,
  children,
}: {
  value: string | null | undefined;
  onChange: (hex: string) => void;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Captura: modais param a propagação do clique, e aí o seletor não fechava.
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  // Abaixo do botão, ou acima se não couber: medido antes de aparecer.
  const { style: pos } = useFloating(pop, (w, h, lock) => {
    const r = button.current?.getBoundingClientRect();
    return r ? placeAround(r, w, h, { lock }) : null;
  });

  return (
    <>
      <button ref={button} type="button" title={title} onClick={() => setOpen((v) => !v)} className={className} style={style}>
        {children}
      </button>
      {open &&
        createPortal(
          <div ref={pop} data-color-panel className="fixed z-[250] rounded-xl border border-edge bg-side p-3 shadow-2xl" style={pos}>
            <ColorPanel value={value ?? '#7c6af2'} onChange={onChange} />
          </div>,
          document.body,
        )}
    </>
  );
}
