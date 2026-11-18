'use client';

import type { Attachment } from '@line/shared';
import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/api';
import { actions, useLine } from '@/lib/store';
import { ageOf } from '@/lib/age';
import { cx, Icons, Skeleton } from './ui';
import { VideoPlayer } from './VideoPlayer';
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
export function AttachmentList({ attachments, compact }: { attachments: Attachment[]; compact?: boolean }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-2">
      {attachments.map((a) => (
        a.spoiler || a.nsfw ? (
          <MediaGate key={a.id} attachment={a}>
            <AttachmentView attachment={a} compact={compact} />
          </MediaGate>
        ) : (
          <AttachmentView key={a.id} attachment={a} compact={compact} />
        )
      ))}
    </div>
  );
}

/** Spoiler e +18: o anexo fica borrado até clicar. +18 só abre para quem informou
 * a data de nascimento e tem 18 anos ou mais (sem isso nem chega a carregar). */
function MediaGate({ attachment: a, children }: { attachment: Attachment; children: React.ReactNode }) {
  const birthDate = useLine((s) => s.me?.birthDate);
  const [shown, setShown] = useState(false);
  const age = ageOf(birthDate);
  const blocked = !!a.nsfw && (age === null || age < 18);

  if (blocked) {
    return (
      <div className="flex w-[320px] max-w-full flex-col items-center gap-2 rounded-lg border border-edge bg-raise px-5 py-6 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/15 text-sm font-bold text-danger">+18</span>
        <p className="font-semibold text-fg">Conteúdo para maiores de 18 anos</p>
        {age === null ? (
          <>
            <p className="text-sm text-muted">Para ver, informe sua data de nascimento em Configurações, Minha conta.</p>
            <button
              onClick={() => actions.openModal({ kind: 'settings', section: 'account' })}
              className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-strong"
            >
              Informar data de nascimento
            </button>
          </>
        ) : (
          <p className="text-sm text-muted">Esse anexo só aparece para quem tem 18 anos ou mais.</p>
        )}
      </div>
    );
  }
  if (shown) return <>{children}</>;
  return (
    <div className="relative max-w-full overflow-hidden rounded-lg">
      <div aria-hidden className="pointer-events-none blur-2xl select-none [&_*]:pointer-events-none">
        {children}
      </div>
      <button
        onClick={() => setShown(true)}
        title="Clique para ver"
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/35 text-white transition-colors hover:bg-black/25"
      >
        <span className="rounded-full bg-black/70 px-3 py-1 text-xs font-bold tracking-wider uppercase">
          {a.nsfw ? 'Conteúdo +18' : 'Spoiler'}
        </span>
        <span className="text-xs text-white/80">Clique para ver</span>
      </button>
    </div>
  );
}

function AttachmentView({ attachment: a, compact }: { attachment: Attachment; compact?: boolean }) {
  const url = fileUrl(a.url);
  switch (attachmentKind(a.contentType, a.filename)) {
    case 'image':
      return (
        <button
          onClick={() => actions.openModal({ kind: 'image', url, filename: a.filename })}
          className="block max-w-full overflow-hidden rounded-lg border border-edge bg-rail"
          title={a.filename}
        >
          <LoadingImage src={url} alt={a.filename} compact={compact} />
        </button>
      );
    case 'video':
      return (
        <VideoPlayer
          src={url}
          filename={a.filename}
          className={compact ? 'max-h-[180px] w-[280px] max-w-full' : 'max-h-[360px] w-[520px] max-w-full'}
        />
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

/** Imagem com skeleton animado até carregar. */
function LoadingImage({ src, alt, compact }: { src: string; alt: string; compact?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span className={cx('relative block', !loaded && (compact ? 'h-[120px] w-[200px]' : 'h-[220px] w-[320px]'))}>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={cx('block object-contain', compact ? 'max-h-[160px] max-w-[220px]' : 'max-h-[350px] max-w-[420px]', !loaded && 'absolute opacity-0')}
      />
    </span>
  );
}
