"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { actions, permsOf, useLine } from "@/lib/store";
import {
  joinVoice,
  moderateVoice,
  setScreenVolume,
  setUserVolume,
  toggleDeafen,
  toggleHiddenScreen,
  toggleHiddenVideo,
  toggleLocalMute,
  toggleMute,
  toggleScreenMute,
  useVoice,
} from "@/lib/voice";
import { cx, Icons } from "./ui";
import { hasPerm, Perm } from "@line/shared";

/** Quem pode silenciar ("Silenciar membros") ou mover/desconectar ("Mover membros") os outros na voz. */
export function useCanModerateVoice(serverId: string | null | undefined) {
  return useLine((s) => {
    if (!serverId) return false;
    const p = permsOf(s, serverId, s.me?.id);
    return hasPerm(p, Perm.MuteMembers) || hasPerm(p, Perm.MoveMembers);
  });
}

/** Insere "@usuario " no campo de mensagem do canal aberto (ou do primeiro canal de texto do servidor). */
function mention(username: string, serverId: string | null) {
  const s = useLine.getState();
  const view = s.view;
  const current =
    view.kind === "server" && view.channelId
      ? s.channels[view.channelId]
      : null;
  if (serverId && (!current || current.type !== "text")) {
    const text = Object.values(s.channels)
      .filter((c) => c.serverId === serverId && c.type === "text")
      .sort((a, b) => a.position - b.position)[0];
    if (text) actions.goServer(serverId, text.id);
  }
  setTimeout(
    () =>
      window.dispatchEvent(
        new CustomEvent("line:mention", { detail: `@${username} ` }),
      ),
    60,
  );
}

export function VoiceUserMenu({
  userId,
  channelId,
  x,
  y,
  onClose,
}: {
  userId: string;
  channelId: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const me = useLine((s) => s.me);
  const user = useLine((s) => s.users[userId]);
  const channel = useLine((s) => s.channels[channelId]);
  const friend = useLine((s) => s.friends[userId]);
  const allChannels = useLine((s) => s.channels);
  const state = useVoice((v) => v.states[userId]);
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const volume = useVoice((v) => v.userVolume[userId] ?? 1);
  const localMuted = useVoice((v) => !!v.localMuted[userId]);
  const hiddenVideo = useVoice((v) => !!v.hiddenVideo[userId]);
  const screenVolume = useVoice((v) => v.screenVolume[userId] ?? 1);
  const screenMuted = useVoice((v) => !!v.screenMuted[userId]);
  const hiddenScreen = useVoice((v) => !!v.hiddenScreen[userId]);
  const serverId = channel?.serverId ?? null;
  const canModerate = useCanModerateVoice(serverId);
  const [moveOpen, setMoveOpen] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!user || !me) return null;
  const isMe = userId === me.id;
  const otherVoice = Object.values(allChannels)
    .filter(
      (c) =>
        c.serverId === serverId && c.type === "voice" && c.id !== channelId,
    )
    .sort((a, b) => a.position - b.position);

  const run =
    (fn: () => unknown | Promise<unknown>, keepOpen = false) =>
    async () => {
      setError("");
      try {
        await fn();
        if (!keepOpen) onClose();
      } catch (e) {
        setError((e as Error).message);
      }
    };

  const openDm = async () => {
    const dm = await api.openDm([userId]);
    actions.upsertChannel(dm);
    actions.goHome(dm.id);
    return dm;
  };

  const moveTo = (to: string) =>
    run(() =>
      isMe
        ? joinVoice(to)
        : moderateVoice({ userId, action: "move", channelId: to }),
    );

  return (
    <div
      ref={ref}
      style={pos}
      className="fixed z-50 w-60 space-y-0.5 rounded-lg border border-edge bg-rail p-1.5 text-sm shadow-2xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item
        onClick={run(() =>
          actions.openModal({
            kind: "user",
            userId,
            at: { x: pos.left, y: pos.top },
          }),
        )}
      >
        Perfil
      </Item>
      <Item onClick={run(() => mention(user.username, serverId))}>
        Mencionar
      </Item>
      {!isMe && (
        <>
          <Item onClick={run(openDm)}>Mensagem</Item>
          <Item
            onClick={run(async () => {
              const dm = await openDm();
              await joinVoice(dm.id);
            })}
          >
            Iniciar chamada
          </Item>
        </>
      )}
      <Sep />

      {isMe ? (
        <>
          <Item onClick={run(toggleMute, true)} check={muted}>
            Silenciar
          </Item>
          <Item onClick={run(toggleDeafen, true)} check={deafened}>
            Desativar áudio
          </Item>
        </>
      ) : (
        <>
          <div className="px-2.5 py-1.5">
            <p className="mb-1.5 font-medium text-soft">Volume do usuário</p>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) =>
                setUserVolume(userId, Number(e.target.value) / 100)
              }
              className="w-full accent-accent"
            />
          </div>
          <Sep />
          <Item
            onClick={run(() => toggleLocalMute(userId), true)}
            check={localMuted}
          >
            Silenciar
          </Item>
          {state?.cameraStreamId && (
            <Item
              onClick={run(() => toggleHiddenVideo(userId), true)}
              check={hiddenVideo}
            >
              Desativar vídeo
            </Item>
          )}
          {state?.screenStreamId && (
            <>
              <Sep />
              <div className="px-2.5 py-1.5">
                <p className="mb-1.5 font-medium text-soft">
                  Volume da transmissão
                </p>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={screenMuted ? 0 : Math.round(screenVolume * 100)}
                  onChange={(e) =>
                    setScreenVolume(userId, Number(e.target.value) / 100)
                  }
                  className="w-full accent-accent"
                />
              </div>
              <Item
                onClick={run(() => toggleScreenMute(userId), true)}
                check={screenMuted}
              >
                Silenciar transmissão
              </Item>
              <Item
                onClick={run(() => toggleHiddenScreen(userId), true)}
                check={hiddenScreen}
              >
                Parar de assistir
              </Item>
            </>
          )}
          {friend?.state !== "friends" && friend?.state !== "blocked" && (
            <Item
              disabled={friend?.state === "outgoing"}
              onClick={run(async () => {
                if (friend?.state === "incoming")
                  await api.acceptFriend(userId);
                else await api.addFriend(user.username);
              })}
            >
              {friend?.state === "incoming"
                ? "Aceitar amizade"
                : friend?.state === "outgoing"
                  ? "Pedido enviado"
                  : "Adicionar amigo"}
            </Item>
          )}
          {friend?.state !== "blocked" && (
            <Item
              danger
              onClick={run(async () => {
                if (confirm(`Bloquear ${user.displayName}?`))
                  await api.blockUser(userId);
              })}
            >
              Bloquear
            </Item>
          )}
        </>
      )}

      {(isMe || canModerate) && otherVoice.length > 0 && (
        <div
          className="relative"
          onMouseEnter={() => setMoveOpen(true)}
          onMouseLeave={() => setMoveOpen(false)}
        >
          <Item onClick={() => setMoveOpen((v) => !v)} arrow>
            Mover para
          </Item>
          {moveOpen && (
            <div className="absolute top-0 left-full z-10 ml-1 max-h-72 w-52 space-y-0.5 overflow-y-auto rounded-lg border border-edge bg-rail p-1.5 shadow-2xl">
              {otherVoice.map((c) => (
                <Item key={c.id} onClick={moveTo(c.id)}>
                  <span className="flex items-center gap-1.5 truncate">
                    <Icons.Speaker size={14} className="shrink-0 opacity-70" />
                    {c.name}
                  </span>
                </Item>
              ))}
            </div>
          )}
        </div>
      )}

      {canModerate && state && (
        <>
          <Sep />
          <Item
            danger
            onClick={run(
              () =>
                moderateVoice({
                  userId,
                  action: "mute",
                  value: !state.serverMuted,
                }),
              true,
            )}
            check={!!state.serverMuted}
          >
            Silenciar voz no servidor
          </Item>
          <Item
            danger
            onClick={run(
              () =>
                moderateVoice({
                  userId,
                  action: "deafen",
                  value: !state.serverDeafened,
                }),
              true,
            )}
            check={!!state.serverDeafened}
          >
            Desativar áudio no servidor
          </Item>
          {!isMe && (
            <Item
              danger
              onClick={run(() =>
                moderateVoice({ userId, action: "disconnect" }),
              )}
            >
              Desconectar
            </Item>
          )}
        </>
      )}

      <Sep />
      <Item onClick={run(() => navigator.clipboard.writeText(userId))}>
        <span className="flex items-center gap-2">
          <Icons.Copy size={14} /> Copiar ID do usuário
        </span>
      </Item>
      {error && <p className="px-2.5 py-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

function Sep() {
  return <div className="mx-1.5 my-1 border-t border-edge" />;
}

function Item({
  children,
  onClick,
  check,
  danger,
  arrow,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  check?: boolean;
  danger?: boolean;
  arrow?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-medium disabled:opacity-50",
        danger
          ? "text-danger hover:bg-danger hover:text-white"
          : "text-soft hover:bg-accent hover:text-on-accent",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {check !== undefined && (
        <span
          className={cx(
            "flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border",
            check
              ? "border-accent bg-accent text-on-accent"
              : "border-current opacity-60",
          )}
        >
          {check && <Icons.Check size={12} />}
        </span>
      )}
      {arrow && <Icons.Chevron size={14} className="-rotate-90" />}
    </button>
  );
}
