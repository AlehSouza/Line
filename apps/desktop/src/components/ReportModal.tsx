'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useLine } from '@/lib/store';
import { toast } from './Dialogs';
import { Button, cx, ErrorText, Field, Icons, Modal } from './ui';


const REASONS = ['Spam ou golpe', 'Assédio ou ofensa', 'Conteúdo impróprio', 'Discurso de ódio', 'Se passando por outra pessoa', 'Outro'];

/** Onde o app está rodando, para o bug report. */
function platform() {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Outro';
  const desktop = typeof window !== 'undefined' && window.line?.version && !window.line.version.startsWith('__');
  return `${os} · ${desktop ? 'app' : 'web'}`;
}

function version() {
  const v = typeof window !== 'undefined' ? window.line?.version : undefined;
  return v && !v.startsWith('__') ? v : 'web';
}

/**
 * Sem alvo: bug report ou sugestão de melhoria. Com alvo: denúncia do usuário (ou da mensagem dele).
 * Tudo vai para o painel administrador.
 */
export function ReportModal({
  target,
  onClose,
}: {
  target?: { userId: string; messageId?: string; preview?: string };
  onClose: () => void;
}) {
  const user = useLine((s) => (target ? s.users[target.userId] : undefined));
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [images, setImages] = useState<{ file: File; preview: string }[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const current = useRef(images);
  current.current = images;
  useEffect(() => () => current.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  const addImages = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setImages((cur) => {
      const room = MAX_IMAGES - cur.length;
      if (list.length > room) setError(`Dá para anexar até ${MAX_IMAGES} imagens.`);
      return [...cur, ...list.slice(0, Math.max(0, room)).map((file) => ({ file, preview: URL.createObjectURL(file) }))];
    });
  };

  const isReport = !!target;
  // Prints: até 5 no bug/melhoria e 3 na denúncia de usuário (a de mensagem já leva a cópia dela).
  const withImages = !target || !target.messageId;
  const MAX_IMAGES = target ? 3 : 5;
  const title = !target ? 'Reportar' : target.messageId ? 'Denunciar mensagem' : `Denunciar ${user?.displayName ?? 'usuário'}`;
  const canSend = isReport ? !!reason : details.trim().length >= 5;

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const uploaded = [];
      for (const img of withImages ? images : []) uploaded.push((await api.uploadAttachment(img.file, img.file.name || 'imagem.png')).id);
      await api.report({
        kind: !target ? kind : target.messageId ? 'message' : 'user',
        targetUserId: target?.userId,
        messageId: target?.messageId,
        reason,
        details: details.trim(),
        platform: platform(),
        version: version(),
        images: uploaded,
      });
      toast(isReport ? 'Denúncia enviada. Obrigado por avisar!' : 'Recebido! Obrigado por ajudar a melhorar o Line.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      subtitle={isReport ? 'Só a equipe do Line vê a denúncia. A pessoa não fica sabendo quem denunciou.' : 'Encontrou um problema ou tem uma ideia? Conta pra gente.'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={send} disabled={busy || !canSend}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!isReport && (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { id: 'bug', label: 'Bug', hint: 'Algo não funciona', icon: <Icons.Bug size={18} /> },
                { id: 'idea', label: 'Melhoria', hint: 'Ideia ou sugestão', icon: <Icons.SmilePlus size={18} /> },
              ] as const
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => setKind(o.id)}
                className={cx(
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left',
                  kind === o.id ? 'border-accent bg-accent/10 text-fg' : 'border-edge text-muted hover:bg-hover',
                )}
              >
                {o.icon}
                <span>
                  <span className="block font-semibold">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {target?.preview && (
          <p className="line-clamp-3 rounded-lg border border-edge bg-rail/60 px-3 py-2 text-sm break-words text-soft">{target.preview}</p>
        )}
        {isReport && (
          <Field label="Motivo">
            <div className="flex flex-wrap gap-2">
              {REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={cx(
                    'rounded-full border px-3 py-1 text-sm',
                    reason === r ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-muted hover:bg-hover',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label={isReport ? 'Detalhes (opcional)' : kind === 'bug' ? 'O que aconteceu?' : 'Qual a sua ideia?'}>
          <textarea
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            maxLength={4000}
            rows={5}
            autoFocus={!isReport}
            placeholder={
              isReport ? 'Conte o que aconteceu' : kind === 'bug' ? 'Ex.: ao entrar na chamada pelo celular, o áudio some depois de 1 minuto' : 'Ex.: poder fixar mensagens no canal'
            }
            className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
          />
        </Field>
        {withImages && (
          <div
            onPaste={(e) => addImages(e.clipboardData.files)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addImages(e.dataTransfer.files);
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold tracking-wide text-muted uppercase">{isReport ? 'Prints (opcional)' : 'Imagens (opcional)'}</span>
              <span className="text-xs text-muted">
                {images.length}/{MAX_IMAGES}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={img.preview} className="group relative size-16 overflow-hidden rounded-lg border border-edge">
                  <img src={img.preview} alt="" className="size-full object-cover" />
                  <button
                    type="button"
                    title="Remover"
                    onClick={() => {
                      URL.revokeObjectURL(img.preview);
                      setImages((cur) => cur.filter((_, j) => j !== i));
                    }}
                    className="absolute top-0.5 right-0.5 rounded-full bg-black/70 p-0.5 text-white"
                  >
                    <Icons.X size={12} />
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES && (
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  className="flex size-16 items-center justify-center rounded-lg border border-dashed border-edge text-muted hover:bg-hover hover:text-fg"
                  title="Anexar imagem (também dá para colar ou arrastar)"
                >
                  <Icons.Plus size={20} />
                </button>
              )}
            </div>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addImages(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Modal>
  );
}
