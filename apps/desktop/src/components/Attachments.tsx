'use client';

import type { Attachment } from '@line/shared';
import { useEffect, useRef, useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { ageOf } from '@/lib/age';
import { cx, Icons, Skeleton } from './ui';
import { VideoPlayer } from './VideoPlayer';
import { imageMenuItems, openContextMenu, type MenuEntry } from './ContextMenu';
import { looksNsfw } from '@/lib/nsfw';
import { showError, toast } from './Dialogs';
import { AudioPlayer, isVoiceMessage, VoicePlayer } from './AudioPlayer';

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function attachmentKind(contentType: string, filename = '') {
  if (contentType === 'image/svg+xml') return 'file';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('text/') || /\.(txt|md|log|csv|json|ts|tsx|js|rs|py|toml|ya?ml)$/i.test(filename)) return 'text';
  return 'file';
}

/** Anexos de uma mensagem: imagens e GIFs, vídeos, áudios, textos com prévia e demais arquivos. */
/** Clique direito numa imagem/vídeo de outra pessoa: Denunciar como +18. O detector roda de novo
 * aqui antes de mandar; se ele concordar, o anexo já fica +18 até o admin decidir. */
async function reportNsfw(a: Attachment, url: string) {
  toast('Verificando o anexo…');
  let detected = false;
  try {
    const res = await fetch(url);
    if (res.ok) {
      const blob = await res.blob();
      detected = await looksNsfw(new File([blob], a.filename, { type: blob.type || a.contentType }));
    }
  } catch {
    /* sem o arquivo: denuncia mesmo assim */
  }
  try {
    const r = (await api.report({ kind: 'nsfw', attachmentId: a.id, detected })) as { already?: boolean };
    toast(r.already ? 'Esse anexo já foi confirmado como +18.' : 'Denúncia enviada. A equipe vai verificar se é +18.');
  } catch (e) {
    showError(e);
  }
}

function mediaMenu(a: Attachment, url: string, mine: boolean): MenuEntry[] {
  const report: MenuEntry[] = !mine && !a.nsfwLocked ? ['sep', { label: 'Denunciar como +18', icon: <Icons.Warning size={15} />, danger: true, onClick: () => reportNsfw(a, url) }] : [];
  return attachmentKind(a.contentType, a.filename) === 'image' ? [...imageMenuItems(url, a.filename), ...report] : report.slice(1);
}

export function AttachmentList({ attachments, compact, authorId, owner }: { attachments: Attachment[]; compact?: boolean; authorId?: string; owner?: { channelId: string; messageId: string } }) {
  const meId = useLine((s) => s.me?.id);
  const mine = !!authorId && authorId === meId;
  if (!attachments.length) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      {attachments.map((a) => (
        a.spoiler || a.nsfw ? (
          <MediaGate key={a.id} attachment={a}>
            <AttachmentView attachment={a} compact={compact} mine={mine} owner={owner} />
          </MediaGate>
        ) : (
          <AttachmentView key={a.id} attachment={a} compact={compact} mine={mine} owner={owner} />
        )
      ))}
    </div>
  );
}

/** Spoiler e +18. Spoiler fica coberto até clicar. +18 só abre para quem informou a data
 * de nascimento e tem 18 anos ou mais (sem isso nem carrega) e, com "Borrar conteúdo
 * sensível" ligado (padrão), aparece atrás de um aviso até clicar. */
function MediaGate({ attachment: a, children }: { attachment: Attachment; children: React.ReactNode }) {
  const birthDate = useLine((s) => s.me?.birthDate);
  const blur = useLine((s) => s.me?.blurSensitive !== false);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [small, setSmall] = useState(false);
  const age = ageOf(birthDate);
  const blocked = !!a.nsfw && (age === null || age < 18);
  const covered = !blocked && !shown && (a.spoiler || (a.nsfw && blur));

  // Mídia pequena: o aviso encolhe para caber dentro dela.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSmall(e.contentRect.width < 280 || e.contentRect.height < 200));
    ro.observe(el);
    return () => ro.disconnect();
  }, [blocked]);

  if (blocked) {
    return (
      <div className="relative flex min-h-[220px] w-[420px] max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-edge bg-[#3d3d40] px-5 py-5 text-center text-white">
        <Icons.EyeOff size={40} className="text-white/90" />
        <p className="mt-1 text-sm font-bold tracking-wide uppercase">Aviso: conteúdo sensível</p>
        <p className="max-w-[300px] text-[13px] leading-snug text-white/80">
          {age === null
            ? 'Esta mídia é +18. Para ver, informe sua data de nascimento em Configurações, Minha conta.'
            : 'Esta mídia é +18 e só aparece para quem tem 18 anos ou mais.'}
        </p>
        {age === null && (
          <button
            onClick={() => actions.openModal({ kind: 'settings', section: 'account' })}
            className="mt-2 rounded-full bg-black/70 px-5 py-2 text-sm font-semibold text-white hover:bg-black/85"
          >
            Informar data de nascimento
          </button>
        )}
      </div>
    );
  }

  // A mídia fica sempre no mesmo lugar da árvore (só muda o borrado): revelar não recarrega
  // a imagem nem pisca, e o aviso tem exatamente o formato dela.
  return (
    <div ref={ref} className={cx('relative w-fit max-w-full overflow-hidden rounded-lg', covered && 'bg-[#3d3d40]')}>
      <div
        aria-hidden={covered || undefined}
        className={cx(covered && 'pointer-events-none blur-2xl brightness-75 select-none [&_*]:pointer-events-none')}
      >
        {children}
      </div>
      {covered && (
        <div className={cx('absolute inset-0 flex flex-col items-center justify-center bg-black/30 text-center text-white', small ? 'gap-1 p-2' : 'gap-2 p-5')}>
          {a.nsfw ? <Icons.EyeOff size={small ? 22 : 40} className="text-white/90" /> : <Icons.Warning size={small ? 22 : 40} className="text-white/90" />}
          <p className={cx('font-bold tracking-wide uppercase', small ? 'text-[11px]' : 'mt-1 text-sm')}>{a.nsfw ? (small ? 'Sensível' : 'Aviso: conteúdo sensível') : 'Spoiler'}</p>
          {!small && (
            <p className="max-w-[300px] text-[13px] leading-snug text-white/80">
              {a.nsfw
                ? 'Esta mídia pode ter conteúdo sensível (nudez, violência, palavrões, pornografia) que algumas pessoas acham ofensivo.'
                : 'Quem enviou marcou esta mídia como spoiler.'}
            </p>
          )}
          <button
            onClick={() => setShown(true)}
            className={cx('rounded-full bg-black/70 font-semibold text-white hover:bg-black/85', small ? 'px-3 py-1 text-xs' : 'mt-2 px-5 py-2 text-sm')}
          >
            {small ? 'Mostrar' : a.nsfw ? 'Mostrar mesmo assim' : 'Mostrar spoiler'}
          </button>
        </div>
      )}
      {shown && (
        <button
          onClick={() => setShown(false)}
          title="Borrar de novo"
          className="absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/90 shadow hover:bg-black/80 hover:text-white"
        >
          <Icons.EyeOff size={15} />
        </button>
      )}
    </div>
  );
}

/** Tamanhos já vistos de mídias sem largura/altura salvas (anexos antigos). */
const seenSize = new Map<string, { w: number; h: number }>();

function mediaDims(a: Attachment, url: string) {
  return a.width && a.height ? { w: a.width, h: a.height } : seenSize.get(url);
}

/** Cabe a mídia em maxW x maxH sem distorcer (nunca aumenta). */
function fitBox(d: { w: number; h: number }, maxW: number, maxH: number) {
  const k = Math.min(1, maxW / d.w, maxH / d.h);
  return { width: Math.max(1, Math.round(d.w * k)), aspectRatio: `${d.w} / ${d.h}` };
}

function AttachmentView({ attachment: a, compact, mine, owner }: { attachment: Attachment; compact?: boolean; mine?: boolean; owner?: { channelId: string; messageId: string } }) {
  const url = fileUrl(a.url);
  switch (attachmentKind(a.contentType, a.filename)) {
    case 'image':
      return (
        <button
          onClick={() => actions.openModal({ kind: 'image', url, filename: a.filename, ...owner })}
          onContextMenu={(e) => openContextMenu(e, mediaMenu(a, url, !!mine))}
          className="block max-w-full overflow-hidden rounded-lg border border-edge bg-rail"
          title={a.filename}
        >
          <LoadingImage src={url} alt={a.filename} compact={compact} dims={mediaDims(a, url)} />
        </button>
      );
    case 'video':
      return (
        <div onContextMenu={mine || a.nsfwLocked ? undefined : (e) => openContextMenu(e, mediaMenu(a, url, !!mine))} className="max-w-full">
          <VideoPlayer
            src={url}
            filename={a.filename}
            className={a.width && a.height ? 'max-w-full' : compact ? 'max-h-[180px] w-[280px] max-w-full' : 'max-h-[360px] w-[520px] max-w-full'}
            style={a.width && a.height ? (compact ? fitBox({ w: a.width, h: a.height }, 280, 180) : fitBox({ w: a.width, h: a.height }, 520, 360)) : undefined}
          />
        </div>
      );
    case 'audio':
      return (
        isVoiceMessage(a.filename) ? (
          <VoicePlayer src={url} />
        ) : (
          <AudioPlayer src={url} filename={a.filename} size={formatSize(a.size)} />
        )
      );
    case 'text':
      return <TextPreview attachment={a} url={url} />;
    default:
      return (
        <div className="w-full max-w-[420px] rounded-lg border border-edge bg-raise p-3">
          <FileHeader attachment={a} url={url} />
        </div>
      );
  }
}

function FileHeader({ attachment: a, url, icon = <Icons.File size={28} /> }: { attachment: Attachment; url: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-accent">{icon}</span>
      <div className="min-w-0 flex-1">
        <a href={url} target="_blank" rel="noreferrer" className="block truncate font-medium text-fg hover:underline" title={a.filename}>
          {a.filename}
        </a>
        <span className="text-xs text-muted">{formatSize(a.size)}</span>
      </div>
      <a href={url} target="_blank" rel="noreferrer" download={a.filename} title="Baixar" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
        <Icons.Download size={18} />
      </a>
    </div>
  );
}

const PREVIEW_BYTES = 32 * 1024;
const COLLAPSED_LINES = 8;

/** Mostra o começo de arquivos de texto direto no chat. */
function TextPreview({ attachment: a, url }: { attachment: Attachment; url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(url, { headers: { range: `bytes=0-${PREVIEW_BYTES - 1}` } })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(''));
    return () => {
      alive = false;
    };
  }, [url]);

  const lines = (text ?? '').split('\n');
  const truncated = a.size > PREVIEW_BYTES;
  const canExpand = lines.length > COLLAPSED_LINES || truncated;
  const shown = expanded ? text : lines.slice(0, COLLAPSED_LINES).join('\n');

  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-lg border border-edge bg-raise">
      <div className="border-b border-edge px-3 py-2">
        <FileHeader attachment={a} url={url} icon={<Icons.FileText size={24} />} />
      </div>
      {text === null ? (
        <div className="space-y-2 px-3 py-3">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : text ? (
        <pre className={cx('overflow-x-auto px-3 py-2 font-mono text-[13px] leading-5 text-soft', expanded && 'max-h-[420px] overflow-y-auto')}>
          {shown}
        </pre>
      ) : null}
      {text && canExpand && (
        <button onClick={() => setExpanded((v) => !v)} className="w-full border-t border-edge px-3 py-1.5 text-left text-xs font-semibold text-muted hover:bg-hover hover:text-fg">
          {expanded ? 'Mostrar menos' : truncated ? 'Mostrar mais (prévia parcial, baixe para ver tudo)' : `Mostrar tudo (${lines.length} linhas)`}
        </button>
      )}
    </div>
  );
}

/** Imagem com skeleton animado até carregar. Com o tamanho conhecido, o espaço já nasce
 * no formato exato da imagem (nada pula quando ela chega). */
function LoadingImage({ src, alt, compact, dims }: { src: string; alt: string; compact?: boolean; dims?: { w: number; h: number } }) {
  const [loaded, setLoaded] = useState(false);
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) seenSize.set(src, { w: img.naturalWidth, h: img.naturalHeight });
    setLoaded(true);
  };
  if (dims) {
    return (
      <span className="relative block max-w-full" style={compact ? fitBox(dims, 220, 160) : fitBox(dims, 420, 350)}>
        {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={onLoad}
          onError={() => setLoaded(true)}
          className={cx('absolute inset-0 block h-full w-full object-contain', !loaded && 'opacity-0')}
        />
      </span>
    );
  }
  return (
    <span className={cx('relative block', !loaded && (compact ? 'h-[120px] w-[200px]' : 'h-[220px] w-[320px]'))}>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={onLoad}
        onError={() => setLoaded(true)}
        className={cx('block object-contain', compact ? 'max-h-[160px] max-w-[220px]' : 'max-h-[350px] max-w-[420px]', !loaded && 'absolute opacity-0')}
      />
    </span>
  );
}

/** Mídia (imagem, GIF, WebP, vídeo...) que entra na grade. */
export const isMedia = (a: Attachment) => {
  const k = attachmentKind(a.contentType, a.filename);
  return k === 'image' || k === 'video';
};

/** A partir de quantas mídias seguidas o chat junta numa grade 2x2. */
export const GRID_MIN = 4;

/** Grade 2x2 de mídias enviadas juntas; a quarta mostra "+N" quando há mais. Clicar abre a
 * galeria na mídia clicada. +18 sem idade fica bloqueado; spoiler/+18 aparecem borrados. */
export function MediaGrid({ attachments, channelId }: { attachments: Attachment[]; channelId?: string }) {
  const birthDate = useLine((s) => s.me?.birthDate);
  const blur = useLine((s) => s.me?.blurSensitive !== false);
  const adult = (ageOf(birthDate) ?? 0) >= 18;
  const visible = attachments.filter((a) => !a.nsfw || adult);
  const items = visible.map((a) => ({ url: fileUrl(a.url), filename: a.filename, contentType: a.contentType }));
  const shown = attachments.slice(0, 4);
  const extra = attachments.length - 4;
  const [seen, setSeen] = useState<string[]>([]);
  return (
    <div className="mt-1 grid w-[340px] max-w-full grid-cols-2 gap-1 overflow-hidden rounded-lg">
      {shown.map((a, i) => {
        const url = fileUrl(a.url);
        const blocked = !!a.nsfw && !adult;
        const covered = !blocked && !seen.includes(a.id) && (a.spoiler || (a.nsfw && blur));
        const video = attachmentKind(a.contentType, a.filename) === 'video';
        const more = i === 3 && extra > 0;
        return (
          <button
            key={a.id}
            title={a.filename}
            onClick={() => {
              if (blocked) return actions.openModal({ kind: 'settings', section: 'account' });
              // Cada mídia lembra a mensagem dona (a grade junta mensagens seguidas) para responder em thread.
              const list = channelId ? useLine.getState().messages[channelId]?.items ?? [] : [];
              const withOwner = items.map((it, k) => {
                const v = visible[k]!;
                // Ainda coberta na grade: abre em foco, mas com o mesmo aviso do chat.
                const sensitive = seen.includes(v.id) ? undefined : v.nsfw && blur ? ('nsfw' as const) : v.spoiler ? ('spoiler' as const) : undefined;
                return { ...it, sensitive, messageId: list.find((m) => m.attachments.some((x) => x.id === v.id))?.id };
              });
              actions.openModal({ kind: 'gallery', items: withOwner, index: Math.max(0, visible.indexOf(a)), channelId });
            }}
            onContextMenu={!video && !blocked ? (e) => openContextMenu(e, imageMenuItems(url, a.filename)) : undefined}
            className="relative aspect-square overflow-hidden bg-rail"
          >
            {blocked ? (
              <span className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[#3d3d40] text-white">
                <span className="text-lg font-extrabold text-danger">+18</span>
                <span className="px-2 text-[11px] text-white/80">Informe sua idade para ver</span>
              </span>
            ) : video ? (
              <video src={`${url}#t=0.1`} muted preload="metadata" className={cx('h-full w-full object-cover', covered && 'scale-110 blur-xl')} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt={a.filename} loading="lazy" className={cx('h-full w-full object-cover', covered && 'scale-110 blur-xl')} />
            )}
            {video && !blocked && !covered && !more && (
              <span className="absolute top-1/2 left-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white">
                <Icons.Play size={18} />
              </span>
            )}
            {covered && !more && (
              // Versão curta do aviso: ícone, título e "Ver" (revela só este quadro).
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/30 p-2 text-center text-white">
                {a.nsfw ? <Icons.EyeOff size={24} className="text-white/90" /> : <Icons.Warning size={24} className="text-white/90" />}
                <span className="text-[11px] font-bold tracking-wide uppercase">{a.nsfw ? 'Conteúdo sensível' : 'Spoiler'}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSeen((l) => [...l, a.id]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    setSeen((l) => [...l, a.id]);
                  }}
                  className="rounded-full bg-black/70 px-4 py-1 text-xs font-semibold hover:bg-black/85"
                >
                  Ver
                </span>
              </span>
            )}
            {!blocked && !covered && !more && seen.includes(a.id) && (
              // Quadro sensível já revelado: olho no canto para borrar de novo.
              <span
                role="button"
                tabIndex={0}
                title="Borrar de novo"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeen((l) => l.filter((id) => id !== a.id));
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  e.stopPropagation();
                  setSeen((l) => l.filter((id) => id !== a.id));
                }}
                className="absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/90 shadow hover:bg-black/80 hover:text-white"
              >
                <Icons.EyeOff size={15} />
              </span>
            )}
            {more && <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-3xl font-bold text-white">+{extra}</span>}
          </button>
        );
      })}
    </div>
  );
}
