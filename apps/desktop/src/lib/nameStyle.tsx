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
  const list = style.colors?.length ? style.colors.slice(0, 6) : style.effect === 'prism' ? NAME_PALETTES.prism[0]! : ['#f5f5f7'];
  const c1 = list[0]!;
  const last = list[list.length - 1]!;
  const base: CSSProperties = font.id === 'default' ? {} : { fontFamily: font.family };
  const vertical = nameDir(style) === 'v';
  const wave = nameWave(style);
  // Degradê recortado no texto; em onda, repete a primeira cor no fim e corre o fundo (classe de nameStyleClass).
  const clip = (cols: string[]): CSSProperties => {
    const stops = wave ? [...cols, cols[0]!] : cols;
    return {
      ...base,
      backgroundImage: `linear-gradient(${vertical ? '180deg' : '90deg'}, ${stops.join(', ')})`,
      ...(wave ? { backgroundSize: vertical ? '100% 200%' : '200% 100%', animationDuration: WAVE_SECS[style.speed ?? 'medium'] } : {}),
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
      WebkitTextFillColor: 'transparent',
    };
  };
  const fill = (cols: string[]): CSSProperties => (cols.length > 1 ? clip(cols) : { ...base, color: cols[0] });
  const multi = list.length > 1;
  switch (style.effect) {
    case 'neon': {
      // --line-glow (1 = normal) é o que a animação de piscar mexe.
      const g = (px: number) => `calc(${px}px * var(--line-glow, 1))`;
      const pulse = namePulse(style) ? { animationDuration: PULSE_SECS[style.speed ?? 'medium'] } : {};
      const glow = `drop-shadow(0 0 2px ${c1}) drop-shadow(0 0 ${g(7)} ${last}) drop-shadow(0 0 ${g(12)} color-mix(in srgb, ${last} 60%, transparent))`;
      if (!multi) return { ...base, ...pulse, color: `color-mix(in srgb, ${c1} 45%, white)`, textShadow: `0 0 2px ${c1}, 0 0 ${g(8)} ${c1}, 0 0 ${g(14)} color-mix(in srgb, ${c1} 60%, transparent)` };
      return { ...clip(list.map((c) => `color-mix(in srgb, ${c} 45%, white)`)), ...pulse, filter: glow };
    }
    case 'draw':
      if (!multi) return { ...base, color: `color-mix(in srgb, ${c1} 22%, transparent)`, WebkitTextStroke: `0.06em ${c1}`, paintOrder: 'stroke fill' };
      return { ...clip(list.map((c) => `color-mix(in srgb, ${c} 35%, transparent)`)), WebkitTextStroke: `0.06em ${c1}`, paintOrder: 'stroke fill' };
    case 'pop': {
      // A última cor é a sombra; as outras pintam o texto.
      const cols = multi ? list.slice(0, -1) : list;
      if (cols.length === 1) return { ...base, color: cols[0], textShadow: `0.07em 0.07em 0 ${last}` };
      return { ...clip(cols), filter: `drop-shadow(0.07em 0.07em 0 ${last})` };
    }
    case 'gummy':
      return { ...fill(list), filter: `drop-shadow(0 0.06em 0 color-mix(in srgb, ${last} 55%, black))` };
    default:
      // solid, gradient e prism: o texto pinta com as cores (uma só = cor lisa).
      return fill(list);
  }
}

/** Duração de uma volta da onda por velocidade. */
const WAVE_SECS = { slow: '12s', medium: '6s', fast: '4s' } as const;
const PULSE_SECS = { slow: '5s', medium: '2.5s', fast: '1.67s' } as const;

/** Neon piscando: brilho que pulsa com umas falhas de lâmpada. */
export const namePulse = (s: NameStyle) => s.effect === 'neon' && s.motion === 'pulse';

/** Direção do degradê: a escolhida, ou vertical no gummy e horizontal no resto. */
export const nameDir = (s: NameStyle): 'h' | 'v' => s.dir ?? (s.effect === 'gummy' ? 'v' : 'h');
/** Se o degradê corre em onda: o escolhido, ou só no prism. Precisa de mais de uma cor. */
export const nameWave = (s: NameStyle) => (s.motion ? s.motion === 'wave' : s.effect === 'prism') && (s.colors?.length ?? (s.effect === 'prism' ? 2 : 1)) !== 1;

/** Classe da animação de onda (vazia quando o nome é parado). */
export function nameStyleClass(s: NameStyle | null | undefined): string {
  if (s && namePulse(s)) return 'line-name-neon-pulse';
  if (!s || !nameWave(s)) return '';
  return nameDir(s) === 'v' ? 'line-name-wave-v' : 'line-name-prism';
}

/**
 * Nome exibido com o estilo escolhido pela pessoa. Sem estilo, usa `color` (cor do cargo/bot).
 * O agente também pode ter estilo (Configurações do servidor → Agente → Personalizar).
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
  const s = style !== undefined ? style : user?.nameStyle;
  return (
    <span className={[className, nameStyleClass(s)].filter(Boolean).join(' ')} style={nameStyleCss(s, color)}>
      {children}
    </span>
  );
}
