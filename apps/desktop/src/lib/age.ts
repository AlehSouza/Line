/** Idade em anos completos a partir de AAAA-MM-DD (null sem data). */
export function ageOf(birthDate: string | null | undefined, today = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let age = today.getFullYear() - y;
  const month = today.getMonth() + 1;
  if (month < mo || (month === mo && today.getDate() < d)) age--;
  return age;
}

export const isAdult = (birthDate: string | null | undefined) => (ageOf(birthDate) ?? 0) >= 18;
