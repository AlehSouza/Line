/**
 * Recursos de mensagem que esta versão do app sabe mostrar.
 *
 * Quando um recurso novo precisar de app novo para aparecer (ex.: player de áudio), o app que
 * envia manda `requires: ['audio']` na mensagem e o recurso entra nesta lista. Apps mais antigos,
 * que não têm o nome aqui, mostram "Você precisa atualizar o seu aplicativo para interagir com isso"
 * no lugar do conteúdo. O servidor marca sozinho as enquetes com "poll".
 */
export const CLIENT_FEATURES: readonly string[] = ['poll', 'audio', 'music'];

/** Recursos que a mensagem pede e este app não conhece (vazio = dá para mostrar). */
export function missingFeatures(requires: readonly string[] | undefined): string[] {
  return (requires ?? []).filter((f) => !CLIENT_FEATURES.includes(f));
}
