'use client';

import type { Server } from '@line/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { actions } from '@/lib/store';
import { Button, Icons, initials, Input, Skeleton } from './ui';

export function DiscoverView() {
  const [query, setQuery] = useState('');
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .discover(query)
        .then(setServers)
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function join(server: Server) {
    try {
      const joined = await api.joinPublic(server.id);
      actions.upsertServer(joined);
      actions.goServer(joined.id);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="bg-gradient-to-br from-accent/30 via-main to-sun/10 px-10 py-12">
        <h1 className="text-3xl font-extrabold">Encontre sua galera no Line</h1>
        <p className="mt-2 text-soft">Servidores públicos criados pela comunidade deste servidor.</p>
        <div className="relative mt-6 max-w-xl">
          <Icons.Search size={18} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar servidores" className="py-3 pl-10" />
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-8">
        {error && <p className="text-danger">{error}</p>}
        {!servers && !error && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        {servers?.length === 0 && <p className="text-muted">Nenhum servidor público encontrado.</p>}
        {servers?.map((s) => (
          <div key={s.id} className="flex flex-col overflow-hidden rounded-xl border border-edge bg-side">
            <div className="h-16" style={{ background: `linear-gradient(135deg, ${s.iconColor}, transparent)` }} />
            <div className="-mt-7 flex flex-1 flex-col gap-2 px-4 pb-4">
              <span
                className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-bold text-rail ring-4 ring-side"
                style={{ background: s.iconColor }}
              >
                {initials(s.name)}
              </span>
              <h3 className="font-bold">{s.name}</h3>
              <p className="line-clamp-3 flex-1 text-sm text-muted">{s.description || 'Sem descrição.'}</p>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">{s.memberCount} membros</span>
                <Button onClick={() => join(s)} className="px-3 py-1.5">
                  Entrar
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
