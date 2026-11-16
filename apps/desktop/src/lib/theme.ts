/** Temas do Line: cada um troca as variáveis de cor de globals.css via data-theme no <html>. */
export type ThemeId = 'padrao' | 'escuro' | 'claro' | 'carmesim' | 'pink' | 'daltonico';

export const THEMES: { id: ThemeId; label: string; hint: string; colors: [string, string, string, string] }[] = [
  { id: 'padrao', label: 'Padrão', hint: 'Grafite com violeta', colors: ['#0a0a0c', '#16161a', '#1d1d22', '#7c6af2'] },
  { id: 'escuro', label: 'Escuro', hint: 'Preto quase total', colors: ['#000000', '#08080a', '#111114', '#7c6af2'] },
  { id: 'claro', label: 'Claro', hint: 'Fundo branco', colors: ['#e4e4ea', '#ffffff', '#f2f2f6', '#5b4ae0'] },
  { id: 'carmesim', label: 'Carmesim', hint: 'Vinho com vermelho', colors: ['#0e0708', '#1c0e11', '#251417', '#dc2f4b'] },
  { id: 'pink', label: 'Pink', hint: 'Rosa pastel', colors: ['#f6d9e4', '#fff5f8', '#fdecf2', '#d6336c'] },
  { id: 'daltonico', label: 'Daltônico', hint: 'Cores seguras para daltonismo', colors: ['#0a0a0c', '#16161a', '#56b4e9', '#e69f00'] },
];

export const THEME_KEY = 'line:theme';

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
export const themeBootScript = `try{var t=localStorage.getItem('${THEME_KEY}');if(t&&t!=='padrao')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
