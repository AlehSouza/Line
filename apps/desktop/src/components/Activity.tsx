'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, type ActivitySettings, type MyGame, type ServerActivity } from '@/lib/api';
import { actions, displayNameIn, useLine } from '@/lib/store';
import { showError } from './Dialogs';
import { ActivityHoverCard } from './GameCard';
import { Avatar, cx, DefaultServerIcon, Icons } from './ui';
import { MobileBack, MobileMembersButton } from './Mobile';
import type { Channel } from '@line/shared';

export function formatPlayed(secs?: number | null) {
  const s = secs ?? 0;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  return `${Math.round(s / 3600)} h`;
}

export function ago(iso?: string | null) {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `há ${d} ${d === 1 ? 'dia' : 'dias'}`;
  const m = Math.floor(d / 30);
  return `há ${m} ${m === 1 ? 'mês' : 'meses'}`;
}

export function since(iso?: string) {
  if (!iso) return 'Jogando agora';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'Jogando agora';
  if (min < 60) return `Jogando há ${min} min`;
  return `Jogando há ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/** Capa (IGDB) ou o ícone do jogo; sem nenhum, um controle. */
export function GameArt({ cover, icon, size = 48 }: { cover?: string | null; icon?: string | null; size?: number }) {
  const src = cover || icon;
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raise" style={{ width: size, height: size }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className={cx('h-full w-full', cover ? 'object-cover' : 'object-contain')} />
      ) : (
        <Icons.Gamepad size={Math.round(size * 0.45)} className="text-muted" />
      )}
    </span>
  );
}

/** Quantas atividades cabem no topo da lista de membros; o resto fica no canal Atividades. */
const ACTIVITY_PREVIEW = 3;

/** "Atividades" no topo da lista de pessoas do servidor: quem está jogando (ou jogou nas últimas 24 h).
 *  `full`: todas, em grade (canal base Atividades); senão só as 3 primeiras e o título abre o canal. */
export function ActivitySection({ serverId, full }: { serverId: string; full?: boolean }) {
  const activityChannel = useLine((s) => {
    for (const c of Object.values(s.channels)) if (c.serverId === serverId && c.base === 'activity') return c.id;
    return null;
  });
  const [items, setItems] = useState<ServerActivity[]>([]);
  const users = useLine((s) => s.users);
  const [, tick] = useState(0);
  const [card, setCard] = useState<{ userId: string; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const hoverOpen = (userId: string, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setCard({ userId, rect: el.getBoundingClientRect() }), 300);
  };
  const hoverClose = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setCard(null), 250);
  };
  const keep = () => window.clearTimeout(hoverTimer.current);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () =>
      api.serverActivities(serverId).then(
        (l) => alive && setItems(l),
        () => {},
      );
    load();
    // Alguém começou/parou de jogar: recarrega (agrupando avisos seguidos).
    const onActivity = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 800);
    };
    window.addEventListener('line:activity', onActivity);
    const clock = window.setInterval(() => tick((n) => n + 1), 60_000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(clock);
      window.removeEventListener('line:activity', onActivity);
    };
  }, [serverId]);

  const all = items.filter((a) => users[a.userId]);
  const shown = full ? all : all.slice(0, ACTIVITY_PREVIEW);
  if (!all.length)
    return full ? (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted">
        <Icons.Gamepad size={40} />
        <p className="font-semibold text-soft">Ninguém jogou nada nas últimas 24 horas.</p>
        <p className="text-sm">Quando alguém do servidor abrir um jogo, ele aparece aqui.</p>
      </div>
    ) : null;
  const open = card && shown.find((a) => a.userId === card.userId);

  return (
    <div>
      <h3 className={cx('flex items-center gap-1.5 px-2 pb-1.5 text-xs font-bold tracking-wide text-muted uppercase', full && 'hidden')}>
        {activityChannel ? (
          <button
            title="Ver todas as atividades"
            onClick={() => actions.goServer(serverId, activityChannel)}
            className="uppercase hover:text-fg hover:underline"
          >
            Atividades — {all.length}
          </button>
        ) : (
          <>Atividades — {all.length}</>
        )}
        <button
          title="Privacidade nas atividades"
          onClick={() => actions.openModal({ kind: 'settings', section: 'activity' })}
          className="rounded p-0.5 hover:bg-hover hover:text-fg"
        >
          <Icons.Settings size={13} />
        </button>
      </h3>
      <div className={full ? 'grid gap-2 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-1.5'}>
        {shown.map((a) => {
          const u = users[a.userId]!;
          return (
            <button
              key={a.userId}
              onMouseEnter={(e) => hoverOpen(a.userId, e.currentTarget)}
              onMouseLeave={hoverClose}
              onClick={(e) => {
                window.clearTimeout(hoverTimer.current);
                setCard({ userId: a.userId, rect: e.currentTarget.getBoundingClientRect() });
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-xl border border-edge bg-rail/60 p-2.5 text-left hover:bg-hover',
                open?.userId === a.userId && 'bg-hover',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-xs">
                  <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={16} />
                  <span className="truncate font-semibold" style={{ color: u.avatarColor }}>
                    {displayNameIn(useLine.getState(), serverId, a.userId)}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[15px] font-bold">{a.name}</span>
                <span className="flex items-center gap-1 truncate text-xs text-muted">
                  {a.playing ? (
                    <>
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-online" />
                      {since(a.since)}
                    </>
                  ) : (
                    <>
                      <Icons.Gamepad size={12} />
                      {ago(a.lastPlayed)}
                      {!!a.totalSecs && a.totalSecs >= 3600 && ` · ${formatPlayed(a.totalSecs)} no total`}
                    </>
                  )}
                </span>
              </span>
              <GameArt cover={a.cover} icon={a.icon} size={50} />
            </button>
          );
        })}
      </div>
      {open && card && (
        <ActivityHoverCard
          key={open.userId}
          activity={open}
          serverId={serverId}
          anchor={card.rect}
          onEnter={keep}
          onLeave={(busy) => !busy && hoverClose()}
          onClose={() => setCard(null)}
        />
      )}
    </div>
  );
}

/** Canal base "Atividades": todas as atividades do servidor, em tela cheia. */
export function ActivityChannel({ channel }: { channel: Channel }) {
  if (!channel.serverId) return null;
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 shadow-sm">
        <MobileBack />
        <Icons.Gamepad size={20} className="text-muted" />
        <h1 className="truncate font-bold">{channel.name}</h1>
        {channel.topic && (
          <>
            <span className="mx-2 h-6 w-px bg-edge max-md:hidden" />
            <p className="truncate text-sm text-muted max-md:hidden">{channel.topic}</p>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <MobileMembersButton />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ActivitySection serverId={channel.serverId} full />
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-raise')}
    >
      <span className={cx('absolute top-1 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-6' : 'left-1')} />
    </button>
  );
}

/** Configurações → Jogos registrados: jogo atual e todos os jogos que o Line já viu abertos. */
export function GamesSection() {
  const [data, setData] = useState<{ current: string | null; games: MyGame[]; covers: boolean } | null>(null);
  const detects = typeof window !== 'undefined' && !!window.line?.version;

  useEffect(() => {
    api.myGames().then(setData, showError);
  }, []);

  async function patch(p: { name: string; hidden?: boolean; remove?: boolean }) {
    try {
      const r = await api.updateMyGame(p);
      setData((d) => d && { ...d, games: r.games });
    } catch (e) {
      showError(e);
    }
  }

  const current = data?.games.find((g) => g.name === data.current);

  return (
    <div className="space-y-10">
      <div>
        <h2 className="mb-1 text-xl font-bold">Jogo atual</h2>
        <p className="mb-4 text-sm text-muted">
          O app do Line para Windows reconhece o jogo aberto e mostra para os seus amigos e servidores (dá para limitar em Privacidade nas atividades).
        </p>
        {current ? (
          <div className="flex items-center gap-3 rounded-xl border border-edge bg-rail p-3">
            <GameArt cover={current.cover} icon={current.icon} size={48} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{current.name}</p>
              <p className="text-xs text-online">Jogando agora</p>
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-sm text-muted">
            {detects ? 'Nenhum jogo aberto agora.' : 'Abra o Line no app do Windows para reconhecer os jogos que você abre.'}
          </p>
        )}
      </div>

      <div>
        <h2 className="mb-1 text-xl font-bold">Jogos adicionados</h2>
        <p className="mb-4 text-sm text-muted">
          Desligue um jogo para não mostrar quando você estiver jogando ele.
          {data?.covers && (
            <>
              {' '}
              Capas fornecidas pela{' '}
              <a href="https://www.igdb.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                IGDB
              </a>
              .
            </>
          )}
        </p>
        {!data ? (
          <p className="text-sm text-muted">Carregando…</p>
        ) : !data.games.length ? (
          <p className="rounded-xl border border-dashed border-edge px-4 py-6 text-center text-sm text-muted">Nenhum jogo ainda.</p>
        ) : (
          <div className="divide-y divide-edge">
            {data.games.map((g) => (
              <div key={g.name} className="group flex items-center gap-3 py-3">
                <GameArt cover={g.cover} icon={g.icon} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{g.name}</p>
                  <p className="text-xs text-muted">
                    {g.name === data.current ? 'Jogando agora' : `Jogado pela última vez ${ago(g.lastPlayed)}`}
                    {g.totalSecs >= 60 && ` · ${formatPlayed(g.totalSecs)} no total`}
                  </p>
                </div>
                <button
                  title="Tirar da lista"
                  onClick={() => void patch({ name: g.name, remove: true })}
                  className="rounded p-1.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-danger"
                >
                  <Icons.Trash size={15} />
                </button>
                <Toggle on={!g.hidden} label={`Mostrar ${g.name}`} onChange={(v) => void patch({ name: g.name, hidden: !v })} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Configurações → Privacidade nas atividades. */
export function ActivityPrivacySection() {
  const [s, setS] = useState<ActivitySettings | null>(null);
  const [filter, setFilter] = useState('');
  const servers = useLine((st) => st.servers);
  const order = useLine((st) => st.serverOrder);

  useEffect(() => {
    api.activitySettings().then(setS, showError);
  }, []);

  async function save(next: ActivitySettings) {
    setS(next);
    try {
      setS(await api.setActivitySettings(next));
    } catch (e) {
      showError(e);
    }
  }

  const list = useMemo(() => {
    const all = (order.length ? order : Object.keys(servers)).map((id) => servers[id]).filter((x): x is NonNullable<typeof x> => !!x);
    const f = filter.trim().toLowerCase();
    return f ? all.filter((x) => x.name.toLowerCase().includes(f)) : all;
  }, [servers, order, filter]);

  if (!s) return <p className="text-sm text-muted">Carregando…</p>;
  const scopeOff = !s.share || s.scope === 'none';

  return (
    <div className="space-y-10">
      <div>
        <h2 className="mb-4 text-xl font-bold">Que atividades eu compartilho</h2>
        <div className="flex items-start gap-6">
          <div className="flex-1">
            <p className="font-medium">Compartilhar minha atividade</p>
            <p className="text-sm text-muted">Mostra o jogo que você está jogando (e há quanto tempo) na Atividade e no seu perfil.</p>
          </div>
          <Toggle on={s.share} label="Compartilhar minha atividade" onChange={(v) => void save({ ...s, share: v })} />
        </div>
        <button
          onClick={() => actions.openModal({ kind: 'settings', section: 'games' })}
          className="mt-6 flex w-full items-center gap-3 rounded-xl border border-edge bg-rail p-3 text-left hover:bg-hover"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-raise">
            <Icons.Gamepad size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Jogos registrados</span>
            <span className="block text-sm text-muted">Escolha jogo por jogo o que aparece para os outros.</span>
          </span>
          <Icons.ChevronRight size={18} className="text-muted" />
        </button>
      </div>

      <div className={cx(!s.share && 'pointer-events-none opacity-50')}>
        <h2 className="mb-1 text-xl font-bold">Onde eu compartilho atividades</h2>
        <p className="mb-4 text-sm text-muted">Seus amigos sempre veem a sua atividade (se ela estiver ligada).</p>
        <div className="space-y-2.5">
          {(
            [
              ['all', 'Compartilhar em todos os servidores'],
              ['small', 'Compartilhar em servidores com 200 membros ou menos'],
              ['none', 'Não compartilhar em nenhum servidor'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="flex cursor-pointer items-center gap-3">
              <input type="radio" name="activity-scope" checked={s.scope === id} onChange={() => void save({ ...s, scope: id })} className="h-4 w-4 accent-[var(--color-accent)]" />
              <span className="text-[15px]">{label}</span>
            </label>
          ))}
        </div>

        <div className={cx('mt-6', scopeOff && 'pointer-events-none opacity-50')}>
          <label className="mb-3 flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-muted focus-within:border-accent">
            <Icons.Search size={16} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar nos meus servidores" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted" />
          </label>
          <div className="mb-2 flex justify-end">
            <button
              onClick={() => void save({ ...s, hiddenServers: s.hiddenServers.length ? [] : list.map((x) => x.id) })}
              className="text-sm text-accent hover:underline"
            >
              {s.hiddenServers.length ? 'Ativar tudo' : 'Desativar tudo'}
            </button>
          </div>
          <div className="divide-y divide-edge">
            {list.map((srv) => {
              const on = !s.hiddenServers.includes(srv.id);
              const big = s.scope === 'small' && srv.memberCount > 200;
              return (
                <div key={srv.id} className={cx('flex items-center gap-3 py-2.5', big && 'opacity-50')}>
                  {srv.iconUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fileUrl(srv.iconUrl)} alt="" className="h-10 w-10 rounded-xl object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl" style={{ background: srv.iconColor }}>
                      <DefaultServerIcon />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{srv.name}</span>
                    <span className="block text-xs text-muted">{srv.memberCount.toLocaleString('pt-BR')} membros</span>
                  </span>
                  <Toggle
                    on={on && !big}
                    label={srv.name}
                    onChange={(v) =>
                      void save({ ...s, hiddenServers: v ? s.hiddenServers.filter((x) => x !== srv.id) : [...s.hiddenServers, srv.id] })
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
