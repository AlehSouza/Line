'use client';

import type { Server } from '@line/shared';
import * as L from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, fileUrl } from '@/lib/api';
import { mobile } from '@/lib/mobile';
import { ensureServerLoaded } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { showError } from './Dialogs';
import { DefaultServerIcon } from './ui';

type InviteInfo = Server & { onlineCount?: number; member?: boolean };

const cache = new Map<string, Promise<InviteInfo | null>>();
function loadInvite(code: string) {
  let p = cache.get(code);
  if (!p) {
    p = (api.invite(code) as Promise<InviteInfo>).catch(() => null);
    cache.set(code, p);
  }
  return p;
}

/** Entra pelo convite (ou só abre, se já for membro) e leva direto ao servidor. */
function useJoin(code: string, info: InviteInfo | null | undefined, onDone?: () => void) {
  const [joining, setJoining] = useState(false);
  const member = useLine((s) => (info ? !!s.servers[info.id] : false));
  async function go() {
    if (!info || joining) return;
    if (member) {
      actions.goServer(info.id);
      mobile.showNav();
      return onDone?.();
    }
    setJoining(true);
    try {
      const server = await api.acceptInvite(code);
      actions.upsertServer(server);
      // Carrega canais e membros antes de abrir, para o servidor já aparecer pronto.
      await ensureServerLoaded(server.id, true).catch(() => {});
      actions.goServer(server.id);
      mobile.showNav();
      onDone?.();
    } catch (e) {
      showError(e);
    } finally {
      setJoining(false);
    }
  }
  return { joining, member, go };
}

function useInvite(code: string) {
  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadInvite(code).then((v) => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, [code]);
  return info;
}

function Counts({ info, center }: { info: InviteInfo; center?: boolean }) {
  const count = info.memberCount;
  return (
    <p className={`mt-1 flex flex-wrap items-center gap-x-3 text-xs text-soft ${center ? 'justify-center' : ''}`}>
      {info.onlineCount != null && (
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-online" /> {info.onlineCount.toLocaleString('pt-BR')} online
        </span>
      )}
      <span className="flex items-center gap-1">
        <span className="h-2 w-2 rounded-full bg-offline" /> {count.toLocaleString('pt-BR')} {count === 1 ? 'membro' : 'membros'}
      </span>
    </p>
  );
}

function JoinLabel({ joining, member, suspended }: { joining: boolean; member: boolean; suspended?: boolean }) {
  if (joining)
    return (
      <>
        <L.LoaderCircle size={16} className="animate-spin" /> Entrando…
      </>
    );
  if (suspended) return <>Servidor suspenso</>;
  return <>{member ? 'Ir para o Servidor' : 'Juntar-se'}</>;
}

/** Tela cheia aberta por um link de convite: válido (entrar) ou inválido. */
export function InvitePage({ code, onClose }: { code: string; onClose: () => void }) {
  const info = useInvite(code);
  const { joining, member, go } = useJoin(code, info, onClose);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-rail p-4">
      {info?.bannerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fileUrl(info.bannerUrl)} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-accent/40 via-rail to-sun/20" />
      )}
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative w-[480px] max-w-full rounded-xl bg-side px-8 py-8 text-center shadow-2xl max-md:px-5">
        {info === undefined ? (
          <div className="flex flex-col items-center gap-3">
            <div className="h-16 w-16 animate-pulse rounded-[18px] bg-raise" />
            <div className="h-4 w-48 animate-pulse rounded bg-raise" />
            <div className="h-6 w-40 animate-pulse rounded bg-raise" />
            <div className="h-10 w-full animate-pulse rounded-lg bg-raise" />
          </div>
        ) : info === null ? (
          <>
            <h2 className="text-2xl font-bold text-fg">Convite inválido</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-soft">
              Este convite pode ter expirado, ou talvez você não tenha permissão para entrar.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 h-10 w-full rounded-lg bg-accent text-sm font-semibold text-on-accent transition-colors hover:bg-accent-strong"
            >
              Continuar para o Line
            </button>
            <p className="mt-3 text-left text-xs text-muted">
              O dono do servidor pode ter gerado um link novo. Peça um convite atualizado para quem te mandou.
            </p>
          </>
        ) : (
          <>
            <span className="mx-auto flex h-16 w-16 overflow-hidden rounded-[18px] bg-raise">
              {info.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(info.iconUrl)} alt="" className="h-full w-full object-cover" />
              ) : (
                <DefaultServerIcon />
              )}
            </span>
            <p className="mt-3 text-sm text-soft">{member ? 'Você já participa de' : 'Você foi convidado(a) para entrar'}</p>
            <h2 className="mt-1 truncate text-2xl font-bold text-fg">{info.name}</h2>
            <Counts info={info} center />
            <button
              type="button"
              disabled={joining || info.suspended}
              onClick={() => void go()}
              className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
            >
              <JoinLabel joining={joining} member={member} suspended={info.suspended} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 h-10 w-full rounded-lg bg-raise text-sm font-semibold text-fg transition-colors hover:bg-hover"
            >
              Agora não
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Cartão de convite no chat: banner, foto, nome, online/membros, desde quando e o botão de entrar. */
export function InviteCard({ code }: { code: string }) {
  const info = useInvite(code);
  const { joining, member, go } = useJoin(code, info);

  if (info === null) {
    return (
      <div className="mt-1.5 flex w-[300px] max-w-full items-center gap-3 rounded-xl border border-edge bg-side p-4 text-sm text-muted">
        <L.Link2Off size={18} className="shrink-0" /> Convite inválido ou expirado.
      </div>
    );
  }

  return (
    <div className="mt-1.5 w-[300px] max-w-full overflow-hidden rounded-xl border border-edge bg-side">
      <div className="h-[72px] bg-gradient-to-b from-[#d9d9d9] to-[#8a8a8a]">
        {info?.bannerUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(info.bannerUrl)} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="px-4 pb-4">
        <span className="-mt-8 flex h-[64px] w-[64px] overflow-hidden rounded-[18px] border-4 border-side bg-side">
          {info?.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(info.iconUrl)} alt="" className="h-full w-full rounded-[14px] object-cover" />
          ) : (
            <span className="h-full w-full overflow-hidden rounded-[14px]">
              <DefaultServerIcon />
            </span>
          )}
        </span>
        {info === undefined ? (
          <div className="mt-2 space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-raise" />
            <div className="h-3 w-44 animate-pulse rounded bg-raise" />
            <div className="h-9 w-full animate-pulse rounded-lg bg-raise" />
          </div>
        ) : (
          <>
            <p className="mt-2 truncate text-base leading-tight font-bold text-fg">{info.name}</p>
            <Counts info={info} />
            <p className="mt-0.5 text-xs text-muted">
              Desde {new Date(info.createdAt).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
            </p>
            <button
              type="button"
              disabled={joining || info.suspended}
              onClick={() => void go()}
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#248046] text-sm font-semibold text-white transition hover:bg-[#1a6334] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <JoinLabel joining={joining} member={member} suspended={info.suspended} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
