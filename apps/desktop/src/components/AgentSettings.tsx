'use client';

import type { PublicUser } from '@line/shared';
import * as L from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, fileUrl, type AgentReply } from '@/lib/api';
import { DEFAULT_NOW_PLAYING, formatNowPlaying } from '@/lib/music';
import { StyledName } from '@/lib/nameStyle';
import { actions, useLine } from '@/lib/store';
import { showError, toast } from './Dialogs';
import { FullProfile } from './FullProfile';
import { BotTag, useServerBot } from './Music';
import { Avatar, Button, cx, ErrorText, Field, SwatchRow } from './ui';
import { EmojiInput, EmojiTextarea } from './EmojiField';

// ---------- Configurações do servidor → Agente → Personalizar ----------

type Presence = 'online' | 'idle' | 'dnd' | 'invisible';

const PRESENCES = [
  ['online', 'Online', 'bg-online'],
  ['idle', 'Ausente', 'bg-idle'],
  ['dnd', 'Não perturbar', 'bg-danger'],
  ['invisible', 'Invisível', 'bg-muted'],
] as const;
const SAMPLE_TRACK = { title: 'Nome da música', author: 'Artista' };

/**
 * Personalizar agente: o mesmo editor do Perfil da pessoa. Aba Cartão = o cartão do agente,
 * clicável (nome, nota, pronomes, status, bio, faixa, avatar, música, cores e estilo do nome),
 * salvando na hora. Aba Chamada = anel de fala, status do canal enquanto toca e fila vazia.
 */
export function MusicSettings({ serverId }: { serverId: string }) {
  const [botId, setBotId] = useState<string | null>(null);
  const bot = useLine((s) => (botId ? s.users[botId] : undefined));
  const [tab, setTab] = useState<'card' | 'call'>('card');
  const [error, setError] = useState('');
  // Aba Chamada (salva no botão).
  const [ringColor, setRingColor] = useState<string | null>(null);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [idle, setIdle] = useState('');
  const [idleDefault, setIdleDefault] = useState('Esperando a próxima banger 😈');
  const [savedCall, setSavedCall] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let idleMsg = '';
    Promise.all([
      api.musicSettings(serverId).then((s) => {
        idleMsg = s.idleMessage;
        setIdle(s.idleMessage);
        setIdleDefault(s.defaultIdleMessage);
      }, () => {}),
      api.musicBot(serverId),
    ])
      .then(([, b]) => {
        actions.upsertUsers([b]);
        setBotId(b.id);
        setRingColor(b.botStyle?.ringColor ?? null);
        setNowPlaying(b.botStyle?.nowPlaying ?? null);
        setSavedCall(JSON.stringify([b.botStyle?.ringColor ?? null, b.botStyle?.nowPlaying ?? null, idleMsg]));
      })
      .catch((e) => setError((e as Error).message));
  }, [serverId]);

  /** Status e etiqueta salvam na hora, como o resto do cartão. */
  async function quick(patch: Parameters<typeof api.updateMusicBot>[1]) {
    try {
      actions.upsertUsers([await api.updateMusicBot(serverId, patch)]);
    } catch (e) {
      showError(e);
    }
  }

  const call = JSON.stringify([ringColor, nowPlaying === null ? null : nowPlaying.trim(), idle.trim()]);
  async function saveCall() {
    setBusy(true);
    try {
      const b = await api.updateMusicBot(serverId, { botRingColor: ringColor, botNowPlaying: nowPlaying === null ? null : nowPlaying.trim() });
      const s = await api.updateMusicSettings(serverId, { idleMessage: idle.trim() });
      actions.upsertUsers([b]);
      setIdle(s.idleMessage);
      setSavedCall(JSON.stringify([b.botStyle?.ringColor ?? null, b.botStyle?.nowPlaying ?? null, s.idleMessage]));
      toast('Agente salvo.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  const presence: Presence = !bot || bot.presence === 'offline' ? 'invisible' : bot.presence === 'idle' || bot.presence === 'dnd' ? bot.presence : 'online';
  const style = bot?.botStyle;

  return (
    <div className="max-w-5xl">
      <h2 className="text-xl font-bold">Personalizar agente</h2>
      <p className="mt-1 mb-5 text-sm text-soft">
        Ele entra no canal de voz quando alguém digita <code className="rounded bg-raise px-1">/play [link ou nome da música]</code> num canal de texto. Quem começou a tocar controla
        tudo; os outros votam para pular, voltar ou pausar.
      </p>
      {!bot ? (
        error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <div className="flex flex-col gap-8 xl:flex-row xl:items-start">
          <div className="flex w-full shrink-0 flex-col xl:w-[400px]">
            <div className="mb-4 flex justify-center gap-6 border-b border-edge">
              {(
                [
                  ['card', 'Cartão'],
                  ['call', 'Chamada'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cx('-mb-px border-b-2 pb-2 text-sm font-semibold', tab === id ? 'border-fg text-fg' : 'border-transparent text-soft hover:text-fg')}
                >
                  {label}
                </button>
              ))}
            </div>
            {tab === 'card' ? (
              <div className="flex h-[640px] max-h-[75vh] flex-col">
                <FullProfile userId={bot.id} agentServerId={serverId} embedded onClose={() => {}} />
              </div>
            ) : (
              <AgentCallPreview bot={bot} ringColor={ringColor} nowPlaying={nowPlaying} />
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-5">
            {tab === 'card' ? (
              <>
                <p className="rounded-lg border border-edge bg-rail px-3 py-2.5 text-sm text-soft">
                  Clique no cartão para editar: nome, nota, pronomes, status, bio, música favorita, faixa e avatar (lápis no canto), estilo do nome (pincel) e cores do cartão (bolinha
                  no canto de baixo). Tudo salva na hora.
                </p>
                <Field label="Status" hint="Como o agente aparece na lista de membros e no cartão." group>
                  <div className="flex flex-wrap gap-2">
                    {PRESENCES.map(([v, label, dot]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => void quick({ status: v })}
                        className={cx(
                          'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm',
                          presence === v ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                        )}
                      >
                        <span className={cx('h-2.5 w-2.5 rounded-full', dot)} /> {label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Etiqueta" group>
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      {(['BOT', 'B'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => void quick({ botTagText: t })}
                          className={cx(
                            'rounded-lg border px-3 py-1.5 text-sm font-bold',
                            (style?.tagText ?? 'BOT') === t ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise',
                          )}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <SwatchRow value={style?.tagColor ?? null} onChange={(c) => void quick({ botTagColor: c })} noneLabel="Padrão" />
                  </div>
                </Field>
                {!bot.nameStyle && (
                  <Field label="Cor do nome" hint="Sem estilo de nome, o agente usa esta cor." group>
                    <SwatchRow value={style?.nameColor ?? null} onChange={(c) => void quick({ botNameColor: c })} noneLabel="Cor do cargo" />
                  </Field>
                )}
              </>
            ) : (
              <>
                <Field label="Cor do anel de fala" hint="A bolinha em volta da foto do agente na lista do canal de voz enquanto ele toca." group>
                  <SwatchRow value={ringColor} onChange={setRingColor} noneLabel="Cor de destaque" />
                </Field>
                <Field label="Status do canal enquanto toca" hint="Quando ninguém definiu um status no canal de voz, o agente mostra a música tocando." group>
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      {(
                        [
                          [true, 'Mostrar a música'],
                          [false, 'Não mostrar'],
                        ] as const
                      ).map(([on, label]) => {
                        const active = on ? nowPlaying !== '' : nowPlaying === '';
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setNowPlaying(on ? (nowPlaying === '' ? null : nowPlaying) : '')}
                            className={cx('rounded-lg border px-3 py-1.5 text-sm', active ? 'border-accent bg-accent/15 text-fg' : 'border-edge text-soft hover:bg-raise')}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    {nowPlaying !== '' && (
                      <>
                        <EmojiInput value={nowPlaying ?? ''} onChange={(e) => setNowPlaying(e.target.value || null)} maxLength={100} placeholder={DEFAULT_NOW_PLAYING} />
                        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                          Use
                          {['{musica}', '{artista}'].map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setNowPlaying(`${nowPlaying ?? DEFAULT_NOW_PLAYING} ${v}`.trim())}
                              className="rounded bg-raise px-1.5 py-0.5 font-mono text-soft hover:text-fg"
                            >
                              {v}
                            </button>
                          ))}
                          no texto. Vazio usa o padrão <code className="rounded bg-raise px-1">{DEFAULT_NOW_PLAYING}</code>.
                        </p>
                      </>
                    )}
                  </div>
                </Field>
                <Field label="Mensagem quando a fila acaba" hint="O agente fica na call e manda isso no chat onde a música foi pedida. Vazio usa a padrão.">
                  <EmojiInput value={idle} onChange={(e) => setIdle(e.target.value)} maxLength={300} placeholder={idleDefault} />
                </Field>
                <div className="flex justify-end">
                  <Button disabled={busy || call === savedCall} onClick={saveCall} className="px-6">
                    {busy ? 'Salvando…' : 'Salvar'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Prévia da aba Chamada: o canal de voz na barra lateral com o agente tocando. */
function AgentCallPreview({ bot, ringColor, nowPlaying }: { bot: PublicUser; ringColor: string | null; nowPlaying: string | null }) {
  const status = nowPlaying === '' ? '' : formatNowPlaying(nowPlaying || DEFAULT_NOW_PLAYING, SAMPLE_TRACK.title, SAMPLE_TRACK.author);
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-edge bg-side px-2 py-2">
        <p className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[15px] text-soft">
          <L.Volume2 size={18} className="text-muted" />
          <span className="truncate">Canal de voz</span>
        </p>
        <div className="ml-6 space-y-1 pt-0.5">
          <p className={cx('truncate px-1.5 py-0.5 text-xs', status ? 'text-soft' : 'text-muted')}>{status || 'Definir um status do canal'}</p>
          <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1 text-[15px] text-soft">
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center">
              <Avatar name={bot.displayName} color={bot.avatarColor} src={bot.avatarUrl} size={24} />
              <span
                className="pointer-events-none absolute -inset-[3px] animate-pulse rounded-full border-2 border-accent"
                style={ringColor ? { borderColor: ringColor } : undefined}
              />
            </span>
            <StyledName user={bot} color={bot.botStyle?.nameColor ?? undefined} className="flex-1 truncate">
              {bot.displayName}
            </StyledName>
            <BotTag user={bot} />
          </div>
        </div>
      </div>
      <p className="text-xs text-muted">Se alguém da chamada definir um status, ele vale no lugar da música.</p>
    </div>
  );
}

// ---------- Configurações do servidor → Agente → Respostas inteligentes ----------

type Row = { key: number; open: boolean };

/**
 * Perguntas e respostas cadastradas pelo dono: quem marcar o agente com uma pergunta parecida
 * recebe a resposta. Com várias, ficam recolhidas mostrando só a pergunta; a nova entra no topo.
 */
export function SmartReplies({ serverId }: { serverId: string }) {
  const [items, setItems] = useState<AgentReply[] | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const nextKey = useRef(0);
  const [uploading, setUploading] = useState<number | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bot = useServerBot(serverId);
  const handle = `@${bot?.displayName ?? 'agente'}`;

  const load = (l: AgentReply[], keepOpen?: Row[]) => {
    setItems(l);
    setSaved(JSON.stringify(l));
    setRows(l.map((_, i) => ({ key: nextKey.current++, open: keepOpen?.[i]?.open ?? l.length === 1 })));
  };

  useEffect(() => {
    api
      .agentReplies(serverId)
      .then((l) => load(l))
      .catch((e) => setError((e as Error).message));
  }, [serverId]);

  async function save() {
    if (!items) return;
    setBusy(true);
    try {
      // Itens vazios são descartados pelo servidor: os que sobram mantêm aberto/fechado.
      const kept = rows.filter((_, i) => items[i]!.q.trim() || items[i]!.a.trim() || items[i]!.media?.length);
      load(await api.setAgentReplies(serverId, items), kept);
      toast('Respostas salvas.');
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  }

  async function addMedia(i: number, files: FileList | null) {
    const list = Array.from(files ?? []).filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!list.length) return;
    const room = 4 - (items?.[i]?.media?.length ?? 0);
    if (list.length > room) toast('No máximo 4 imagens ou vídeos por resposta.');
    const key = rows[i]?.key;
    setUploading(key ?? null);
    try {
      for (const f of list.slice(0, Math.max(0, room))) {
        const a = await api.uploadAttachment(f, f.name);
        // Acha a linha pela chave: a lista pode ter mudado enquanto enviava.
        const at = rowsRef.current.findIndex((x) => x.key === key);
        if (at >= 0) setItems((l) => l && l.map((it, j) => (j === at ? { ...it, media: [...(it.media ?? []), a] } : it)));
      }
    } catch (e) {
      showError(e);
    } finally {
      setUploading(null);
    }
  }

  const set = (i: number, patch: Partial<AgentReply>) => setItems((l) => l && l.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const toggle = (i: number) => setRows((r) => r.map((x, j) => (j === i ? { ...x, open: !x.open } : x)));
  const remove = (i: number) => {
    setItems((l) => l && l.filter((_, j) => j !== i));
    setRows((r) => r.filter((_, j) => j !== i));
  };
  const add = () => {
    setItems((l) => [{ q: '', a: '' }, ...(l ?? [])]);
    setRows((r) => [{ key: nextKey.current++, open: true }, ...r]);
  };
  const allOpen = rows.length > 0 && rows.every((r) => r.open);
  const dirty = !!items && JSON.stringify(items) !== saved;

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold">Respostas inteligentes</h2>
      <p className="mt-1 mb-4 text-sm text-soft">
        Cadastre perguntas e o que o agente deve responder. Quando alguém marcar o agente com uma pergunta parecida (ex.:{' '}
        <code className="rounded bg-raise px-1">{handle} qual o dia da próxima RAID?</code>), ele responde no chat com o texto que você colocou.
      </p>
      {!items ? (
        error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <div className="space-y-3">
          <div className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-side px-1 py-2">
            <Button variant="ghost" disabled={items.length >= 100} onClick={add} className="gap-1.5">
              <L.Plus size={15} /> Adicionar resposta
            </Button>
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setRows((r) => r.map((x) => ({ ...x, open: !allOpen })))}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-soft hover:bg-hover hover:text-fg"
              >
                {allOpen ? <L.ChevronsDownUp size={14} /> : <L.ChevronsUpDown size={14} />}
                {allOpen ? 'Recolher todas' : 'Expandir todas'}
              </button>
            )}
            <span className="flex-1" />
            <span className="text-xs text-muted">{items.length} / 100</span>
            <Button disabled={busy || !dirty} onClick={save} className="px-6">
              {busy ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
          {items.length === 0 && <p className="rounded-lg border border-dashed border-edge px-4 py-6 text-center text-sm text-muted">Nenhuma resposta ainda.</p>}
          {items.map((it, i) => {
            const row = rows[i];
            if (!row) return null;
            return row.open ? (
              <div key={row.key} className="space-y-2 rounded-xl border border-edge bg-rail p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold tracking-wide text-muted uppercase">Pergunta</span>
                  <span className="flex-1" />
                  {items.length > 1 && (
                    <button type="button" title="Recolher" onClick={() => toggle(i)} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
                      <L.ChevronUp size={15} />
                    </button>
                  )}
                  <button type="button" title="Apagar" onClick={() => remove(i)} className="rounded p-1 text-muted hover:bg-hover hover:text-danger">
                    <L.Trash2 size={15} />
                  </button>
                </div>
                <EmojiInput value={it.q} onChange={(e) => set(i, { q: e.target.value })} maxLength={200} placeholder="qual o dia da próxima RAID?" autoFocus={!it.q && !it.a} />
                <span className="block text-xs font-bold tracking-wide text-muted uppercase">Resposta</span>
                <EmojiTextarea
                  value={it.a}
                  onChange={(e) => set(i, { a: e.target.value })}
                  maxLength={2000}
                  rows={2}
                  placeholder="A próxima RAID é sábado às 21h!"
                  className="w-full resize-y rounded-lg border border-edge bg-side px-3 py-2 text-sm outline-none focus:border-accent"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {(it.media ?? []).map((m) => (
                    <div key={m.id} className="group relative size-16 overflow-hidden rounded-lg border border-edge bg-side">
                      {m.contentType.startsWith('video/') ? (
                        <video src={fileUrl(m.url)} muted className="size-full object-cover" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={fileUrl(m.url)} alt="" className="size-full object-cover" />
                      )}
                      {m.contentType.startsWith('video/') && <L.Play size={16} className="pointer-events-none absolute inset-0 m-auto text-white drop-shadow" />}
                      <button
                        type="button"
                        title="Tirar"
                        onClick={() => set(i, { media: (it.media ?? []).filter((x) => x.id !== m.id) })}
                        className="absolute top-0.5 right-0.5 rounded-full bg-black/70 p-0.5 text-white"
                      >
                        <L.X size={12} />
                      </button>
                    </div>
                  ))}
                  {(it.media?.length ?? 0) < 4 && (
                    <label
                      title="Adicionar imagem ou vídeo"
                      className={cx(
                        'flex size-16 cursor-pointer items-center justify-center rounded-lg border border-dashed border-edge text-muted hover:bg-hover hover:text-fg',
                        uploading === row.key && 'pointer-events-none opacity-60',
                      )}
                    >
                      {uploading === row.key ? <L.Loader2 size={18} className="animate-spin" /> : <L.ImagePlus size={20} />}
                      <input
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        hidden
                        onChange={(e) => {
                          void addMedia(i, e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  <span className="text-xs text-muted">Imagens ou vídeos enviados junto com a resposta (até 4).</span>
                </div>
              </div>
            ) : (
              <div key={row.key} className="group flex items-center gap-2 rounded-xl border border-edge bg-rail px-3 py-2.5 hover:bg-hover">
                <button type="button" onClick={() => toggle(i)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                  <L.MessageCircleQuestion size={16} className="shrink-0 text-muted" />
                  <span className={cx('truncate text-sm font-medium', !it.q.trim() && 'text-muted italic')}>{it.q.trim() || 'Pergunta sem texto'}</span>
                  {!!it.media?.length && (
                    <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted">
                      <L.Image size={12} /> {it.media.length}
                    </span>
                  )}
                  <span className="flex-1" />
                  <L.ChevronDown size={15} className="shrink-0 text-muted" />
                </button>
                <button type="button" title="Apagar" onClick={() => remove(i)} className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-danger">
                  <L.Trash2 size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
