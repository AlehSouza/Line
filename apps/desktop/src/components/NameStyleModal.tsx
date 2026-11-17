'use client';

import type { NameEffect, NameStyle } from '@line/shared';
import { useEffect, useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { DEFAULT_NAME_STYLE, EFFECT_COLORS, NAME_EFFECTS, NAME_FONTS, NAME_PALETTES, nameDir, namePulse, nameStyleClass, nameStyleCss, nameWave, StyledName } from '@/lib/nameStyle';
import { actions, useLine } from '@/lib/store';
import { showError, toast } from './Dialogs';
import { UserTagBadge } from './ServerTag';
import { Avatar, Button, cx, Icons } from './ui';
import { ColorPicker } from './ColorPicker';

/** Cor personalizada: qualquer efeito aceita até 4 cores (o mínimo é o que o efeito usa). */
const MAX_COLORS = 4;
const minColors = (effect: NameEffect) => (effect === 'prism' ? 2 : EFFECT_COLORS[effect]);
const colorCount = (effect: NameEffect, colors: string[]) => Math.min(MAX_COLORS, Math.max(minColors(effect), colors.length));

/** No máximo 4 sugestões de cores por efeito. */
const presetsOf = (effect: NameEffect) => NAME_PALETTES[effect].slice(0, 4);

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;

/** Cores para um efeito: mantém as que já tinha e completa com a primeira paleta dele. */
function colorsFor(effect: NameEffect, current: string[]): string[] {
  if (effect === 'prism') return NAME_PALETTES.prism.some((p) => p.join() === current.join()) ? current : NAME_PALETTES.prism[0]!;
  const n = EFFECT_COLORS[effect];
  const base = NAME_PALETTES[effect][0]!;
  return Array.from({ length: n }, (_, i) => current[i] ?? base[i] ?? base[0]!);
}

/** "Alterar estilo do nome exibido": fonte, efeito e cores, com prévia ao vivo. */
export function NameStyleModal({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me);
  const [style, setStyle] = useState<NameStyle>(me?.nameStyle ?? DEFAULT_NAME_STYLE);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!me) return null;
  const n = colorCount(style.effect, style.colors);
  const base = minColors(style.effect);
  const palettes = presetsOf(style.effect);
  const isPreset = palettes.some((p) => p.join() === style.colors.join());

  async function save(next: NameStyle | null) {
    setBusy(true);
    try {
      await api.updateProfileExtras({ nameStyle: next });
      actions.setMe({ ...me!, nameStyle: next });
      toast(next ? 'Estilo do nome aplicado.' : 'Estilo do nome removido.');
      onClose();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  function surprise() {
    const effect = pick(NAME_EFFECTS).id;
    setStyle({ font: pick(NAME_FONTS).id, effect, colors: pick(presetsOf(effect)) });
  }

  const banner = me.bannerUrl ? fileUrl(me.bannerUrl) : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Alterar estilo do nome exibido"
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex max-h-full w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border border-edge bg-side shadow-2xl"
      >
        <button onClick={onClose} title="Fechar" className="absolute top-4 right-4 z-10 rounded-md p-1 text-soft hover:text-fg">
          <Icons.X size={20} />
        </button>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
          {/* Escolhas */}
          <div className="min-w-0 flex-1 p-6">
            <h2 className="text-xl font-bold">Alterar estilo do nome exibido</h2>

            <p className="mt-5 mb-2 text-sm font-bold">Escolha fonte</p>
            <div className="grid grid-cols-4 gap-2">
              {NAME_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  title={f.label}
                  onClick={() => setStyle((s) => ({ ...s, font: f.id }))}
                  className={cx(
                    'flex h-[60px] items-center justify-center rounded-lg border bg-rail text-xl font-bold',
                    style.font === f.id ? 'border-accent bg-accent/10' : 'border-edge hover:bg-raise',
                  )}
                  style={{ fontFamily: f.family }}
                >
                  Gg
                </button>
              ))}
            </div>

            <p className="mt-5 mb-2 text-sm font-bold">Escolha efeito</p>
            <div className="grid grid-cols-4 gap-2">
              {NAME_EFFECTS.map((e) => {
                const sample: NameStyle = { font: 'default', effect: e.id, colors: NAME_PALETTES[e.id][0]! };
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setStyle((s) => ({ ...s, effect: e.id, colors: colorsFor(e.id, s.colors) }))}
                    className={cx(
                      'flex h-[60px] items-center justify-center rounded-lg border bg-rail text-[15px] font-semibold',
                      style.effect === e.id ? 'border-accent bg-accent/10' : 'border-edge hover:bg-raise',
                    )}
                  >
                    <span className={nameStyleClass(sample)} style={nameStyleCss(sample)}>
                      {e.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="mt-5 mb-2 text-sm font-bold">Escolha cor</p>
            <div className="flex flex-wrap items-center gap-2">
              {n < MAX_COLORS && (
                <button
                  type="button"
                  title="Adicionar mais uma cor"
                  onClick={() => setStyle((s) => ({ ...s, colors: [...s.colors.slice(0, n), s.colors[n - 1] ?? '#ffffff'] }))}
                  className="flex h-11 w-11 items-center justify-center rounded-lg border-2 border-dashed border-edge text-soft hover:border-accent hover:text-fg"
                >
                  <Icons.Plus size={18} />
                </button>
              )}
              {(
                <span
                  className={cx('flex h-11 items-center gap-1.5 rounded-lg border px-1.5', !isPreset ? 'border-accent' : 'border-edge')}
                  style={{ background: n > 1 ? `linear-gradient(90deg, ${style.colors.slice(0, n).join(', ')})` : style.colors[0] }}
                  title="Cores personalizadas"
                >
                  {Array.from({ length: n }, (_, i) => (
                    <span key={i} className="group/c relative">
                    <ColorPicker
                      value={style.colors[i] ?? '#ffffff'}
                      onChange={(c) =>
                        setStyle((s) => {
                          const colors = [...s.colors];
                          colors[i] = c;
                          return { ...s, colors };
                        })
                      }
                      className="relative h-8 w-8 cursor-pointer rounded-md border-2 border-white shadow"
                      style={{ background: style.colors[i] }}
                    />
                    {i >= base && (
                      <button
                        type="button"
                        title="Remover cor"
                        onClick={() => setStyle((s) => ({ ...s, colors: s.colors.slice(0, n).filter((_, j) => j !== i) }))}
                        className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black text-white group-hover/c:flex"
                      >
                        <Icons.X size={10} />
                      </button>
                    )}
                    </span>
                  ))}
                </span>
              )}
              {palettes.map((p) => (
                <button
                  key={p.join()}
                  type="button"
                  onClick={() => setStyle((s) => ({ ...s, colors: p }))}
                  className={cx('h-11 w-11 rounded-lg border-2', p.join() === style.colors.join() ? 'border-accent' : 'border-transparent')}
                  style={{ background: p.length > 1 ? `linear-gradient(135deg, ${p.join(', ')})` : p[0] }}
                />
              ))}
            </div>

            {/* Fica no layout mesmo escondido, para o modal não mudar de tamanho. */}
            {(
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <span className={cx(style.colors.length <= 1 && 'invisible')}>
                <Toggle
                  label="Orientação"
                  value={nameDir(style)}
                  options={[
                    ['h', 'Horizontal'],
                    ['v', 'Vertical'],
                  ]}
                  onChange={(dir) => setStyle((s) => ({ ...s, dir }))}
                />
                </span>
                <span className={cx(style.colors.length <= 1 && style.effect !== 'neon' && 'invisible')}>
                <Toggle
                  label="Movimento"
                  value={namePulse(style) ? 'pulse' : nameWave(style) ? 'wave' : 'static'}
                  options={[
                    ['static', 'Estático'],
                    ...(style.colors.length > 1 ? [['wave', 'Onda'] as ['wave', string]] : []),
                    ...(style.effect === 'neon' ? [['pulse', 'Piscar'] as ['pulse', string]] : []),
                  ]}
                  onChange={(motion) => setStyle((s) => ({ ...s, motion }))}
                />
                </span>
                {(
                  <span className={cx(!nameWave(style) && !namePulse(style) && 'invisible')}>
                  <Toggle
                    label="Velocidade"
                    value={style.speed ?? 'medium'}
                    options={[
                      ['slow', '0.5x'],
                      ['medium', '1x'],
                      ['fast', '1.5x'],
                    ]}
                    onChange={(speed) => setStyle((s) => ({ ...s, speed }))}
                  />
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Prévia */}
          <div className="flex shrink-0 flex-col justify-between gap-4 border-edge bg-rail p-6 md:w-[340px] md:border-l">
            <div className="mt-6 space-y-3">
              <div
                className="overflow-hidden rounded-xl border border-edge"
                style={{ background: `linear-gradient(to bottom, color-mix(in srgb, ${me.avatarColor} 30%, var(--color-side)), var(--color-side) 70%)` }}
              >
                <div className="h-16" style={banner ? undefined : { background: me.avatarColor }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {banner && <img src={banner} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="px-3.5 pb-3.5">
                  <span className="-mt-8 inline-flex rounded-full border-4 border-side">
                    <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={56} />
                  </span>
                  <p className="mt-1 text-lg leading-tight font-bold">
                    <StyledName style={style}>{me.displayName}</StyledName>
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-soft">
                    {me.username} <UserTagBadge user={me} />
                  </p>
                </div>
              </div>

              <div className="flex gap-3 rounded-xl border border-edge bg-main p-3">
                <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={36} />
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <StyledName style={style} className="truncate font-semibold">
                      {me.displayName}
                    </StyledName>
                    <span className="text-xs text-muted">{new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
                  </p>
                  <p className="text-sm text-soft">será que alguém lê isso?</p>
                </div>
              </div>

              <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-side px-3 py-2">
                <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={28} presence="online" />
                <StyledName style={style} className="truncate text-[15px] font-medium">
                  {me.displayName}
                </StyledName>
                <UserTagBadge user={me} />
              </div>

              <div className="rounded-xl border border-edge bg-side px-2 py-2">
                <p className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[15px] text-soft">
                  <Icons.Speaker size={17} />
                  <span className="truncate">voice</span>
                </p>
                <div className="mt-0.5 flex items-center gap-2 py-1 pl-7">
                  <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={24} />
                  <StyledName style={style} className="truncate text-sm font-medium">
                    {me.displayName}
                  </StyledName>
                  <UserTagBadge user={me} />
                </div>
              </div>
            </div>
            <p className="text-xs text-muted">O estilo aparece no seu nome em mensagens, listas de membros, canais de voz e no seu perfil, para todo mundo.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-edge px-6 py-4">
          {me.nameStyle && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void save(null)}>
              Remover estilo
            </Button>
          )}
          <Button variant="subtle" disabled={busy} onClick={surprise}>
            <Icons.Refresh size={16} /> Surpreenda-me
          </Button>
          <Button disabled={busy} onClick={() => void save(style)} className="px-6">
            {busy ? 'Aplicando…' : 'Aplicar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div>
      <p className="mb-1 text-xs font-bold text-soft">{label}</p>
      <div className="inline-flex rounded-lg border border-edge bg-rail p-0.5">
        {options.map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cx('rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap', value === id ? 'bg-accent text-on-accent' : 'text-soft hover:text-fg')}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
