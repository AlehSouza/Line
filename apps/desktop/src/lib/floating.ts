import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/**
 * Posicionamento único de cartões, popovers, menus e dropdowns.
 *
 * Regra: nada aparece antes de saber onde cabe. A caixa é montada invisível
 * (opacity 0, para o autoFocus de campos dentro dela continuar funcionando), medida antes da pintura, posicionada e só então mostrada.
 * Se o conteúdo ainda está carregando (`ready` falso), ela continua invisível até
 * carregar (ou até um tempo máximo), para não abrir embaixo e pular para cima.
 * Depois de aberta, mudanças de tamanho reposicionam sem trocar de lado.
 */

export type Pos = { left: number; top: number };
export type Side = 'below' | 'above' | 'right' | 'left';
type Rect = { left: number; right: number; top: number; bottom: number };

const MARGIN = 8;

/**
 * Lugar de uma caixa w×h em volta de um retângulo (botão, tag, item).
 * Abre no lado preferido se couber; senão no outro; se nenhum couber, no que tiver mais espaço.
 * `lock` força um lado (usado para não trocar de lado depois de aberta).
 */
export function placeAround(
  r: Rect,
  w: number,
  h: number,
  opts: { gap?: number; align?: 'start' | 'end'; prefer?: 'below' | 'above'; lock?: Side | null; margin?: number } = {},
): Pos & { side: 'below' | 'above' } {
  const { gap = 6, align = 'start', prefer = 'below', lock = null, margin = MARGIN } = opts;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - r.bottom - gap - margin;
  const spaceAbove = r.top - gap - margin;
  let side: 'below' | 'above';
  if (lock === 'below' || lock === 'above') side = lock;
  else if (prefer === 'below') side = h <= spaceBelow || spaceBelow >= spaceAbove ? 'below' : 'above';
  else side = h <= spaceAbove || spaceAbove >= spaceBelow ? 'above' : 'below';
  const rawTop = side === 'below' ? r.bottom + gap : r.top - gap - h;
  const top = clamp(rawTop, margin, vh - h - margin);
  const rawLeft = align === 'end' ? r.right - w : r.left;
  return { left: clamp(rawLeft, margin, vw - w - margin), top, side };
}

/**
 * Lugar de uma caixa w×h ao lado de um retângulo: à direita se couber, senão à esquerda
 * (ou no lado com mais espaço), alinhada ao topo dele. `lock` mantém o lado depois de aberta.
 */
export function placeBeside(
  r: Rect,
  w: number,
  h: number,
  opts: { gap?: number; lock?: Side | null; margin?: number } = {},
): Pos & { side: 'right' | 'left' } {
  const { gap = 6, lock = null, margin = MARGIN } = opts;
  const vw = window.innerWidth;
  const spaceRight = vw - r.right - gap - margin;
  const spaceLeft = r.left - gap - margin;
  const side = lock === 'right' || lock === 'left' ? lock : (w <= spaceRight || spaceRight >= spaceLeft ? 'right' : 'left');
  const rawLeft = side === 'right' ? r.right + gap : r.left - gap - w;
  return { left: clamp(rawLeft, margin, vw - w - margin), top: clamp(r.top, margin, window.innerHeight - h - margin), side };
}

/** Lugar de uma caixa w×h num ponto (clique com o botão direito), sem sair da tela. */
export function placeAt(x: number, y: number, w: number, h: number, margin = MARGIN): Pos {
  return { left: clamp(x, margin, window.innerWidth - w - margin), top: clamp(y, margin, window.innerHeight - h - margin) };
}

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, Math.max(min, max)));
}

/**
 * Mede a caixa em `ref` antes de pintar e a posiciona com `place(largura, altura, ladoTravado)`.
 * Retorna o estilo a aplicar (left/top + invisível até posicionar). `place` pode devolver `side`: depois que a
 * caixa já apareceu, o lado fica travado (só desliza para caber, não pula de baixo para cima).
 * `ready` falso mantém a caixa invisível enquanto o conteúdo carrega (no máximo 700 ms).
 */
export function useFloating(
  ref: RefObject<HTMLElement | null>,
  place: (w: number, h: number, lock: Side | null) => (Pos & { side?: Side }) | null,
  ready = true,
) {
  const [state, setState] = useState<{ pos: Pos | null; visible: boolean }>({ pos: null, visible: false });
  const [late, setLate] = useState(false);
  const placeRef = useRef(place);
  placeRef.current = place;
  const canShow = useRef(false);
  canShow.current = ready || late;
  const visibleRef = useRef(false);
  const sideRef = useRef<Side | null>(null);

  const observed = useRef<HTMLElement | null>(null);
  const ro = useRef<ResizeObserver | null>(null);

  const run = useRef(() => {
    const el = ref.current;
    if (!el) {
      // Fechou: na próxima abertura começa invisível e escolhe o lado de novo.
      visibleRef.current = false;
      sideRef.current = null;
      setState((prev) => (prev.pos || prev.visible ? { pos: null, visible: false } : prev));
      return;
    }
    const p = placeRef.current(el.offsetWidth, el.offsetHeight, visibleRef.current ? sideRef.current : null);
    if (!p) return;
    sideRef.current = p.side ?? null;
    const visible = visibleRef.current || canShow.current;
    visibleRef.current = visible;
    setState((prev) =>
      prev.pos && prev.pos.left === p.left && prev.pos.top === p.top && prev.visible === visible
        ? prev
        : { pos: { left: p.left, top: p.top }, visible },
    );
  }).current;

  // A cada renderização (abriu, conteúdo carregou, abriu um submenu): mede de novo antes de pintar.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== observed.current) {
      // Mudanças de tamanho fora do React (imagem carregou): reposiciona no mesmo quadro.
      if (!ro.current && typeof ResizeObserver !== 'undefined') ro.current = new ResizeObserver(() => flushSync(run));
      if (observed.current) ro.current?.unobserve(observed.current);
      if (el) ro.current?.observe(el);
      observed.current = el;
    }
    run();
  });

  useLayoutEffect(() => {
    window.addEventListener('resize', run);
    window.addEventListener('scroll', run, true);
    return () => {
      ro.current?.disconnect();
      ro.current = null;
      observed.current = null;
      window.removeEventListener('resize', run);
      window.removeEventListener('scroll', run, true);
    };
  }, [run]);

  // Conteúdo demorando: mostra assim mesmo depois de um tempo.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setLate(true), 700);
    return () => clearTimeout(t);
  }, [ready]);

  const { pos, visible } = state;
  const style: CSSProperties = { left: pos?.left ?? 0, top: pos?.top ?? 0, ...(visible ? null : { opacity: 0, pointerEvents: 'none' as const }) };
  return { pos, shown: visible, style };
}
