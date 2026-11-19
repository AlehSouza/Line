/** Horário de mensagem: hoje "11:13", ontem "Ontem às 11:13", antes "12/03/2026 14:37". */
export function formatMessageTime(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return time;
  if (d.toDateString() === yesterday.toDateString()) return `Ontem às ${time}`;
  return `${d.toLocaleDateString('pt-BR')} ${time}`;
}
