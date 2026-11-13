'use client';

import { useEffect, useState } from 'react';
import { dmTitle, useLine } from '@/lib/store';
import { cx, Logo } from './ui';

/**
 * Barra de título própria (a do Windows fica escondida), no mesmo tom do app.
 * Arrasta pela barra, duplo clique maximiza e os botões ficam à direita.
 */
export function TitleBar() {
  const [win, setWin] = useState<NonNullable<Window['line']>['window']>();
  const [maximized, setMaximized] = useState(false);
  const title = useLine((s) => {
    const v = s.view;
    if (!s.token) return 'Line';
    if (v.kind === 'server') return s.servers[v.serverId]?.name ?? 'Line';
    if (v.kind === 'discover') return 'Explorar servidores';
    if (v.dmId && s.channels[v.dmId]) return dmTitle(s.channels[v.dmId]!, s.me?.id, s.users);
    return 'Amigos';
  });
  const iconColor = useLine((s) => (s.view.kind === 'server' ? s.servers[s.view.serverId]?.iconColor : undefined));

  useEffect(() => {
    const w = window.line?.window;
    if (!w) return;
    setWin(w);
    const sync = () => void w.isMaximized().then(setMaximized);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // No navegador (modo web) a janela já tem a barra do próprio navegador.
  if (!win) return null;

  return (
    <div data-tauri-drag-region className="relative flex h-8 shrink-0 items-center bg-rail text-[13px] select-none">
      <div data-tauri-drag-region className="flex items-center gap-2 pl-3">
        <span className="pointer-events-none">
          <Logo size={16} />
        </span>
      </div>
      <div data-tauri-drag-region className="pointer-events-none absolute inset-x-40 flex items-center justify-center gap-2 font-semibold text-soft">
        {iconColor && <span className="h-3 w-3 shrink-0 rounded" style={{ background: iconColor }} />}
        <span className="truncate">{title}</span>
      </div>
      <div className="ml-auto flex h-full">
        <WinButton title="Minimizar" onClick={win.minimize}>
          <path d="M1 5.5h9" />
        </WinButton>
        <WinButton title={maximized ? 'Restaurar' : 'Maximizar'} onClick={() => void win.toggleMaximize().then(setMaximized)}>
          {maximized ? (
            <>
              <rect x="1" y="3" width="7" height="7" />
              <path d="M3 3V1h7v7H8" />
            </>
          ) : (
            <rect x="1" y="1" width="9" height="9" />
          )}
        </WinButton>
        <WinButton title="Fechar" danger onClick={win.close}>
          <path d="m1 1 9 9M10 1l-9 9" />
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cx('flex h-full w-11 items-center justify-center text-muted', danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-hover hover:text-fg')}
    >
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1">
        {children}
      </svg>
    </button>
  );
}
