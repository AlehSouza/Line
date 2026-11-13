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
