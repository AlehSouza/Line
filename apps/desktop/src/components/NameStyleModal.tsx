'use client';

import type { NameEffect, NameStyle } from '@line/shared';
import { useEffect, useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { DEFAULT_NAME_STYLE, EFFECT_COLORS, NAME_EFFECTS, NAME_FONTS, NAME_PALETTES, nameStyleCss, StyledName } from '@/lib/nameStyle';
import { actions, useLine } from '@/lib/store';
import { showError, toast } from './Dialogs';
import { UserTagBadge } from './ServerTag';
import { Avatar, Button, cx, Icons } from './ui';
import { ColorPicker } from './ColorPicker';

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
  const n = EFFECT_COLORS[style.effect];
  const palettes = NAME_PALETTES[style.effect];
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
    setStyle({ font: pick(NAME_FONTS).id, effect, colors: pick(NAME_PALETTES[effect]) });
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
                    <span className={e.id === 'prism' ? 'line-name-prism' : undefined} style={nameStyleCss(sample)}>
                      {e.label}
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="mt-5 mb-2 text-sm font-bold">Escolha cor</p>
            <div className="flex flex-wrap items-center gap-2">
              {style.effect !== 'prism' && (
                <span
                  className={cx('flex h-11 items-center gap-1.5 rounded-lg border px-1.5', !isPreset ? 'border-accent' : 'border-edge')}
                  style={{ background: n > 1 ? `linear-gradient(90deg, ${style.colors[0]}, ${style.colors[1]})` : style.colors[0] }}
                  title="Cores personalizadas"
                >
                  {Array.from({ length: n }, (_, i) => (
                    <ColorPicker
                      key={i}
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
            </div>
            <p className="text-xs text-muted">O estilo aparece no seu nome em mensagens, listas de membros e no seu perfil, para todo mundo.</p>
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
