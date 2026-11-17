/** Temas do Line: cada um troca as variáveis de cor de globals.css via data-theme no <html>. */
export type ThemeId = 'padrao' | 'escuro' | 'claro' | 'carmesim' | 'pink' | 'pink-escuro' | 'azul-pastel' | 'verde-pastel' | 'daltonico' | 'personalizado';

export const THEMES: { id: ThemeId; label: string; hint: string; colors: [string, string, string, string] }[] = [
  { id: 'padrao', label: 'Padrão', hint: 'Grafite com violeta', colors: ['#0a0a0c', '#16161a', '#1d1d22', '#7c6af2'] },
  { id: 'escuro', label: 'Escuro', hint: 'Preto quase total', colors: ['#000000', '#08080a', '#111114', '#7c6af2'] },
  { id: 'claro', label: 'Claro', hint: 'Fundo branco', colors: ['#e4e4ea', '#ffffff', '#f2f2f6', '#5b4ae0'] },
  { id: 'carmesim', label: 'Carmesim', hint: 'Vinho com vermelho', colors: ['#0e0708', '#1c0e11', '#251417', '#dc2f4b'] },
  { id: 'pink', label: 'Pink', hint: 'Rosa pastel', colors: ['#f6d9e4', '#fff5f8', '#fdecf2', '#d6336c'] },
  { id: 'pink-escuro', label: 'Pink escuro', hint: 'Ameixa com rosa', colors: ['#140a10', '#21111a', '#2b1621', '#e8478a'] },
  { id: 'azul-pastel', label: 'Azul pastel', hint: 'Campo de flores azuis', colors: ['#cfe4f5', '#f4f8fc', '#e6f1fb', '#3a8fd6'] },
  { id: 'verde-pastel', label: 'Verde pastel', hint: 'Floresta com cachoeira', colors: ['#d3e8c6', '#f5f9ea', '#e8f2dc', '#4f9a5a'] },
  { id: 'daltonico', label: 'Daltônico', hint: 'Cores seguras para daltonismo', colors: ['#0a0a0c', '#16161a', '#56b4e9', '#e69f00'] },
  { id: 'personalizado', label: 'Personalizado', hint: 'Você escolhe as cores', colors: ['#0a0a0c', '#16161a', '#1d1d22', '#7c6af2'] },
];

export const THEME_KEY = 'line:theme';
export const CUSTOM_KEY = 'line:theme-custom';

/** Cores que o tema Personalizado deixa trocar (as mesmas que todos os temas usam). */
export type CustomColors = Record<
  'rail' | 'side' | 'main' | 'raise' | 'edge' | 'fg' | 'soft' | 'muted' | 'accent' | 'on-accent' | 'danger' | 'online',
  string
>;

export const CUSTOM_FIELDS: { key: keyof CustomColors; label: string; hint: string }[] = [
  { key: 'rail', label: 'Barra de servidores', hint: 'Fundo mais externo' },
  { key: 'side', label: 'Barra lateral', hint: 'Canais e membros' },
  { key: 'main', label: 'Fundo principal', hint: 'Área do chat' },
  { key: 'raise', label: 'Cartões e caixas', hint: 'Itens em destaque' },
  { key: 'edge', label: 'Bordas', hint: 'Linhas e divisórias' },
  { key: 'fg', label: 'Texto', hint: 'Texto principal' },
  { key: 'soft', label: 'Texto secundário', hint: 'Mensagens e rótulos' },
  { key: 'muted', label: 'Texto apagado', hint: 'Horários e dicas' },
  { key: 'accent', label: 'Destaque', hint: 'Botões e seleção' },
  { key: 'on-accent', label: 'Texto no destaque', hint: 'Texto dos botões' },
  { key: 'danger', label: 'Perigo', hint: 'Excluir e erros' },
  { key: 'online', label: 'Online', hint: 'Bolinha de status' },
];

export const DEFAULT_CUSTOM: CustomColors = {
  rail: '#0a0a0c',
  side: '#111114',
  main: '#16161a',
  raise: '#1d1d22',
  edge: '#2b2b32',
  fg: '#ededf0',
  soft: '#b5b5bf',
  muted: '#84848f',
  accent: '#7c6af2',
  'on-accent': '#ffffff',
  danger: '#f2555a',
  online: '#3fbf7f',
};

const HEX = /^#[0-9a-f]{6}$/i;

export function getCustomColors(): CustomColors {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}');
    const out = { ...DEFAULT_CUSTOM };
    for (const f of CUSTOM_FIELDS) if (typeof raw[f.key] === 'string' && HEX.test(raw[f.key])) out[f.key] = raw[f.key];
    return out;
  } catch {
    return { ...DEFAULT_CUSTOM };
  }
}

export function setCustomColors(c: CustomColors) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
  } catch {
    /* sem localStorage */
  }
  if (document.documentElement.getAttribute('data-theme') === 'personalizado') applyCustom(c);
}

/** Variáveis aplicadas no <html> pelo Personalizado (inclui as derivadas). */
const CUSTOM_VARS = [...CUSTOM_FIELDS.map((f) => f.key), 'hover', 'accent-strong', 'dnd'];

function applyCustom(c: CustomColors) {
  const st = document.documentElement.style;
  for (const f of CUSTOM_FIELDS) st.setProperty(`--color-${f.key}`, c[f.key]);
  st.setProperty('--color-hover', `color-mix(in srgb, ${c.raise}, ${c.fg} 8%)`);
  st.setProperty('--color-accent-strong', `color-mix(in srgb, ${c.accent}, #000 14%)`);
  st.setProperty('--color-dnd', c.danger);
  st.setProperty('color-scheme', isLight(c.main) ? 'light' : 'dark');
}

function clearCustom() {
  const st = document.documentElement.style;
  for (const k of CUSTOM_VARS) st.removeProperty(`--color-${k}`);
  st.removeProperty('color-scheme');
}

export function isLight(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
}

export function getTheme(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (v && THEMES.some((t) => t.id === v)) return v;
  } catch {
    /* sem localStorage */
  }
  return 'padrao';
}

export function applyTheme(id: ThemeId) {
  if (id === 'personalizado') applyCustom(getCustomColors());
  else clearCustom();
  if (id === 'padrao') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', id);
}

export function setTheme(id: ThemeId) {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* sem localStorage */
  }
  applyTheme(id);
}

/** Script que roda antes do React para o tema certo aparecer sem piscar. */
export const themeBootScript = `try{var d=document.documentElement,t=localStorage.getItem('${THEME_KEY}');if(t&&t!=='padrao')d.setAttribute('data-theme',t);if(t==='personalizado'){var c=JSON.parse(localStorage.getItem('${CUSTOM_KEY}')||'{}'),s=d.style,k;for(k in c)if(/^#[0-9a-f]{6}$/i.test(c[k]))s.setProperty('--color-'+k,c[k]);if(c.raise&&c.fg)s.setProperty('--color-hover','color-mix(in srgb, '+c.raise+', '+c.fg+' 8%)');if(c.accent)s.setProperty('--color-accent-strong','color-mix(in srgb, '+c.accent+', #000 14%)');if(c.danger)s.setProperty('--color-dnd',c.danger);if(c.main){var n=parseInt(c.main.slice(1),16);s.setProperty('color-scheme',(0.299*(n>>16)+0.587*((n>>8)&255)+0.114*(n&255))/255>0.6?'light':'dark')}}}catch(e){}`;
