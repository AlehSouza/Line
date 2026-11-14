import type { ReactNode } from 'react';
import type { MentionContext } from '@/components/Mentions';
import { UserMention } from '@/components/UserCard';

/**
 * Markdown simples e seguro (sem HTML cru):
 * ```bloco```, `código`, **negrito**, *itálico*, __sublinhado__, ~~riscado~~, links e @menções.
 */
export function renderMarkdown(text: string, myUsername?: string, ctx?: MentionContext): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(/```(?:[a-zA-Z0-9]+\n)?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(
        <pre key={`b${i}`} className="my-1 overflow-x-auto rounded-lg border border-edge bg-rail p-3 font-mono text-[13px]">
          {part.replace(/\n$/, '')}
        </pre>,
      );
    } else if (part) {
      out.push(...inline(part, `p${i}`, myUsername, ctx));
    }
  });
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|(@[a-z0-9_.]{2,32})|(<@&[\w-]+>)/g;

function inline(text: string, key: string, me?: string, ctx?: MentionContext): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) nodes.push(<code key={k} className="rounded bg-rail px-1 py-0.5 font-mono text-[13px]">{tok.slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={k}>{inline(tok.slice(2, -2), k, me, ctx)}</strong>);
    else if (m[3]) nodes.push(<u key={k}>{inline(tok.slice(2, -2), k, me, ctx)}</u>);
    else if (m[4]) nodes.push(<s key={k}>{inline(tok.slice(2, -2), k, me, ctx)}</s>);
    else if (m[5]) nodes.push(<em key={k}>{inline(tok.slice(1, -1), k, me, ctx)}</em>);
    else if (m[6])
      nodes.push(
        <a key={k} href={tok} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          {tok}
        </a>,
      );
    else if (m[7]) {
      const special = tok === '@everyone' || tok === '@here';
      const cls = tok.slice(1) === me || special ? 'mention' : 'font-semibold text-accent';
      nodes.push(
        special ? (
          <span key={k} className={cls}>
            {tok}
          </span>
        ) : (
          <UserMention key={k} username={tok.slice(1)} className={cls}>
            {tok}
          </UserMention>
        ),
      );
    } else if (m[8]) {
      const role = ctx?.roles.find((r) => r.id === tok.slice(3, -1));
      if (!role) nodes.push(<span key={k} className="font-semibold text-muted">@cargo-excluído</span>);
      else {
        const color = role.color ?? '#9b8cff';
        nodes.push(
          <span
            key={k}
            className="rounded px-0.5 font-semibold"
            style={{ color, backgroundColor: `${color}26` }}
          >
            @{role.name}
          </span>,
        );
      }
    }
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
