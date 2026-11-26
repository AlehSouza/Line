'use client';

import type { Rating } from '@line/shared';
import { cx } from './ui';

/** Classificação indicativa no estilo brasileiro (cores e faixas do selo oficial). */
export const RATINGS: { value: Rating; label: string; color: string; fg: string; title: string; hint: string }[] = [
  { value: 'L', label: 'L', color: '#0c9447', fg: '#fff', title: 'Livre', hint: 'Para todos os públicos. Nada que possa assustar ou incomodar crianças.' },
  { value: '10', label: '10', color: '#0f7dc2', fg: '#fff', title: 'Não recomendado para menores de 10 anos', hint: 'Pode ter brigas leves, sustos e uma ou outra palavra mais forte.' },
  { value: '12', label: '12', color: '#f8c411', fg: '#1d1815', title: 'Não recomendado para menores de 12 anos', hint: 'Pode ter violência, palavrões, insinuações e assuntos mais delicados.' },
  { value: '14', label: '14', color: '#e67824', fg: '#fff', title: 'Não recomendado para menores de 14 anos', hint: 'Pode ter violência mais intensa, temas adultos e conversas sobre drogas.' },
  { value: '16', label: '16', color: '#db2827', fg: '#fff', title: 'Não recomendado para menores de 16 anos', hint: 'Pode ter violência forte, uso de drogas e temas pesados.' },
  {
    value: '18',
    label: '18',
    color: '#1d1815',
    fg: '#fff',
    title: 'Conteúdo sensível',
    hint: 'Só para quem tem 18 anos ou mais. Não aparece em Explorar para menores de idade nem para quem não informou a data de nascimento.',
  },
];

export const ratingOf = (r: Rating | null | undefined) => RATINGS.find((x) => x.value === r);

/** Classificação que vale para o canal: a dele, ou conteúdo sensível se já estava marcado assim. */
export const channelRating = (c: { rating?: Rating | null; nsfw?: boolean }): Rating | null => c.rating ?? (c.nsfw ? '18' : null);

export function RatingBadge({ rating, size = 20, className }: { rating: Rating | null | undefined; size?: number; className?: string }) {
  const r = ratingOf(rating);
  if (!r) return null;
  return (
    <span
      title={r.title}
      className={cx('inline-flex shrink-0 items-center justify-center rounded font-extrabold leading-none', className)}
      style={{ background: r.color, color: r.fg, width: size, height: size, fontSize: size * 0.5, boxShadow: rating === '18' ? 'inset 0 0 0 1px rgba(255,255,255,.25)' : undefined }}
    >
      {r.label}
    </span>
  );
}

/**
 * Botões de classificação com um bloco que explica a escolhida.
 * `none` mostra uma opção extra (ex.: "Igual ao servidor") que devolve null.
 */
export function RatingPicker({
  value,
  onChange,
  none,
  noneHint,
}: {
  value: Rating | null;
  onChange: (r: Rating | null) => void;
  none?: string;
  noneHint?: string;
}) {
  const r = ratingOf(value);
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-soft">Classificação indicativa</p>
      <div className="flex flex-wrap gap-2">
        {none && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className={cx(
              'h-10 rounded-lg border px-3 text-sm font-semibold transition-colors',
              value === null ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-muted hover:text-fg',
            )}
          >
            {none}
          </button>
        )}
        {RATINGS.map((x) => (
          <button
            key={x.value}
            type="button"
            aria-pressed={value === x.value}
            title={x.title}
            onClick={() => onChange(x.value)}
            className={cx(
              'flex h-10 w-10 items-center justify-center rounded-lg text-base font-extrabold transition-all',
              value === x.value ? 'scale-105 ring-2 ring-accent ring-offset-2 ring-offset-side' : 'opacity-60 hover:opacity-100',
            )}
            style={{ background: x.color, color: x.fg }}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-start gap-3 rounded-lg border border-edge bg-rail p-3">
        {r ? <RatingBadge rating={r.value} size={32} /> : null}
        <div className="min-w-0 text-sm">
          <p className="font-semibold">{r ? r.title : (none ?? 'Sem classificação')}</p>
          <p className="mt-0.5 text-muted">{r ? r.hint : (noneHint ?? 'Escolha uma classificação para as pessoas saberem o que esperar.')}</p>
        </div>
      </div>
    </div>
  );
}
