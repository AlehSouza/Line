import type { ReactNode } from 'react';

/**
 * Markdown simples e seguro (sem HTML cru):
 * ```bloco```, `código`, **negrito**, *itálico*, __sublinhado__, ~~riscado~~, links e @menções.
 */
export function renderMarkdown(text: string, myUsername?: string): ReactNode[] {
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
      out.push(...inline(part, `p${i}`, myUsername));
    }
  });
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])|(@[a-z0-9_.]{2,32})/g;

function inline(text: string, key: string, me?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    const tok = m[0];
    const k = `${key}-${n++}`;
    if (m[1]) nodes.push(<code key={k} className="rounded bg-rail px-1 py-0.5 font-mono text-[13px]">{tok.slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={k}>{inline(tok.slice(2, -2), k, me)}</strong>);
    else if (m[3]) nodes.push(<u key={k}>{inline(tok.slice(2, -2), k, me)}</u>);
    else if (m[4]) nodes.push(<s key={k}>{inline(tok.slice(2, -2), k, me)}</s>);
    else if (m[5]) nodes.push(<em key={k}>{inline(tok.slice(1, -1), k, me)}</em>);
    else if (m[6])
      nodes.push(
        <a key={k} href={tok} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          {tok}
        </a>,
      );
    else if (m[7]) nodes.push(<span key={k} className={tok.slice(1) === me ? 'mention' : 'font-semibold text-accent'}>{tok}</span>);
    last = idx + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
