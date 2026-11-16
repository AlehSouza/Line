'use client';

import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/api';
import { dmTitle, useLine } from '@/lib/store';
import { goBack, goForward, startHistory, useNav } from '@/lib/history';
import { cx, DefaultServerIcon } from './ui';

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
    return v.page === 'requests' ? 'Solicitações' : 'Amigos';
  });
  const inServer = useLine((s) => s.view.kind === 'server');
  const iconUrl = useLine((s) => (s.view.kind === 'server' ? s.servers[s.view.serverId]?.iconUrl : undefined));

  const canBack = useNav((h) => h.back.length > 0);
  const canForward = useNav((h) => h.forward.length > 0);

  // Voltar/Avançar: Alt+← / Alt+→ e os botões laterais do mouse.
  useEffect(() => {
    if (!window.line?.window) return;
    startHistory();
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

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
      <div data-tauri-drag-region className="flex h-full items-center gap-0.5 pl-2">
        <NavButton title="Voltar (Alt+←)" disabled={!canBack} onClick={goBack}>
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </NavButton>
        <NavButton title="Avançar (Alt+→)" disabled={!canForward} onClick={goForward}>
          <path d="M5 12h14M12 5l7 7-7 7" />
        </NavButton>
      </div>
      <div data-tauri-drag-region className="pointer-events-none absolute inset-x-40 flex items-center justify-center gap-2 font-semibold text-soft">
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(iconUrl)} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
        ) : (
          inServer && (
            <span className="h-4 w-4 shrink-0 overflow-hidden rounded">
              <DefaultServerIcon />
            </span>
          )
        )}
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

function NavButton({ title, disabled, onClick, children }: { title: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-7 items-center justify-center rounded text-soft transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
