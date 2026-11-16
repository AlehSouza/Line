'use client';

import type { NameEffect, NameFont, NameStyle, PublicUser } from '@line/shared';
import {
  Bungee,
  Caveat,
  Fredoka,
  Lobster,
  Orbitron,
  Pacifico,
  Playfair_Display,
  Righteous,
  Silkscreen,
  Space_Mono,
  UnifrakturCook,
} from 'next/font/google';
import type { CSSProperties, ReactNode } from 'react';

// Fontes do "Estilo do nome exibido" (baixadas no build e servidas pelo próprio app).
const fredoka = Fredoka({ subsets: ['latin'], weight: ['600'], display: 'swap', preload: false });
const bungee = Bungee({ subsets: ['latin'], weight: '400', display: 'swap', preload: false });
const lobster = Lobster({ subsets: ['latin'], weight: '400', display: 'swap', preload: false });
const righteous = Righteous({ subsets: ['latin'], weight: '400', display: 'swap', preload: false });
const playfair = Playfair_Display({ subsets: ['latin'], weight: ['700'], display: 'swap', preload: false });
const mono = Space_Mono({ subsets: ['latin'], weight: ['700'], display: 'swap', preload: false });
const orbitron = Orbitron({ subsets: ['latin'], weight: ['700'], display: 'swap', preload: false });
const gothic = UnifrakturCook({ subsets: ['latin'], weight: '700', display: 'swap', preload: false });
const pacifico = Pacifico({ subsets: ['latin'], weight: '400', display: 'swap', preload: false });
const pixel = Silkscreen({ subsets: ['latin'], weight: ['400'], display: 'swap', preload: false });
const caveat = Caveat({ subsets: ['latin'], weight: ['700'], display: 'swap', preload: false });

/** Fontes na ordem da grade do modal (mesmos ids que o servidor aceita). */
export const NAME_FONTS: { id: NameFont; label: string; family: string }[] = [
  { id: 'default', label: 'Padrão', family: 'inherit' },
  { id: 'fredoka', label: 'Redonda', family: fredoka.style.fontFamily },
  { id: 'bungee', label: 'Bloco', family: bungee.style.fontFamily },
  { id: 'lobster', label: 'Letreiro', family: lobster.style.fontFamily },
  { id: 'righteous', label: 'Retrô', family: righteous.style.fontFamily },
  { id: 'playfair', label: 'Clássica', family: playfair.style.fontFamily },
  { id: 'mono', label: 'Máquina', family: mono.style.fontFamily },
  { id: 'orbitron', label: 'Futuro', family: orbitron.style.fontFamily },
  { id: 'gothic', label: 'Gótica', family: gothic.style.fontFamily },
  { id: 'pacifico', label: 'Praia', family: pacifico.style.fontFamily },
  { id: 'pixel', label: 'Pixel', family: pixel.style.fontFamily },
  { id: 'caveat', label: 'Caneta', family: caveat.style.fontFamily },
];

export const NAME_EFFECTS: { id: NameEffect; label: string }[] = [
  { id: 'solid', label: 'Sólido' },
  { id: 'gradient', label: 'Gradiente' },
  { id: 'neon', label: 'Neon' },
  { id: 'draw', label: 'Desenho' },
  { id: 'pop', label: 'Pop' },
  { id: 'gummy', label: 'Gummy' },
  { id: 'prism', label: 'Prism' },
];

/** Quantas cores cada efeito usa (prism usa a paleta inteira). */
export const EFFECT_COLORS: Record<NameEffect, number> = { solid: 1, gradient: 2, neon: 1, draw: 1, pop: 2, gummy: 2, prism: 5 };

/** Paletas prontas por efeito. */
export const NAME_PALETTES: Record<NameEffect, string[][]> = {
  solid: [['#f5f5f7'], ['#ff7aa8'], ['#7c6af2'], ['#4fc3f7'], ['#5ee6a8'], ['#f5c451'], ['#ff6b4a']],
  neon: [['#c86bff'], ['#ff4fd8'], ['#4fe3ff'], ['#59ff8b'], ['#fff35c'], ['#ff5c5c'], ['#7c6af2']],
  draw: [['#ff4f9a'], ['#7c6af2'], ['#4fc3f7'], ['#5ee6a8'], ['#f5c451'], ['#ff6b4a'], ['#f5f5f7']],
  gradient: [['#f59e42', '#e15cf2'], ['#4fd1a5', '#f5c451'], ['#d65cff', '#4f7bff'], ['#7c4fd1', '#3fd18b'], ['#ff9ad5', '#f5c4e0'], ['#f5a442', '#ff5c8a']],
  pop: [['#9fffd0', '#1f8f5f'], ['#ffd36b', '#b5530f'], ['#ff9ad5', '#a3266b'], ['#9fd0ff', '#2554a8'], ['#f5f5f7', '#7c6af2'], ['#ffef7a', '#ff4f4f']],
  gummy: [['#c7a3ff', '#7fd0c5'], ['#ff9ad5', '#ffd36b'], ['#7fe0ff', '#c7a3ff'], ['#9fffb0', '#ffe07f'], ['#ffb38a', '#ff6f9a'], ['#b8c0ff', '#ffc8dd']],
  prism: [
    ['#ff5c5c', '#ffb347', '#fff35c', '#59ff8b', '#4fc3ff', '#b36bff'],
    ['#7fe0ff', '#c7a3ff', '#ff9ad5', '#ffffff'],
    ['#7a0f0f', '#ff3b1f', '#ffb347', '#fff35c'],
    ['#00f5a0', '#00d9f5', '#7c6af2', '#ff4fd8'],
  ],
};

export const DEFAULT_NAME_STYLE: NameStyle = { font: 'default', effect: 'solid', colors: ['#f5f5f7'] };

const fontOf = (id: NameFont | undefined) => NAME_FONTS.find((f) => f.id === id) ?? NAME_FONTS[0]!;

/**
 * CSS do nome com estilo. `fallback` é a cor de antes (cargo, bot ou texto) quando não há estilo.
 * Os efeitos que pintam com gradiente usam background-clip: text.
 */
export function nameStyleCss(style: NameStyle | null | undefined, fallback?: string): CSSProperties {
  if (!style) return fallback ? { color: fallback } : {};
  const font = fontOf(style.font);
  const [c1 = '#f5f5f7', c2 = c1] = style.colors ?? [];
  const base: CSSProperties = font.id === 'default' ? {} : { fontFamily: font.family };
  const clip = (bg: string): CSSProperties => ({
    ...base,
    backgroundImage: bg,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
  });
  switch (style.effect) {
    case 'gradient':
      return clip(`linear-gradient(90deg, ${c1}, ${c2})`);
    case 'neon':
      return { ...base, color: `color-mix(in srgb, ${c1} 45%, white)`, textShadow: `0 0 2px ${c1}, 0 0 8px ${c1}, 0 0 14px color-mix(in srgb, ${c1} 60%, transparent)` };
    case 'draw':
      return { ...base, color: `color-mix(in srgb, ${c1} 22%, transparent)`, WebkitTextStroke: `0.06em ${c1}`, paintOrder: 'stroke fill' };
    case 'pop':
      return { ...base, color: c1, textShadow: `0.07em 0.07em 0 ${c2}` };
    case 'gummy':
      return { ...clip(`linear-gradient(180deg, ${c1}, ${c2})`), filter: `drop-shadow(0 0.06em 0 color-mix(in srgb, ${c2} 55%, black))` };
    case 'prism': {
      const list = style.colors?.length ? style.colors : NAME_PALETTES.prism[0]!;
      return { ...clip(`linear-gradient(90deg, ${[...list, list[0]].join(', ')})`), backgroundSize: '200% 100%' };
    }
    default:
      return { ...base, color: c1 };
  }
}

/**
 * Nome exibido com o estilo escolhido pela pessoa. Sem estilo, usa `color` (cor do cargo/bot).
 * Bots não têm estilo próprio (usam a cor do agente).
 */
export function StyledName({
  user,
  style,
  color,
  className,
  children,
}: {
  user?: Pick<PublicUser, 'nameStyle' | 'bot'> | null;
  /** Estilo explícito (prévia no modal); senão o da pessoa. */
  style?: NameStyle | null;
  color?: string;
  className?: string;
  children: ReactNode;
}) {
  const s = style !== undefined ? style : user?.bot ? null : user?.nameStyle;
  return (
    <span className={[className, s?.effect === 'prism' ? 'line-name-prism' : ''].filter(Boolean).join(' ')} style={nameStyleCss(s, color)}>
      {children}
    </span>
  );
}
