'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Tooltip do Line (mesmo visual do tooltip do ping): balão escuro arredondado com setinha,
 * acima do elemento e centralizado (vai para baixo quando não cabe em cima).
 *
 * Funciona sozinho em todo o app: qualquer elemento com `title="..."` (ou `data-tip="..."`)
 * ganha este tooltip. O `title` é trocado por `data-tip` no primeiro hover, então o balão
 * quadrado nativo do sistema nunca aparece. Use `data-tip-side="bottom"` para forçar embaixo.
 */

type Tip = { text: string; rect: DOMRect; side: 'top' | 'bottom' };

const SELECTOR = '[title], [data-tip]';
const DELAY = 120;

/** Troca o title nativo por data-tip e devolve o texto do tooltip. */
function claim(el: Element): string {
  const title = el.getAttribute('title');
  if (title != null) {
    el.removeAttribute('title');
    if (title) el.setAttribute('data-tip', title);
    else el.removeAttribute('data-tip');
  }
  return el.getAttribute('data-tip') ?? '';
}

function findTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  // Ignora o <title> do documento e tags <title> de SVG.
  const el = node.closest(SELECTOR);
  if (!el || el.tagName.toLowerCase() === 'title') return null;
  return el;
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const current = useRef<Element | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const observer = useRef<MutationObserver | null>(null);
  const open = useRef(false);
  open.current = !!tip;

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      observer.current?.disconnect();
      current.current = null;
      setTip(null);
    };

    const show = (el: Element) => {
      const text = claim(el);
      if (!text) return hide();
      const side = el.getAttribute('data-tip-side') === 'bottom' ? 'bottom' : 'top';
      setTip({ text, rect: el.getBoundingClientRect(), side });
    };

    const watch = (el: Element) => {
      observer.current?.disconnect();
      // Texto que muda enquanto o mouse está em cima (ex.: ping, "Mutar"/"Desmutar").
      observer.current = new MutationObserver(() => {
        if (current.current === el) show(el);
      });
      observer.current.observe(el, { attributes: true, attributeFilter: ['title', 'data-tip'] });
    };

    const onOver = (e: Event) => {
      const el = findTarget(e.target);
      if (el === current.current) return;
      if (!el) return hide();
      claim(el); // tira o title já, antes do sistema mostrar o balão nativo
      window.clearTimeout(timer.current);
      current.current = el;
      watch(el);
      // Se já tem um tooltip aberto, troca na hora (passar o mouse por uma fileira de botões).
      if (open.current) show(el);
      else timer.current = window.setTimeout(() => current.current === el && show(el), DELAY);
    };

    const onOut = (e: PointerEvent) => {
      if (!current.current) return;
      const to = e.relatedTarget;
      if (to instanceof Node && current.current.contains(to)) return;
      if (findTarget(to) === current.current) return;
      hide();
    };

    // O elemento pode sumir da tela (modal fechou, lista mudou) sem disparar pointerout.
    const sweep = window.setInterval(() => {
      if (current.current && !current.current.isConnected) hide();
    }, 250);

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    document.addEventListener('focusin', onOver, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.clearInterval(sweep);
      window.clearTimeout(timer.current);
      observer.current?.disconnect();
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('focusin', onOver, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, []);

  if (!tip || typeof document === 'undefined') return null;
  return createPortal(<Bubble tip={tip} />, document.body);
}

function Bubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'top' | 'bottom'; arrow: number } | null>(null);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    const r = tip.rect;
    const gap = 8;
    const margin = 6;
    let side = tip.side;
    if (side === 'top' && r.top - height - gap < margin) side = 'bottom';
    else if (side === 'bottom' && r.bottom + height + gap > window.innerHeight - margin) side = 'top';
    const center = r.left + r.width / 2;
    const left = Math.min(Math.max(center - width / 2, margin), window.innerWidth - width - margin);
    const top = side === 'top' ? r.top - height - gap : r.bottom + gap;
    const arrow = Math.min(Math.max(center - left, 10), width - 10);
    setPos({ left, top, side, arrow });
  }, [tip]);

  return (
    <div
      ref={ref}
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      className="line-tip pointer-events-none fixed z-[100] max-w-72 rounded-lg bg-rail px-2.5 py-1.5 text-sm font-bold break-words text-fg shadow-lg shadow-black/40"
    >
      {tip.text}
      {pos && (
        <span
          style={{ left: pos.arrow }}
          className={
            pos.side === 'top'
              ? 'absolute top-full -translate-x-1/2 border-x-[6px] border-t-[6px] border-x-transparent border-t-rail'
              : 'absolute bottom-full -translate-x-1/2 border-x-[6px] border-b-[6px] border-x-transparent border-b-rail'
          }
        />
      )}
    </div>
  );
}
