/** Links de convite: https://useline.tech/app/?convite=CODIGO (também aceita /convite/CODIGO). */
export const INVITE_BASE = 'https://useline.tech/app/?convite=';

export function inviteLink(code: string) {
  return INVITE_BASE + encodeURIComponent(code);
}

/** Código de um link de convite do Line; null se não for um. */
export function inviteCodeFromUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hostname.replace(/^www\./, '') !== 'useline.tech') return null;
  const q = u.searchParams.get('convite');
  if (q) return /^[\w-]{3,40}$/.test(q) ? q : null;
  const m = u.pathname.match(/^\/(?:app\/)?convite\/([\w-]{3,40})\/?$/);
  return m ? m[1] : null;
}

/** Aceita o código puro ou qualquer link de convite. */
export function inviteCodeFromText(text: string): string {
  const t = text.trim();
  return inviteCodeFromUrl(t) ?? t.replace(/[/?#]+$/, '').split(/[/?#=]/).pop() ?? '';
}
