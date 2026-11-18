"use client";

import type { Sound } from "@line/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, fileUrl } from "@/lib/api";
import { hasPerm, Perm } from "@line/shared";
import { channelPermsOf, permsOf, useLine } from "@/lib/store";
import {
  decodeFile,
  loadSounds,
  MAX_SOUND_SECONDS,
  playSound,
  previewSound,
  setSoundboardVolume,
  toggleFavorite,
  trimToWav,
  useSounds,
  waveform,
} from "@/lib/sounds";
import { useVoice } from "@/lib/voice";
import { confirmDialog, showError, toast } from "./Dialogs";
import { EMOJI_FONT, EmojiPicker } from "./EmojiPicker";
import { Avatar, Button, cx, Icons, Input, Modal, Slider } from "./ui";

const MAX_SOUNDS = 15;

function norm(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// ---------- painel na chamada ----------

const PANEL_W = 560;
const PANEL_H = 520;

/** Botão do painel de efeitos sonoros (abre o painel flutuando acima dele). */
export function SoundboardButton({
  className,
  size = 16,
  title = "Painel de efeitos sonoros",
}: {
  className: string;
  size?: number;
  title?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const voiceChannel = useVoice((v) => v.channelId);
  const allowed = useLine((s) => !voiceChannel || hasPerm(channelPermsOf(s, voiceChannel, s.me?.id), Perm.UseSoundboard));
  return (
    <>
      <button
        title={allowed ? title : "Você não tem permissão para usar efeitos sonoros neste canal"}
        disabled={!allowed}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        className={cx(className, anchor && "bg-hover text-fg")}
      >
        <Icons.Soundboard size={size} />
      </button>
      {anchor && (
        <SoundboardPanel
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onAddSound={(id) => {
            setAnchor(null);
            setUploadFor(id);
          }}
        />
      )}
      {uploadFor && (
        <UploadSoundModal
          serverId={uploadFor}
          onClose={() => setUploadFor(null)}
        />
      )}
    </>
  );
}

type Section = {
  key: string;
  title: string;
  icon: React.ReactNode;
  sounds: Sound[];
};

function SoundboardPanel({
  anchor,
  onClose,
  onAddSound,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onAddSound: (serverId: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    h: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [volOpen, setVolOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sounds = useSounds((s) => s.sounds);
  const loaded = useSounds((s) => s.loaded);
  const favorites = useSounds((s) => s.favorites);
  const recents = useSounds((s) => s.recents);
  const volume = useSounds((s) => s.volume);
  const playing = useSounds((s) => s.playing);
  const muted = useVoice((v) => v.muted || v.deafened);
  const voiceChannel = useVoice((v) => v.channelId);
  const callServerId =
    useLine((s) =>
      voiceChannel ? s.channels[voiceChannel]?.serverId : null,
    ) ?? null;
  const servers = useLine((s) => s.servers);
  const order = useLine((s) => s.serverOrder);
  // Servidores em que posso enviar sons (string para o seletor ser estável).
  const manageable = useLine((s) =>
    Object.keys(s.servers)
      .filter((id) =>
        hasPerm(permsOf(s, id, s.me?.id), Perm.ManageSoundboard),
      )
      .join(","),
  );
  const canAddIn = useMemo(
    () => new Set(manageable.split(",").filter(Boolean)),
    [manageable],
  );

  useEffect(() => {
    void loadSounds();
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = anchor.getBoundingClientRect();
      const w = Math.min(PANEL_W, vw - 16);
      const h = Math.min(PANEL_H, Math.max(240, r.top - 16));
      const left = Math.max(8, Math.min(r.left, vw - w - 8));
      let top = r.top - h - 8;
      if (top < 8) top = Math.min(r.bottom + 8, vh - h - 8);
      setPos({ left, top: Math.max(8, top), h });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  const byId = useMemo(() => new Map(sounds.map((s) => [s.id, s])), [sounds]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const q = norm(query.trim());
    if (q) {
      out.push({
        key: "search",
        title: "Resultados",
        icon: <Icons.Search size={14} />,
        sounds: sounds.filter(
          (s) => norm(s.name).includes(q) || s.emoji === query.trim(),
        ),
      });
      return out;
    }
    if (callServerId) {
      const popular = sounds
        .filter((s) => s.serverId === callServerId && s.plays > 0)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 6);
      if (popular.length)
        out.push({
          key: "popular",
          title: `Sons mais populares em ${servers[callServerId]?.name ?? "este servidor"}`,
          icon: <Icons.Trophy size={14} />,
          sounds: popular,
        });
    }
    const fav = favorites
      .map((id) => byId.get(id))
      .filter((s): s is Sound => !!s);
    out.push({
      key: "favorites",
      title: "Favoritos",
      icon: <Icons.Star size={14} />,
      sounds: fav,
    });
    const rec = recents
      .map((id) => byId.get(id))
      .filter((s): s is Sound => !!s);
    if (rec.length)
      out.push({
        key: "recents",
        title: "Usados recentemente",
        icon: <Icons.Clock size={14} />,
        sounds: rec,
      });
    // Servidor da chamada primeiro, depois na ordem da barra de servidores.
    const ids = [
      ...new Set([callServerId, ...order].filter((x): x is string => !!x)),
    ];
    for (const id of ids) {
      const list = sounds.filter((s) => s.serverId === id);
      if (list.length)
        out.push({
          key: `server:${id}`,
          title: servers[id]?.name ?? "Servidor",
          icon: null,
          sounds: list,
        });
    }
    return out;
  }, [query, sounds, callServerId, favorites, recents, byId, order, servers]);

  const jump = (key: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(
      `[data-section="${key}"]`,
    );
    if (el && scroller.current)
      scroller.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
  };

  const play = (s: Sound) => {
    const err = playSound(s);
    if (err) toast(err, "error");
  };

  if (!pos) return null;
  const railBtn =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg";

  return createPortal(
    <div
      ref={box}
      style={{
        left: pos.left,
        top: pos.top,
        width: Math.min(PANEL_W, window.innerWidth - 16),
        height: pos.h,
      }}
      className="fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-edge bg-rail shadow-2xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="relative flex items-center gap-2 border-b border-edge p-3">
        <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-edge bg-main px-3 focus-within:border-accent">
          <Icons.Search size={16} className="text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Encontre o som perfeito"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-muted hover:text-fg"
              title="Limpar"
            >
              <Icons.X size={14} />
            </button>
          )}
        </label>
        <button
          title="Volume dos efeitos sonoros"
          onClick={() => setVolOpen((v) => !v)}
          className={cx(
            "flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg",
            volOpen && "bg-hover text-fg",
          )}
        >
          {volume === 0 ? (
            <Icons.SpeakerOff size={18} />
          ) : (
            <Icons.Speaker size={18} />
          )}
        </button>
        {volOpen && (
          <div className="absolute top-full right-3 z-10 mt-1 w-64 rounded-xl border border-edge bg-side p-4 shadow-2xl">
            <p className="mb-3 text-sm font-semibold">
              Volume dos efeitos sonoros
            </p>
            <div className="flex items-center gap-3">
              <Slider
                value={Math.round(volume * 100)}
                onChange={(v) => setSoundboardVolume(v / 100)}
                label="Volume dos efeitos sonoros"
                className="flex-1"
              />
              <span className="w-9 text-right text-xs text-muted">
                {Math.round(volume * 100)}%
              </span>
            </div>
          </div>
        )}
      </div>
      {muted && (
        <div className="flex items-center gap-2 border-b border-edge bg-danger/10 px-3 py-2 text-xs text-danger">
          <Icons.MicOff size={14} /> Ative o microfone para tocar os efeitos
          sonoros.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {!query && (
          <nav className="flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-edge py-2">
            {sections.map((s) => {
              const sid = s.key.startsWith("server:") ? s.key.slice(7) : null;
              const server = sid ? servers[sid] : null;
              return (
                <button
                  key={s.key}
                  title={s.title}
                  onClick={() => jump(s.key)}
                  className={railBtn}
                >
                  {server ? (
                    server.iconUrl ? (
                      <img
                        src={fileUrl(server.iconUrl)}
                        alt=""
                        className="h-8 w-8 rounded-lg object-cover"
                      />
                    ) : (
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-raise text-xs font-bold">
                        {server.name.slice(0, 2).toUpperCase()}
                      </span>
                    )
                  ) : s.key === "popular" ? (
                    <Icons.Trophy size={20} />
                  ) : s.key === "favorites" ? (
                    <Icons.Star size={20} />
                  ) : (
                    <Icons.Clock size={20} />
                  )}
                </button>
              );
            })}
          </nav>
        )}
        <div
          ref={scroller}
          className="relative min-w-0 flex-1 overflow-y-auto p-3"
        >
          {!loaded && (
            <p className="p-4 text-center text-sm text-muted">
              Carregando sons…
            </p>
          )}
          {loaded && sounds.length === 0 && (
            <div className="p-6 text-center text-sm text-muted">
              <Icons.Soundboard size={28} className="mx-auto mb-2" />
              Nenhum som ainda. Quem administra o servidor pode enviar sons em
              Configurações do servidor → Painel de efeitos sonoros.
            </div>
          )}
          {loaded &&
            sounds.length > 0 &&
            sections.map((sec) => (
              <section key={sec.key} data-section={sec.key} className="mb-3">
                <button
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [sec.key]: !c[sec.key] }))
                  }
                  className="mb-2 flex max-w-full items-center gap-1.5 text-xs font-bold text-soft hover:text-fg"
                >
                  {sec.icon}
                  <span className="truncate">{sec.title}</span>
                  <Icons.Chevron
                    size={12}
                    className={cx(
                      "shrink-0 transition-transform",
                      collapsed[sec.key] && "-rotate-90",
                    )}
                  />
                </button>
                {!collapsed[sec.key] &&
                  (sec.sounds.length === 0 ? (
                    <p className="px-1 pb-1 text-xs text-muted">
                      {sec.key === "favorites"
                        ? "Passe o mouse num som e clique na estrela para favoritar."
                        : "Nada por aqui."}
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-2">
                      {sec.sounds.map((s) => (
                        <SoundTile
                          key={s.id}
                          sound={s}
                          disabled={muted}
                          favorite={favorites.includes(s.id)}
                          playing={!!playing[s.id]}
                          onPlay={() => play(s)}
                        />
                      ))}
                      {(() => {
                        const sid = sec.key.startsWith("server:")
                          ? sec.key.slice(7)
                          : null;
                        if (
                          !sid ||
                          !canAddIn.has(sid) ||
                          sec.sounds.length >= MAX_SOUNDS
                        )
                          return null;
                        return (
                          <button
                            onClick={() => onAddSound(sid)}
                            title="Enviar um novo som para este servidor"
                            className="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-edge px-3 text-[13px] font-semibold text-muted transition-colors hover:border-accent hover:bg-hover hover:text-fg"
                          >
                            <Icons.Plus size={16} className="shrink-0" />
                            <span className="truncate">Novo áudio</span>
                          </button>
                        );
                      })()}
                    </div>
                  ))}
              </section>
            ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SoundTile({
  sound,
  disabled,
  favorite,
  playing,
  onPlay,
}: {
  sound: Sound;
  disabled: boolean;
  favorite: boolean;
  playing: boolean;
  onPlay: () => void;
}) {
  return (
    <div className="group relative">
      <button
        onClick={onPlay}
        title={sound.name}
        className={cx(
          "flex h-11 w-full items-center justify-center gap-2 rounded-lg border px-3 text-[13px] font-semibold transition-colors",
          playing
            ? "border-accent bg-accent/20 text-fg"
            : "border-transparent bg-raise text-fg hover:bg-hover",
          disabled && "opacity-50",
        )}
      >
        {sound.emoji ? (
          <span
            className="shrink-0 text-lg leading-none"
            style={{ fontFamily: EMOJI_FONT }}
          >
            {sound.emoji}
          </span>
        ) : (
          <Icons.Speaker size={16} className="shrink-0 text-muted" />
        )}
        <span className="truncate">{sound.name}</span>
      </button>
      <button
        title={favorite ? "Tirar dos favoritos" : "Favoritar"}
        onClick={() => toggleFavorite(sound.id)}
        className={cx(
          "absolute top-0.5 right-0.5 rounded p-0.5 transition-opacity",
          favorite
            ? "text-sun opacity-100"
            : "text-muted opacity-0 group-hover:opacity-100 hover:text-fg",
        )}
      >
        <Icons.Star size={12} className={favorite ? "fill-current" : ""} />
      </button>
    </div>
  );
}

// ---------- configurações do servidor ----------

export function SoundboardSettings({ serverId }: { serverId: string }) {
  const all = useSounds((s) => s.sounds);
  const loaded = useSounds((s) => s.loaded);
  const meId = useLine((s) => s.me?.id);
  const canManage = useLine((s) =>
    hasPerm(permsOf(s, serverId, s.me?.id), Perm.ManageSoundboard),
  );
  const [uploading, setUploading] = useState(false);
  const sounds = useMemo(
    () => all.filter((s) => s.serverId === serverId),
    [all, serverId],
  );

  useEffect(() => {
    void loadSounds(true);
  }, []);

  const remove = async (s: Sound) => {
    if (
      !(await confirmDialog({
        title: "Excluir som",
        message: `"${s.name}" sai do painel de efeitos sonoros de todo mundo.`,
        confirmLabel: "Excluir",
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteSound(serverId, s.id);
      useSounds.setState((st) => ({
        sounds: st.sounds.filter((x) => x.id !== s.id),
      }));
      toast("Som excluído");
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="mb-2 text-xl font-bold">Painel de efeitos sonoros</h2>
      <p className="mb-4 text-sm text-soft">
        Envie sons curtos (até {MAX_SOUND_SECONDS} segundos) que qualquer pessoa
        deste servidor pode tocar nas chamadas de voz. Quem participa de mais de
        um servidor pode usar os sons de todos eles.
      </p>
      <Button
        onClick={() => setUploading(true)}
        disabled={!canManage || sounds.length >= MAX_SOUNDS}
      >
        <Icons.Upload size={16} /> Enviar som
      </Button>
      <div className="my-6 border-t border-edge" />
      <p className="mb-4 text-sm font-semibold">
        {sounds.length} de {MAX_SOUNDS} espaços usados
      </p>
      {!loaded ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : sounds.length === 0 ? (
        <p className="text-sm text-muted">
          Nenhum som ainda. Clique em Enviar som para começar.
        </p>
      ) : (
        <div>
          <div className="grid grid-cols-[56px_1fr_1fr_80px] gap-3 px-2 pb-2 text-xs font-bold text-muted uppercase">
            <span>Emoji</span>
            <span>Nome</span>
            <span>Enviado por</span>
            <span />
          </div>
          {sounds.map((s) => (
            <div
              key={s.id}
              className="group grid grid-cols-[56px_1fr_1fr_80px] items-center gap-3 border-t border-edge px-2 py-3 hover:bg-hover/40"
            >
              <span
                className="text-xl leading-none"
                style={{ fontFamily: EMOJI_FONT }}
              >
                {s.emoji || <Icons.Speaker size={18} className="text-muted" />}
              </span>
              <span className="truncate text-sm">{s.name}</span>
              <span className="flex min-w-0 items-center gap-2 text-sm text-soft">
                {s.user ? (
                  <>
                    <Avatar
                      name={s.user.displayName}
                      color={s.user.avatarColor}
                      src={s.user.avatarUrl}
                      size={22}
                    />
                    <span className="truncate">{s.user.displayName}</span>
                  </>
                ) : (
                  <span className="text-muted">Conta excluída</span>
                )}
              </span>
              <span className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  title="Ouvir"
                  onClick={() => previewSound(s.url, s.volume)}
                  className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg"
                >
                  <Icons.Play size={16} />
                </button>
                {(canManage || s.userId === meId) && (
                  <button
                    title="Excluir"
                    onClick={() => void remove(s)}
                    className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-danger"
                  >
                    <Icons.Trash size={16} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {uploading && (
        <UploadSoundModal
          serverId={serverId}
          onClose={() => setUploading(false)}
        />
      )}
    </div>
  );
}

// ---------- enviar um som ----------

const BARS = 90;

function UploadSoundModal({
  serverId,
  onClose,
}: {
  serverId: string;
  onClose: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [volume, setVolume] = useState(100);
  const [busy, setBusy] = useState(false);
  const [head, setHead] = useState<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const duration = buf?.duration ?? 0;
  const len = range[1] - range[0];

  const pick = async (f: File | undefined) => {
    if (!f) return;
    stopRef.current?.();
    try {
      const b = await decodeFile(f);
      setFile(f);
      setBuf(b);
      setPeaks(waveform(b, BARS));
      setRange([0, Math.min(b.duration, MAX_SOUND_SECONDS)]);
      if (!name) setName(f.name.replace(/\.[^.]+$/, "").slice(0, 32));
    } catch {
      toast(
        "Não deu para ler esse arquivo. Tente um MP3, OGG, WAV ou vídeo MP4.",
        "error",
      );
    }
  };

  const togglePreview = () => {
    if (stopRef.current) return stopRef.current();
    if (!buf) return;
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = volume / 100;
    src.connect(gain).connect(ctx.destination);
    const startedAt = ctx.currentTime;
    src.start(0, range[0], len);
    let raf = 0;
    const tick = () => {
      setHead(range[0] + (ctx.currentTime - startedAt));
      raf = requestAnimationFrame(tick);
    };
    tick();
    const stop = () => {
      cancelAnimationFrame(raf);
      try {
        src.stop();
      } catch {
        /* já parou */
      }
      void ctx.close();
      setHead(null);
      stopRef.current = null;
    };
    src.onended = stop;
    stopRef.current = stop;
  };

  /** Arrasta uma das alças do corte. O trecho nunca passa de 5 s. */
  const drag = (which: 0 | 1) => (e: React.PointerEvent) => {
    e.preventDefault();
    stopRef.current?.();
    const el = wave.current;
    if (!el || !duration) return;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t =
        Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * duration;
      setRange(([a, b]) => {
        if (which === 0) {
          const na = Math.min(Math.max(t, b - MAX_SOUND_SECONDS, 0), b - 0.1);
          return [na, b];
        }
        const nb = Math.max(
          Math.min(t, a + MAX_SOUND_SECONDS, duration),
          a + 0.1,
        );
        return [a, nb];
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const submit = async () => {
    if (!buf || !name.trim() || len > MAX_SOUND_SECONDS + 0.01) return;
    stopRef.current?.();
    setBusy(true);
    try {
      const wav = trimToWav(buf, range[0], range[1]);
      const att = await api.uploadAttachment(
        wav,
        `${name.trim().slice(0, 32) || "som"}.wav`,
      );
      const sound = await api.createSound(serverId, {
        attachmentId: att.id,
        name: name.trim(),
        emoji,
        volume: volume / 100,
      });
      useSounds.setState((s) => ({
        sounds: [sound, ...s.sounds.filter((x) => x.id !== sound.id)],
      }));
      toast("Som enviado");
      onClose();
    } catch (e) {
      showError(e);
      setBusy(false);
    }
  };

  const pct = (t: number) => (duration ? (t / duration) * 100 : 0);
  const label = "mb-2 block text-sm font-semibold";

  return (
    <Modal
      title="Enviar um som"
      onClose={onClose}
      width={460}
      footer={
        <div className="grid w-full grid-cols-2 gap-3">
          <Button variant="subtle" onClick={onClose}>
            Deixa pra lá
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!buf || !name.trim() || busy}
          >
            {busy ? "Enviando…" : "Enviar"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {buf && (
          <div>
            <span className={label}>Prévia</span>
            <div className="flex items-center gap-3 rounded-lg bg-main p-3">
              <div className="flex w-12 shrink-0 flex-col items-center gap-1">
                <button
                  onClick={togglePreview}
                  title={head != null ? "Parar" : "Ouvir o trecho"}
                  className="rounded-full p-1.5 text-fg hover:bg-hover"
                >
                  {head != null ? (
                    <Icons.Pause size={16} />
                  ) : (
                    <Icons.Play size={16} />
                  )}
                </button>
                <span
                  className={cx(
                    "text-[11px] font-semibold",
                    len > MAX_SOUND_SECONDS + 0.01 ? "text-danger" : "text-sun",
                  )}
                >
                  {len.toFixed(2)}s
                </span>
              </div>
              <div ref={wave} className="relative h-16 flex-1 select-none">
                <div className="absolute inset-0 flex items-center gap-px">
                  {peaks.map((p, i) => {
                    const t = ((i + 0.5) / BARS) * duration;
                    const inside = t >= range[0] && t <= range[1];
                    return (
                      <span
                        key={i}
                        className={cx(
                          "flex-1 rounded-full",
                          inside ? "bg-fg" : "bg-edge",
                        )}
                        style={{ height: `${Math.max(6, p * 100)}%` }}
                      />
                    );
                  })}
                </div>
                {head != null && (
                  <span
                    className="absolute inset-y-0 w-0.5 bg-accent"
                    style={{ left: `${pct(head)}%` }}
                  />
                )}
                {([0, 1] as const).map((w) => (
                  <span
                    key={w}
                    onPointerDown={drag(w)}
                    title={w === 0 ? "Início do corte" : "Fim do corte"}
                    className="absolute inset-y-0 -ml-1.5 flex w-3 cursor-ew-resize items-center justify-center"
                    style={{ left: `${pct(range[w])}%` }}
                  >
                    <span className="h-full w-0.5 bg-fg" />
                    <span className="absolute h-4 w-2 rounded-sm bg-fg" />
                  </span>
                ))}
              </div>
            </div>
            {duration > MAX_SOUND_SECONDS && (
              <p className="mt-1.5 text-xs text-muted">
                Arraste as alças para escolher até {MAX_SOUND_SECONDS} segundos.
              </p>
            )}
          </div>
        )}

        <div>
          <span className={label}>
            Arquivo <span className="text-danger">*</span>
          </span>
          <div className="flex items-center gap-2 rounded-lg border border-edge bg-rail py-1.5 pr-1.5 pl-3">
            <Icons.Upload size={16} className="shrink-0 text-muted" />
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-sm",
                !file && "text-muted",
              )}
            >
              {file?.name ?? "Escolha um arquivo"}
            </span>
            <Button
              variant="subtle"
              className="px-3 py-1.5"
              onClick={() => fileInput.current?.click()}
            >
              Navegar
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,video/mp4,video/webm,.mp3,.ogg,.wav,.m4a"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <span className={label}>
              Nome do som <span className="text-danger">*</span>
            </span>
            <Input
              value={name}
              maxLength={32}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nome do som"
            />
          </div>
          <div>
            <span className={label}>Emoji relacionado</span>
            <button
              onClick={(e) => {
                const el = e.currentTarget;
                setEmojiAnchor((a) => (a ? null : el));
              }}
              className="flex h-[38px] w-full items-center gap-2 rounded-lg border border-edge bg-rail px-3 text-left text-sm hover:border-soft"
            >
              {emoji ? (
                <>
                  <span
                    className="text-lg leading-none"
                    style={{ fontFamily: EMOJI_FONT }}
                  >
                    {emoji}
                  </span>
                  <span className="flex-1" />
                  <span
                    role="button"
                    title="Tirar emoji"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEmoji("");
                    }}
                    className="text-muted hover:text-fg"
                  >
                    <Icons.X size={14} />
                  </span>
                </>
              ) : (
                <>
                  <Icons.Smile size={16} className="text-muted" />
                  <span className="text-muted">Clique para selecionar</span>
                </>
              )}
            </button>
            {emojiAnchor && (
              <EmojiPicker
                anchor={emojiAnchor}
                onClose={() => setEmojiAnchor(null)}
                onPick={(em) => {
                  setEmoji(em);
                  setEmojiAnchor(null);
                }}
              />
            )}
          </div>
        </div>

        <div>
          <span className={label}>Volume do som</span>
          <div className="flex items-center gap-3">
            <Slider
              value={volume}
              onChange={setVolume}
              label="Volume do som"
              className="flex-1"
            />
            <span className="w-9 text-right text-xs text-muted">{volume}%</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
