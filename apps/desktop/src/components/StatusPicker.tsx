'use client';

import type { UserStatus } from '@line/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { cx, Icons, PresenceDot } from './ui';

type Option = { value: UserStatus; label: string; hint?: string; presence: 'online' | 'idle' | 'dnd' | 'offline' };

export const statusOptions: Option[] = [
  { value: 'online', label: 'Disponível', presence: 'online' },
  { value: 'idle', label: 'Ausente', presence: 'idle' },
  { value: 'dnd', label: 'Não perturbar', hint: 'Você não receberá notificações na área de trabalho', presence: 'dnd' },
  { value: 'invisible', label: 'Invisível', hint: 'Você vai aparecer off-line', presence: 'offline' },
];

/** Durações do submenu (minutos; undefined = para sempre). */
const durations: { label: string; minutes?: number }[] = [
  { label: 'Por 15 minutos', minutes: 15 },
  { label: 'Por 1 hora', minutes: 60 },
  { label: 'Por 8 horas', minutes: 480 },
  { label: 'Por 24 horas', minutes: 1440 },
  { label: 'Por 3 dias', minutes: 4320 },
  { label: 'Para sempre' },
];

const MENU_W = 280;
const SUB_W = 190;

function untilLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `até ${time}`;
  return `até ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

/** Botão do status no cartão do próprio usuário, com menu lateral e submenu de duração. */
export function StatusPicker({
  status,
  until,
  onPick,
}: {
  status: UserStatus;
  until: string | null;
  onPick: (status: UserStatus, minutes?: number) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'right' | 'left' } | null>(null);
  const [sub, setSub] = useState<{ value: UserStatus; top: number } | null>(null);
  const current = statusOptions.find((o) => o.value === status) ?? statusOptions[0]!;

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = menuRef.current?.offsetHeight ?? 220;
    // Abre ao lado do cartão, no lado que couber (e o submenu junto).
    const right = r.right + 12 + MENU_W + SUB_W <= vw || r.left - 12 - MENU_W < 0;
    const left = right ? Math.min(r.right + 12, vw - MENU_W - 8) : r.left - 12 - MENU_W;
    const top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), vh - h - 8);
    setPos({ left: Math.max(8, left), top, side: right ? 'right' : 'left' });
  }, [open]);

  function pick(value: UserStatus, minutes?: number) {
    setOpen(false);
    setSub(null);
    onPick(value, minutes);
  }

  const subLeft = pos ? (pos.side === 'right' ? pos.left + MENU_W - 2 : pos.left - SUB_W + 2) : 0;

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'flex w-full items-center gap-2.5 rounded-lg border border-edge bg-side/70 px-3 py-2 text-left text-sm hover:bg-hover',
          open && 'bg-hover',
        )}
      >
        <PresenceDot presence={current.presence} ring="side" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{current.label}</span>
          {until && status !== 'online' && <span className="block text-xs text-muted">{untilLabel(until)}</span>}
        </span>
        <Icons.ChevronRight size={16} className="text-muted" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-[60]"
            onMouseDown={(e) => {
              e.stopPropagation();
              setOpen(false);
              setSub(null);
            }}
          />
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[61] rounded-lg border border-edge bg-rail p-1.5 shadow-2xl"
            style={{ width: MENU_W, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
            onMouseLeave={(e) => {
              // Saiu do menu sem ir para o submenu.
              const to = e.relatedTarget as Node | null;
              if (!to || !(to instanceof Node) || !document.getElementById('status-sub')?.contains(to)) setSub(null);
            }}
          >
            {statusOptions.map((o, i) => {
              const hasSub = o.value !== 'online';
              const active = sub?.value === o.value;
              return (
                <div key={o.value}>
                  {i === 1 && <div className="mx-2 my-1 h-px bg-edge" />}
                  <button
                    role="menuitem"
                    onMouseEnter={(e) => {
                      if (!hasSub) return setSub(null);
                      const r = e.currentTarget.getBoundingClientRect();
                      setSub({ value: o.value, top: r.top });
                    }}
                    onClick={() => pick(o.value)}
                    className={cx(
                      'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-hover',
                      (active || status === o.value) && 'bg-hover',
                    )}
                  >
                    <PresenceDot presence={o.presence} ring="rail" className="mt-1.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{o.label}</span>
                      {o.hint && <span className="block text-xs text-muted">{o.hint}</span>}
                    </span>
                    {hasSub && <Icons.ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" />}
                  </button>
                </div>
              );
            })}
          </div>

          {sub && pos && (
            <div
              id="status-sub"
              role="menu"
              className="fixed z-[62] rounded-lg border border-edge bg-rail p-1.5 shadow-2xl"
              style={{ width: SUB_W, left: subLeft, top: Math.min(sub.top - 6, window.innerHeight - 6 * 36 - 20) }}
              onMouseLeave={(e) => {
                const to = e.relatedTarget as Node | null;
                if (!to || !(to instanceof Node) || !menuRef.current?.contains(to)) setSub(null);
              }}
            >
              {durations.map((d) => (
                <button
                  key={d.label}
                  role="menuitem"
                  onClick={() => pick(sub.value, d.minutes)}
                  className="block w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-hover"
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
