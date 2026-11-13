'use client';

import { useEffect, useState } from 'react';

const CHECK_EVERY = 30 * 60 * 1000;

/** No app desktop: avisa quando há versão nova e instala com um clique (o app reinicia sozinho). */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'installing' | 'error'>('idle');
  const [hidden, setHidden] = useState(false);

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
    } catch {
      setState('error');
    }
  };

  return (
    <div className="flex items-center justify-center gap-3 bg-accent px-4 py-1.5 text-sm text-white">
      <span>
        {state === 'installing'
          ? 'Baixando e instalando a atualização. O Line vai reiniciar sozinho.'
          : state === 'error'
            ? 'Não foi possível atualizar agora.'
            : `Nova versão do Line disponível (${version}).`}
      </span>
      {state !== 'installing' && (
        <button onClick={install} className="rounded bg-white/20 px-2.5 py-0.5 font-semibold hover:bg-white/30">
          {state === 'error' ? 'Tentar de novo' : 'Atualizar e reiniciar'}
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
