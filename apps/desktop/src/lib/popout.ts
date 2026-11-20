/**
 * "Em Nova Janela" da chamada: o quadro de uma pessoa (câmera ou avatar) ou de uma transmissão numa janela
 * separada do Line. O conteúdo é React normal, desenhado com portal dentro da janela nova (mesmos estilos).
 */
import { create } from 'zustand';

/** Chaves dos quadros abertos em janela própria ("person:<id>" ou "screen:<id>"). Saem da grade da chamada. */
export const usePopouts = create<{ keys: string[] }>(() => ({ keys: [] }));

const wins = new Map<string, Window>();

export function popoutWindow(key: string) {
  return wins.get(key) ?? null;
}

/** Copia folhas de estilo e o tema (atributos do html/body) para a janela nova. */
function copyLook(w: Window) {
  const d = w.document;
  // O CSS vai como texto: no app desktop a janela nova não carrega arquivos do próprio app.
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = d.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      d.head.append(style);
    } catch {
      if (sheet.href) {
        const link = d.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        d.head.append(link);
      }
    }
  }
  for (const a of Array.from(document.documentElement.attributes)) d.documentElement.setAttribute(a.name, a.value);
  for (const a of Array.from(document.body.attributes)) d.body.setAttribute(a.name, a.value);
  d.body.style.margin = '0';
  d.body.style.overflow = 'hidden';
}

/** Abre (ou traz para a frente) a janela do quadro. Precisa ser chamado no clique. */
export function openPopout(key: string, title: string) {
  const open = wins.get(key);
  if (open && !open.closed) {
    open.focus();
    return;
  }
  const w = window.open('', `line_${key.replace(/\W/g, '_')}`, 'popup,width=520,height=320');
  if (!w) throw new Error('Não deu para abrir outra janela. Libere as janelas pop-up para o Line.');
  w.document.title = title;
  copyLook(w);
  const root = w.document.createElement('div');
  root.id = 'line-popout';
  w.document.body.append(root);
  wins.set(key, w);
  usePopouts.setState((s) => ({ keys: [...s.keys.filter((k) => k !== key), key] }));
}

export function closePopout(key: string) {
  const w = wins.get(key);
  wins.delete(key);
  try {
    if (w && !w.closed) w.close();
  } catch {
    // já fechada
  }
  usePopouts.setState((s) => ({ keys: s.keys.filter((k) => k !== key) }));
}

/** Janelas que a pessoa fechou no X: tira da lista (o quadro volta para a grade). */
export function sweepPopouts() {
  for (const [key, w] of wins) if (w.closed) closePopout(key);
}

// Fechou/recarregou o Line: as janelas dos quadros vão junto.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const key of [...wins.keys()]) closePopout(key);
  });
}
