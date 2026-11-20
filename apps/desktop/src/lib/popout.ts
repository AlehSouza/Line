/** "Usuário em Nova Janela": abre o vídeo (câmera ou tela) de alguém numa janela separada, por cima das outras. */

type DocPip = { requestWindow: (o?: { width?: number; height?: number }) => Promise<Window> };

const open = new Map<string, Window | HTMLVideoElement>();

export async function openVideoWindow(key: string, stream: MediaStream, title: string) {
  const prev = open.get(key);
  if (prev instanceof Window && !prev.closed) return prev.focus();

  // Janela de verdade (Chrome/Edge e o WebView2 novo): vídeo grande com o nome embaixo, redimensionável.
  const dpip = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
  if (dpip) {
    try {
      const w = await dpip.requestWindow({ width: 640, height: 360 });
      w.document.title = title;
      const css = w.document.createElement('style');
      css.textContent =
        'html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif}' +
        'video{width:100%;height:100%;object-fit:contain;display:block}' +
        'span{position:fixed;left:8px;bottom:8px;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;font-weight:500}';
      w.document.head.append(css);
      const v = w.document.createElement('video');
      v.autoplay = true;
      v.muted = true; // o som continua saindo da janela principal
      v.playsInline = true;
      v.srcObject = stream;
      const label = w.document.createElement('span');
      label.textContent = title;
      w.document.body.append(v, label);
      open.set(key, w);
      w.addEventListener('pagehide', () => open.delete(key));
      return;
    } catch {
      // cai para o modo imagem sobre imagem abaixo
    }
  }

  // Sem janela de documento: imagem sobre imagem do próprio vídeo.
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
  document.body.append(v);
  await v.play().catch(() => {});
  if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  v.addEventListener('leavepictureinpicture', () => {
    v.srcObject = null;
    v.remove();
    open.delete(key);
  });
  try {
    await v.requestPictureInPicture();
    open.set(key, v);
  } catch {
    v.remove();
    throw new Error('Não deu para abrir o vídeo em outra janela neste aparelho.');
  }
}
