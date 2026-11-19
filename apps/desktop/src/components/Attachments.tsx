'use client';

import type { Attachment } from '@line/shared';
import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { ageOf } from '@/lib/age';
import { cx, Icons, Skeleton } from './ui';
import { VideoPlayer } from './VideoPlayer';
import { imageMenuItems, openContextMenu, type MenuEntry } from './ContextMenu';
import { looksNsfw } from '@/lib/nsfw';
import { cachedMediaUrl, mediaUrlOf, useMediaUrl } from '@/lib/mediaUrl';
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
    const real = await mediaUrlOf(a.id, a.url, a.nsfw);
    const res = await fetch(real ?? url);
    if (res.ok) {
      const blob = await res.blob();
      detected = await looksNsfw(new File([blob], a.filename, { type: blob.type || a.contentType }));
    }
  } catch {
    /* sem o arquivo: denuncia mesmo assim */
  }
  try {
    const r = (await api.report({ kind: 'nsfw', attachmentId: a.id, detected })) as { already?: boolean };
    toast(r.already ? 'Esse anexo já foi confirmado como conteúdo sensível.' : 'Denúncia enviada. A equipe vai verificar se é conteúdo sensível.');
  } catch (e) {
    showError(e);
  }
}

function mediaMenu(a: Attachment, url: string, mine: boolean): MenuEntry[] {
  const report: MenuEntry[] = !mine && !a.nsfwLocked ? ['sep', { label: 'Denunciar como conteúdo sensível', icon: <Icons.Warning size={15} />, danger: true, onClick: () => reportNsfw(a, url) }] : [];
  return attachmentKind(a.contentType, a.filename) === 'image' ? [...imageMenuItems(url, a.filename), ...report] : report.slice(1);
}

/** below: algo embaixo de cada anexo (a thread daquela mídia). */
export function AttachmentList({
  attachments,
  compact,
  authorId,
  owner,
  below,
  fill,
  fillHeight,
}: {
  attachments: Attachment[];
  compact?: boolean;
  authorId?: string;
  owner?: { channelId: string; messageId: string };
  below?: (a: Attachment) => ReactNode;
  /** Imagem/vídeo ocupa a largura toda, até FILL_MAX_H de altura (sem esticar além disso). */
  fill?: boolean;
  /** Como `fill`, mas com esta altura máxima; mídia mais baixa que isso fica no tamanho original (topo da Conversa). */
  fillHeight?: number;
}) {
  const meId = useLine((s) => s.me?.id);
  if (fillHeight) fill = true;
  const mine = !!authorId && authorId === meId;
  if (!attachments.length) return null;
  return (
    <div className={cx('mt-1 flex flex-col gap-2', fill ? 'items-stretch' : 'items-start')}>
      {attachments.map((a) => {
        const kind = attachmentKind(a.contentType, a.filename);
        const dims = fill && (kind === 'image' || kind === 'video') ? mediaDims(a, fileUrl(a.url)) : undefined;
        const filled = !!dims;
        const inner =
          a.spoiler || a.nsfw ? (
            <MediaGate
              attachment={a}
              fill={filled}
              compact={compact}
              onOpen={
                attachmentKind(a.contentType, a.filename) === 'image'
                  ? () =>
                      // Coberta: abre em foco com o mesmo aviso (como na grade).
                      actions.openModal({
                        kind: 'gallery',
                        items: [{ url: a.url, filename: a.filename, contentType: a.contentType, attachmentId: a.id, messageId: owner?.messageId, sensitive: a.nsfw ? 'nsfw' : 'spoiler', width: a.width, height: a.height, preview: a.preview, nsfw: a.nsfw }],
                        index: 0,
                        channelId: owner?.channelId,
                      })
                  : undefined
              }
            >
              <AttachmentView attachment={a} compact={compact} mine={mine} owner={owner} fill={filled} />
            </MediaGate>
          ) : (
            <AttachmentView attachment={a} compact={compact} mine={mine} owner={owner} fill={filled} />
          );
        // Largura toda, a não ser que a altura passe de FILL_MAX_H: aí encolhe mantendo a proporção.
        const view = dims ? (
          <div key={a.id} className="w-full">
            <div style={{ width: `min(100%, ${Math.round(((fillHeight ? Math.min(fillHeight, dims.h) : FILL_MAX_H) * dims.w) / dims.h)}px)` }}>{inner}</div>
          </div>
        ) : (
          inner
        );
        const extra = below?.(a);
        return extra ? (
          <div key={a.id} className="flex max-w-full flex-col items-start">
            {view}
            {extra}
          </div>
        ) : (
          <Fragment key={a.id}>{view}</Fragment>
        );
      })}
    </div>
  );
}

/** Spoiler e +18. Spoiler fica coberto até clicar. +18 só abre para quem informou a data
 * de nascimento e tem 18 anos ou mais (sem isso nem carrega) e, com "Borrar conteúdo
 * sensível" ligado (padrão), aparece atrás de um aviso até clicar. */
function MediaGate({ attachment: a, children, onOpen, fill, compact }: { attachment: Attachment; children: React.ReactNode; onOpen?: () => void; fill?: boolean; compact?: boolean }) {
  const birthDate = useLine((s) => s.me?.birthDate);
  const blur = useLine((s) => s.me?.blurSensitive !== false);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // null = ainda não medido: o aviso fica invisível até saber o tamanho (senão pisca o texto grande).
  const [small, setSmall] = useState<boolean | null>(null);
  const age = ageOf(birthDate);
  const blocked = !!a.nsfw && (age === null || age < 18);
  const covered = !blocked && !shown && (a.spoiler || (a.nsfw && blur));

  // Mídia pequena: o aviso encolhe para caber dentro dela.
  // Mede antes de pintar (useLayoutEffect) e continua acompanhando se a mídia mudar de tamanho.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fits = (w: number, h: number) => w < 280 || h < 200;
    const r = el.getBoundingClientRect();
    setSmall(fits(r.width, r.height));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setSmall(fits(e.contentRect.width, e.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [blocked]);

  if (blocked) {
    return (
      <div className="relative flex min-h-[220px] w-[420px] max-w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-edge px-5 py-5 text-center text-fg" style={{ background: COVER_GRADIENT }}>
        <Icons.EyeOff size={40} className="text-soft" />
        <p className="mt-1 text-sm font-bold tracking-wide uppercase">Aviso: conteúdo sensível</p>
        <p className="max-w-[300px] text-[13px] leading-snug text-muted">
          {age === null
            ? 'Esta mídia tem conteúdo sensível. Para ver, informe sua data de nascimento em Configurações, Minha conta.'
            : 'Esta mídia tem conteúdo sensível e só aparece para quem tem 18 anos ou mais.'}
        </p>
        {age === null && (
          <button
            onClick={() => actions.openModal({ kind: 'settings', section: 'account' })}
            className="mt-2 rounded-full bg-hover px-5 py-2 text-sm font-semibold text-fg hover:bg-edge"
          >
            Informar data de nascimento
          </button>
        )}
      </div>
    );
  }

  // Coberta, a mídia real nem é montada (não baixa): a própria AttachmentView desenha a prévia
  // borrada do servidor com a MESMA caixa e borda da mídia revelada (nada muda de tamanho).
  void compact;
  return (
    <div ref={ref} className={cx('relative max-w-full overflow-hidden rounded-lg', fill ? 'w-full' : 'w-fit')}>
      <CoveredCtx.Provider value={!!covered}>{children}</CoveredCtx.Provider>
      {covered && (
        <div
          onClick={onOpen}
          className={cx('absolute inset-0 flex flex-col items-center justify-center text-center text-fg', a.preview && 'bg-main/55', small ? 'gap-1 p-2' : 'gap-2 p-5', small === null && 'invisible', onOpen && 'cursor-pointer')}
        >
          {a.nsfw ? <Icons.EyeOff size={small ? 22 : 40} className="text-soft" /> : <Icons.Warning size={small ? 22 : 40} className="text-soft" />}
          <p className={cx('font-bold tracking-wide uppercase', small ? 'text-[11px]' : 'mt-1 text-sm')}>{a.nsfw ? (small ? 'Sensível' : 'Aviso: conteúdo sensível') : 'Spoiler'}</p>
          {!small && (
            <p className="max-w-[300px] text-[13px] leading-snug text-muted">
              {a.nsfw
                ? 'Esta mídia pode ter conteúdo sensível (nudez, violência, palavrões, pornografia) que algumas pessoas acham ofensivo.'
                : 'Quem enviou marcou esta mídia como spoiler.'}
            </p>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShown(true);
            }}
            className={cx('rounded-full bg-hover font-semibold text-fg hover:bg-edge', small ? 'px-3 py-1 text-xs' : 'mt-2 px-5 py-2 text-sm')}
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

/** Cobertura de mídia sensível/spoiler: degradê cinza, sem nenhum pixel da mídia (e sem
 * filtro CSS, que travava o scroll). Quem dá o tamanho é a própria mídia, invisível embaixo. */
/** Segue o tema (tokens do app): discreto, no tom dos cartões. */
export const COVER_GRADIENT = 'linear-gradient(160deg, var(--color-raise) 0%, var(--color-side) 100%)';

export function SensitiveCover({ className }: { className?: string }) {
  return <span aria-hidden className={cx('block', className)} style={{ background: COVER_GRADIENT }} />;
}

/** Fundo da mídia coberta: a prévia borrada do servidor (16 px esticados, só manchas de cor)
 * ou, sem prévia (vídeo, formato que o servidor não lê), o degradê do tema. Sem filtro CSS. */
export function CoverArt({ preview, className }: { preview?: string | null; className?: string }) {
  if (!preview) return <SensitiveCover className={cx('absolute inset-0', className)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={preview} alt="" aria-hidden draggable={false} className={cx('absolute inset-0 h-full w-full scale-110 object-cover', className)} />;
}

/** Tamanhos já vistos de mídias sem largura/altura salvas (anexos antigos). */
const seenSize = new Map<string, { w: number; h: number }>();

function mediaDims(a: Attachment, url: string) {
  return a.width && a.height ? { w: a.width, h: a.height } : seenSize.get(url);
}

/** Altura máxima da mídia que ocupa a largura toda (painel Conversas). */
const FILL_MAX_H = 280;

/** Cabe a mídia em maxW x maxH sem distorcer (nunca aumenta). */
function fitBox(d: { w: number; h: number }, maxW: number, maxH: number) {
  const k = Math.min(1, maxW / d.w, maxH / d.h);
  return { width: Math.max(1, Math.round(d.w * k)), aspectRatio: `${d.w} / ${d.h}` };
}

/** true dentro de um MediaGate coberto: a mídia mostra só a prévia, sem baixar a real. */
const CoveredCtx = createContext(false);

function AttachmentView({ attachment: a, compact, mine, owner, fill }: { attachment: Attachment; compact?: boolean; mine?: boolean; owner?: { channelId: string; messageId: string }; fill?: boolean }) {
  const covered = useContext(CoveredCtx);
  // Mídia sensível: link assinado pedido ao servidor (o link cru dela não abre). Coberta, nem pede.
  const signed = useMediaUrl(covered ? null : a);
  const kind = attachmentKind(a.contentType, a.filename);
  const plain = fileUrl(a.url);
  // Coberta (ou esperando o link assinado): mesma caixa e mesma borda da mídia, só com a prévia.
  if ((covered || (a.nsfw && !signed)) && (kind === 'image' || kind === 'video')) {
    if (kind === 'image')
      return (
        <span className={cx('block max-w-full overflow-hidden rounded-lg border border-edge bg-rail', fill && 'w-full')}>
          <LoadingImage src={plain} alt="" compact={compact} dims={mediaDims(a, plain)} fill={fill} placeholder={a.preview ?? null} coverOnly />
        </span>
      );
    const d = a.width && a.height ? { w: a.width, h: a.height } : null;
    return (
      <span
        className={cx('relative block max-w-full overflow-hidden rounded-lg border border-edge bg-black', fill ? 'w-full' : !d && (compact ? 'h-[158px] w-[280px]' : 'h-[293px] w-[520px]'))}
        style={d ? (fill ? { width: '100%', aspectRatio: `${d.w} / ${d.h}` } : compact ? fitBox(d, 280, 180) : fitBox(d, 520, 360)) : undefined}
      >
        <CoverArt preview={a.preview} />
      </span>
    );
  }
  const url = signed ?? plain;
  switch (kind) {
    case 'image':
      return (
        <button
          onClick={() => actions.openModal({ kind: 'image', url, filename: a.filename, attachmentId: a.id, ...owner })}
          onContextMenu={(e) => openContextMenu(e, mediaMenu(a, url, !!mine))}
          className={cx('block max-w-full overflow-hidden rounded-lg border border-edge bg-rail', fill && 'w-full')}
          title={a.filename}
        >
          <LoadingImage src={url} alt={a.filename} compact={compact} dims={mediaDims(a, url)} fill={fill} placeholder={a.spoiler || a.nsfw ? a.preview : undefined} />
        </button>
      );
    case 'video':
      return (
        <div onContextMenu={mine || a.nsfwLocked ? undefined : (e) => openContextMenu(e, mediaMenu(a, url, !!mine))} className="max-w-full">
          <VideoPlayer
            src={url}
            filename={a.filename}
            className={fill ? 'w-full' : a.width && a.height ? 'max-w-full' : compact ? 'max-h-[180px] w-[280px] max-w-full' : 'max-h-[360px] w-[520px] max-w-full'}
            style={fill && a.width && a.height ? { width: '100%', aspectRatio: `${a.width} / ${a.height}` } : a.width && a.height ? (compact ? fitBox({ w: a.width, h: a.height }, 280, 180) : fitBox({ w: a.width, h: a.height }, 520, 360)) : undefined}
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
function LoadingImage({ src, alt, compact, dims, fill, placeholder, coverOnly }: { src: string; alt: string; compact?: boolean; dims?: { w: number; h: number }; fill?: boolean; placeholder?: string | null; coverOnly?: boolean }) {
  // Já carregada antes (está no cache do navegador): sem skeleton, senão ele pisca por um quadro.
  const [loaded, setLoaded] = useState(() => seenSize.has(src));
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth && img.naturalHeight) seenSize.set(src, { w: img.naturalWidth, h: img.naturalHeight });
    setLoaded(true);
  };
  // Só a capa (mídia coberta): mesma caixa, sem <img> da mídia real.
  if (coverOnly) {
    return (
      <span
        className={cx('relative block max-w-full overflow-hidden', !dims && (compact ? 'h-[120px] w-[200px]' : 'h-[220px] w-[320px]'))}
        style={dims ? (fill ? { width: '100%', aspectRatio: `${dims.w} / ${dims.h}` } : compact ? fitBox(dims, 220, 160) : fitBox(dims, 420, 350)) : undefined}
      >
        <CoverArt preview={placeholder} />
      </span>
    );
  }
  if (dims) {
    return (
      <span
        className="relative block max-w-full overflow-hidden"
        style={fill ? { width: '100%', aspectRatio: `${dims.w} / ${dims.h}` } : compact ? fitBox(dims, 220, 160) : fitBox(dims, 420, 350)}
      >
        {/* Mídia sensível revelada: a prévia borrada segura o lugar até a real chegar. */}
        {!loaded && (placeholder ? <CoverArt preview={placeholder} /> : <Skeleton className="absolute inset-0 rounded-none" />)}
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

/** Imagem/vídeo de um quadro da grade (sensível usa o link assinado; até chegar, a prévia). */
function TileMedia({ a, video }: { a: Attachment; video?: boolean }) {
  const url = useMediaUrl(a);
  if (!url) return <CoverArt preview={a.preview} />;
  if (video) return <video src={`${url}#t=0.1`} muted preload="metadata" className="h-full w-full object-cover" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={a.filename} loading="lazy" decoding="async" className="h-full w-full object-cover" />;
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
export function MediaGrid({ attachments, channelId, messageIds }: { attachments: Attachment[]; channelId?: string; messageIds?: string[] }) {
  const birthDate = useLine((s) => s.me?.birthDate);
  const blur = useLine((s) => s.me?.blurSensitive !== false);
  const adult = (ageOf(birthDate) ?? 0) >= 18;
  const visible = attachments.filter((a) => !a.nsfw || adult);
  const items = visible.map((a) => ({ url: a.url, filename: a.filename, contentType: a.contentType, width: a.width, height: a.height, preview: a.preview, nsfw: a.nsfw }));
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
                return { ...it, sensitive, attachmentId: v.id, messageId: list.find((m) => m.attachments.some((x) => x.id === v.id))?.id };
              });
              actions.openModal({ kind: 'gallery', items: withOwner, index: Math.max(0, visible.indexOf(a)), channelId });
            }}
            onContextMenu={!video && !blocked && !covered ? (e) => openContextMenu(e, imageMenuItems(cachedMediaUrl(a) ?? url, a.filename)) : undefined}
            className="relative aspect-square overflow-hidden bg-rail"
          >
            {blocked ? (
              <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg" style={{ background: COVER_GRADIENT }}>
                <Icons.Warning size={22} className="text-soft" /><span className="text-[11px] font-bold uppercase">Conteúdo sensível</span>
                <span className="px-2 text-[11px] text-muted">Informe sua idade para ver</span>
              </span>
            ) : video ? (
              covered ? (
                <CoverArt preview={a.preview} />
              ) : (
                <TileMedia a={a} video />
              )
            ) : covered ? (
              <CoverArt preview={a.preview} />
            ) : (
              <TileMedia a={a} />
            )}
            {video && !blocked && !covered && !more && (
              <span className="absolute top-1/2 left-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white">
                <Icons.Play size={18} />
              </span>
            )}
            {covered && !more && (
              // Versão curta do aviso: ícone, título e "Ver" (revela só este quadro).
              <span className={cx('absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-2 text-center text-fg', a.preview && 'bg-main/55')}>
                {a.nsfw ? <Icons.EyeOff size={24} className="text-soft" /> : <Icons.Warning size={24} className="text-soft" />}
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
                  className="rounded-full bg-hover px-4 py-1 text-xs font-semibold text-fg hover:bg-edge"
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
