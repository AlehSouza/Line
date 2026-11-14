'use client';

import { useEffect, useState } from 'react';

const CHECK_EVERY = 30 * 60 * 1000;

/** No app desktop: avisa quando há versão nova e instala com um clique (o app reinicia sozinho). */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'installing' | 'error'>('idle');
  const [hidden, setHidden] = useState(false);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    const updates = window.line?.updates;
    if (!updates) return;
    const check = () => void updates.check().then((v) => v && setVersion(v)).catch(() => {});
    check();
    const t = setInterval(check, CHECK_EVERY);
    return () => clearInterval(t);
  }, []);

  if (!version || hidden) return null;

  const install = async () => {
    setState('installing');
    try {
      await window.line?.updates?.install();
    } catch (err) {
      // Mostra o motivo real (download, assinatura, instalador) para dar para corrigir.
      setDetail(err instanceof Error ? err.message : String(err ?? ''));
      setState('error');
    }
  };

  return (
    <div className="flex items-center justify-center gap-3 bg-online px-4 py-1.5 text-sm font-medium text-white">
      <span>
        {state === 'installing'
          ? 'Baixando e instalando a atualização. O Line vai reiniciar sozinho.'
          : state === 'error'
            ? `Não foi possível atualizar agora.${detail ? ` (${detail})` : ''}`
            : 'Atualização disponível, mantenha a boa experiência com seu aplicativo atualizado.'}
      </span>
      {state !== 'installing' && (
        <button onClick={install} className="rounded bg-black/20 px-2.5 py-0.5 font-semibold hover:bg-black/30">
          {state === 'error' ? 'Tentar de novo' : 'Atualizar'}
        </button>
      )}
      {state !== 'installing' && (
        <button onClick={() => setHidden(true)} className="opacity-80 hover:opacity-100" title="Depois">
          Depois
        </button>
      )}
    </div>
  );
}

/**
 * Atualiza o app: no desktop abre a janelinha de atualização; no navegador recarrega a página
 * (o app web novo já está publicado no servidor).
 */
export async function updateApp() {
  const updates = typeof window !== 'undefined' ? window.line?.updates : undefined;
  if (!updates) return window.location.reload();
  try {
    if (!(await updates.check())) return window.location.reload();
    if (updates.run) await updates.run();
    else await updates.install();
  } catch {
    window.location.reload();
  }
}

/** Mostrado no lugar de um conteúdo que esta versão do app não sabe exibir. */
export function UpdateRequired() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="my-1 flex max-w-md items-center gap-3 rounded-lg border border-edge bg-raise px-3 py-2.5">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-accent">
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </svg>
      <span className="flex-1 text-sm text-soft">Você precisa atualizar o seu aplicativo para interagir com isso.</span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await updateApp();
          setBusy(false);
        }}
        className="shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Atualizando…' : 'Atualizar'}
      </button>
    </div>
  );
}
