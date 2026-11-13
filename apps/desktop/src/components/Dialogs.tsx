'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Modal, cx } from './ui';

/**
 * Diálogos e avisos no estilo do Line, no lugar do confirm/alert/prompt nativos
 * (que no app desktop aparecem como "tauri.localhost diz").
 *
 * Uso: `if (await confirmDialog({ title, message, danger: true })) ...` e `toast('texto')`.
 * O <DialogHost /> fica montado uma vez na raiz do app.
 */

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Só libera o botão quando a pessoa digita exatamente este texto (ex.: nome do servidor). */
  requireText?: string;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
type Toast = { id: number; text: string; tone: 'info' | 'error' };

let showDialog: ((d: Pending) => void) | null = null;
let pushToast: ((t: Toast) => void) | null = null;
let toastSeq = 0;

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!showDialog) return resolve(false);
    showDialog({ ...options, resolve });
  });
}

/** Snackbar centralizada no topo, some sozinha. */
export function toast(text: string, tone: Toast['tone'] = 'info') {
  pushToast?.({ id: ++toastSeq, text, tone });
}

/** Atalho para `.catch(showError)`: mostra o erro numa snackbar vermelha. */
export function showError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error');
}

export function DialogHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    showDialog = (d) => setQueue((q) => [...q, d]);
    pushToast = (t) => {
      setToasts((list) => [...list.slice(-2), t]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), 3500);
    };
    return () => {
      showDialog = null;
      pushToast = null;
    };
  }, []);

  const current = queue[0];
  const close = (ok: boolean) => {
    current?.resolve(ok);
    setTyped('');
    setQueue((q) => q.slice(1));
  };
  const blocked = !!current?.requireText && typed !== current.requireText;

  return (
    <>
      {current && (
        // Acima das Configurações (z-50/60), que podem abrir uma confirmação.
        <div className="relative z-[85]">
        <Modal
          title={current.title}
          onClose={() => close(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                {current.cancelLabel ?? 'Cancelar'}
              </Button>
              <Button variant={current.danger ? 'danger' : 'primary'} disabled={blocked} onClick={() => close(true)} autoFocus>
                {current.confirmLabel ?? 'Confirmar'}
              </Button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) close(true);
            }}
            className="space-y-3"
          >
            {current.message && <p className="text-sm text-soft">{current.message}</p>}
            {current.requireText && (
              <>
                <p className="text-sm text-soft">
                  Para confirmar, digite <strong className="text-fg">{current.requireText}</strong>
                </p>
                <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
              </>
            )}
          </form>
        </Modal>
        </div>
      )}
      <div className="pointer-events-none fixed inset-x-0 top-12 z-[90] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              'line-toast pointer-events-auto max-w-md rounded-xl border px-4 py-2.5 text-sm font-medium shadow-2xl',
              t.tone === 'error' ? 'border-danger/40 bg-side text-danger' : 'border-edge bg-side text-fg',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
