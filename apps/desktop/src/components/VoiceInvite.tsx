"use client";

import { mobile } from "@/lib/mobile";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { ensureServerLoaded } from "@/lib/session";
import { actions, useLine } from "@/lib/store";
import {
  joinVoice,
  participants,
  setChannelStatus,
  useVoice,
} from "@/lib/voice";
import { Avatar, Button, cx, ErrorText, Icons, Input, Modal } from "./ui";

// ---------- formato da mensagem de convite ----------
// A DM leva um marcador que o app transforma num cartão do canal de voz:
//   [[voz:<servidor>:<canal>:<código de convite>]] <nome do canal>

const INVITE_RE = /^\[\[voz:([\w-]+):([\w-]+):([\w-]+)\]\]\s?([^\n]*)$/;

export interface VoiceInviteData {
  serverId: string;
  channelId: string;
  code: string;
  name: string;
}

export function voiceInviteContent(d: VoiceInviteData): string {
  return `[[voz:${d.serverId}:${d.channelId}:${d.code}]] ${d.name}`;
}

export function voiceInviteFromContent(
  content: string,
): VoiceInviteData | null {
  const m = INVITE_RE.exec(content.trim());
  return m
    ? { serverId: m[1]!, channelId: m[2]!, code: m[3]!, name: m[4] ?? "" }
    : null;
}

// ---------- tempo de chamada ----------

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Há quanto tempo a chamada do canal começou (quem entrou primeiro). */
export function CallTimer({
  channelId,
  className,
}: {
  channelId: string;
  className?: string;
}) {
  const states = useVoice((v) => v.states);
  const list = participants(states, channelId);
  const since = list[0]?.joinedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  return (
    <span
      className={cx("font-mono text-xs text-online tabular-nums", className)}
    >
      {formatElapsed(now - new Date(since).getTime())}
    </span>
  );
}

// ---------- item "Convidar para voz" na barra lateral ----------

export function InviteToVoiceItem({
  serverId,
  channelId,
}: {
  serverId: string;
  channelId: string;
}) {
  return (
    <button
      onClick={() =>
        actions.openModal({ kind: "voice-invite", serverId, channelId })
      }
      className="group/inv flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 text-left text-sm text-muted hover:bg-hover hover:text-soft"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raise">
        <Icons.UserPlus size={14} />
      </span>
      <span className="flex-1 truncate">Convidar para voz</span>
      <Icons.Chevron
        size={14}
        className="-rotate-90 opacity-60 group-hover/inv:opacity-100"
      />
    </button>
  );
}

// ---------- modal "Convidar amigos para <servidor>" ----------

export function VoiceInviteModal({
  serverId,
  channelId,
  onClose,
}: {
  serverId: string;
  channelId: string;
  onClose: () => void;
}) {
  const server = useLine((s) => s.servers[serverId]);
  const channel = useLine((s) => s.channels[channelId]);
  const meId = useLine((s) => s.me?.id);
  const friends = useLine((s) => s.friends);
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<Record<string, "sending" | "sent">>({});
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const people = useMemo(() => {
    const friendIds = Object.values(friends)
      .filter((f) => f.state === "friends")
      .map((f) => f.user.id);
    const memberIds = Object.keys(members ?? {});
    const seen = new Set<string>();
    const list: { id: string; isFriend: boolean }[] = [];
    for (const id of [...friendIds, ...memberIds]) {
      if (id === meId || seen.has(id) || (!users[id] && !friends[id])) continue;
      seen.add(id);
      list.push({ id, isFriend: friendIds.includes(id) });
    }
    return list;
  }, [friends, members, users, meId]);

  if (!server || !channel) return null;

  const q = query.trim().toLowerCase().replace(/^@/, "");
  const shown = people.filter(({ id }) => {
    const u = users[id] ?? friends[id]?.user;
    return (
      !q ||
      u!.displayName.toLowerCase().includes(q) ||
      u!.username.toLowerCase().includes(q)
    );
  });

  const invite = async (userId: string) => {
    setError("");
    setSent((s) => ({ ...s, [userId]: "sending" }));
    try {
      const dm = await api.openDm([userId]);
      actions.upsertChannel(dm);
      await api.sendMessage(
        dm.id,
        voiceInviteContent({
          serverId,
          channelId,
          code: server.inviteCode,
          name: channel.name,
        }),
      );
      setSent((s) => ({ ...s, [userId]: "sent" }));
    } catch (e) {
      setSent(({ [userId]: _, ...rest }) => rest);
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={`Convidar amigos para ${server.name}`}
      subtitle={`Os convidados vão cair direto em 🔊 ${channel.name}`}
      onClose={onClose}
      width={480}
    >
      <div className="space-y-3">
        <div className="relative">
          <Icons.Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar amigos"
            className="pl-9"
          />
        </div>
        <p className="text-xs font-semibold text-muted">
          Amigos e membros do servidor
        </p>
        <div className="-mx-2 max-h-[38vh] space-y-0.5 overflow-y-auto">
          {shown.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted">Ninguém encontrado.</p>
          )}
          {shown.map(({ id }) => {
            const u = users[id] ?? friends[id]!.user;
            const st = sent[id];
            return (
              <div
                key={id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover"
              >
                <Avatar
                  name={u.displayName}
                  color={u.avatarColor}
                  src={u.avatarUrl}
                  size={34}
                  presence={u.presence}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {u.displayName}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {u.username}
                  </span>
                </span>
                <button
                  disabled={!!st}
                  onClick={() => void invite(id)}
                  className={cx(
                    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                    st === "sent"
                      ? "border-transparent text-online"
                      : "border-edge bg-raise text-fg hover:border-accent hover:bg-accent hover:text-on-accent disabled:opacity-60",
                  )}
                >
                  {st === "sent"
                    ? "Enviado"
                    : st === "sending"
                      ? "Enviando…"
                      : "Convidar"}
                </button>
              </div>
            );
          })}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="space-y-2 border-t border-edge pt-4">
          <p className="text-sm font-semibold">
            Ou mande o código de convite do servidor
          </p>
          <div className="flex gap-2 rounded-lg border border-edge bg-rail p-1.5">
            <Input
              readOnly
              value={server.inviteCode}
              className="border-0 bg-transparent font-mono"
            />
            <Button
              onClick={async () => {
                await navigator.clipboard
                  .writeText(server.inviteCode)
                  .catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copiado!" : "Copiar"}
            </Button>
          </div>
          <p className="text-xs text-muted">
            A pessoa usa em “Entrar em um servidor”.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------- cartão do convite na DM ----------

export function VoiceInviteCard({ invite }: { invite: VoiceInviteData }) {
  const isMember = useLine((s) => !!s.servers[invite.serverId]);
  const channel = useLine((s) => s.channels[invite.channelId]);
  const users = useLine((s) => s.users);
  const states = useVoice((v) => v.states);
  const myChannel = useVoice((v) => v.channelId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const list = participants(states, invite.channelId);
  const name = channel?.name ?? invite.name;
  const inCall = myChannel === invite.channelId;

  const join = async () => {
    setBusy(true);
    setError("");
    try {
      if (!useLine.getState().servers[invite.serverId]) {
        actions.upsertServer(await api.acceptInvite(invite.code));
      }
      await ensureServerLoaded(invite.serverId, !isMember);
      if (!useLine.getState().channels[invite.channelId])
        throw new Error("Esse canal de voz não existe mais.");
      actions.goServer(invite.serverId, invite.channelId);
      mobile.showMain();
      await joinVoice(invite.channelId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 max-w-sm">
      <div className="overflow-hidden rounded-xl border border-edge bg-side">
        <div className="flex items-center gap-2.5 bg-raise px-4 py-3">
          <Icons.Speaker
            size={18}
            className={list.length ? "shrink-0 text-online" : "shrink-0 text-muted"}
          />
          <span className="min-w-0 flex-1 truncate font-semibold text-fg">
            {name}
          </span>
          <CallTimer channelId={invite.channelId} className="text-sm" />
        </div>
        <div className="space-y-3 px-4 py-3">
          {isMember &&
            (list.length ? (
              <ul className="space-y-2">
                {list.map((p) => {
                  const u = users[p.userId];
                  return (
                    <li
                      key={p.userId}
                      className="flex min-w-0 items-center gap-2 text-sm text-soft"
                    >
                      <Avatar
                        name={u?.displayName ?? "?"}
                        color={u?.avatarColor ?? "#3a3a42"}
                        src={u?.avatarUrl}
                        size={24}
                      />
                      <span className="truncate">
                        {u?.displayName ?? "Alguém"}
                      </span>
                      {u?.username && (
                        <span className="shrink-0 rounded bg-raise px-1.5 py-px text-[11px] font-semibold text-muted">
                          @{u.username}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted">Ninguém na chamada agora.</p>
            ))}
          <button
            disabled={busy || inCall}
            onClick={() => void join()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-online py-2.5 font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
          >
            <Icons.Speaker size={18} />
            {inCall
              ? "Você está nessa chamada"
              : busy
                ? "Entrando…"
                : "Entrar na chamada de voz"}
          </button>
        </div>
      </div>
      <p className="mt-1 flex items-center gap-1 text-xs text-muted">
        <Icons.EyeOff size={12} /> Apenas membros do servidor podem ver quem
        está em um canal de voz
      </p>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

// ---------- status temporário do canal de voz ----------

/** Linha embaixo do canal: mostra o status; quem está na chamada pode definir/editar. */
export function VoiceStatusLine({ channelId }: { channelId: string }) {
  const status = useVoice((v) => v.channelStatus[channelId]);
  const inChannel = useVoice((v) => v.channelId === channelId);
  if (!status && !inChannel) return null;
  const open = () => actions.openModal({ kind: "voice-status", channelId });
  return (
    <button
      disabled={!inChannel}
      onClick={open}
      title={inChannel ? "Definir um status do canal" : undefined}
      className="group/st flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-muted enabled:hover:text-soft"
    >
      <span className={cx("truncate", status && "text-soft")}>
        {status || "Definir um status do canal"}
      </span>
      {inChannel && (
        <Icons.Edit
          size={12}
          className="shrink-0 opacity-70 group-hover/st:opacity-100"
        />
      )}
    </button>
  );
}

export function VoiceStatusModal({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const channel = useLine((s) => s.channels[channelId]);
  const current = useVoice((v) => v.channelStatus[channelId] ?? "");
  const inChannel = useVoice((v) => v.channelId === channelId);
  const [value, setValue] = useState(current);
  if (!channel) return null;

  const save = () => {
    setChannelStatus(channelId, value);
    onClose();
  };

  return (
    <Modal
      title="Sobre o que é a conversa?"
      subtitle="Conte pra galera o que está rolando no canal de voz. O status some quando todo mundo sair."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!inChannel} onClick={save}>
            Definir status
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (inChannel) save();
        }}
        className="space-y-2"
      >
        <label className="block text-sm font-semibold">Status</label>
        <Input
          autoFocus
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Status para ${channel.name}`}
        />
        {!inChannel && (
          <p className="text-xs text-muted">
            Entre no canal para definir o status.
          </p>
        )}
      </form>
    </Modal>
  );
}
