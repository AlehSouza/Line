/** Permissões de servidor (bits). Mesmos valores de `apps/server/src/perms.rs`. */
export const Perm = {
  ViewChannels: 1 << 0,
  ManageChannels: 1 << 1,
  ManageRoles: 1 << 2,
  ManageServer: 1 << 3,
  CreateInvite: 1 << 4,
  KickMembers: 1 << 5,
  ManageMessages: 1 << 6,
  MentionEveryone: 1 << 7,
  SendMessages: 1 << 8,
  AttachFiles: 1 << 9,
  CreateThreads: 1 << 10,
  Connect: 1 << 11,
  Speak: 1 << 12,
  Video: 1 << 13,
  Administrator: 1 << 14,
  ChangeNickname: 1 << 15,
  ManageNicknames: 1 << 16,
  MuteMembers: 1 << 17,
  MoveMembers: 1 << 18,
  AddReactions: 1 << 19,
  PinMessages: 1 << 20,
  UseSoundboard: 1 << 21,
  ManageSoundboard: 1 << 22,
  UseAgent: 1 << 23,
  ManageAgent: 1 << 24,
  Stream: 1 << 25,
  SetVoiceStatus: 1 << 26,
  PostNotes: 1 << 27,
  CreatePolls: 1 << 28,
} as const;

export const ALL_PERMS = (1 << 29) - 1;

/** O que um canal com "quem pode interagir" tira de quem não está na lista (igual ao servidor). */
export const INTERACT_PERMS =
  Perm.SendMessages | Perm.AttachFiles | Perm.CreateThreads | Perm.Speak | Perm.Video | Perm.Stream | Perm.CreatePolls;

export const hasPerm = (perms: number, flag: number) => (perms & flag) === flag;

/** Qual menção geral a mensagem tem: 'todos' (@todos/@everyone) vale mais que 'aqui' (@aqui/@here). */
export function massMention(content: string): 'todos' | 'aqui' | null {
  const words = content.split(/[^\p{L}\p{N}@]+/u);
  if (words.some((w) => w === '@todos' || w === '@everyone')) return 'todos';
  if (words.some((w) => w === '@aqui' || w === '@here')) return 'aqui';
  return null;
}

/** Textos da tela de cargos, agrupados como aparecem. */
export const PERMISSION_GROUPS: { title: string; items: { flag: number; name: string; hint: string }[] }[] = [
  {
    title: 'Permissões gerais do servidor',
    items: [
      { flag: Perm.ViewChannels, name: 'Ver canais', hint: 'Permite que os membros vejam os canais (exceto canais privados).' },
      { flag: Perm.ManageChannels, name: 'Gerenciar canais', hint: 'Permite criar, editar e excluir canais e categorias.' },
      {
        flag: Perm.ManageRoles,
        name: 'Gerenciar cargos',
        hint: 'Permite criar cargos e editar ou excluir os que estão abaixo do seu cargo mais alto, além de dar e tirar esses cargos dos membros.',
      },
      { flag: Perm.ManageServer, name: 'Gerenciar servidor', hint: 'Permite mudar nome, descrição, cor e visibilidade do servidor, gerar um novo código de convite e mostrar ou esconder os canais de Notas e Atualizações.' },
    ],
  },
  {
    title: 'Notas e Atualizações',
    items: [
      {
        flag: Perm.PostNotes,
        name: 'Publicar em Notas e Atualizações',
        hint: 'Permite escrever nos canais Regras, Anúncios e Eventos. Quem não tem só lê e reage.',
      },
    ],
  },
  {
    title: 'Permissões de membros',
    items: [
      { flag: Perm.CreateInvite, name: 'Criar convite', hint: 'Permite ver o código de convite e chamar pessoas novas para o servidor.' },
      { flag: Perm.ChangeNickname, name: 'Alterar apelido', hint: 'Permite que os membros mudem o próprio apelido, um nome que vale só neste servidor.' },
      { flag: Perm.ManageNicknames, name: 'Gerenciar apelidos', hint: 'Permite mudar o apelido de membros com cargos abaixo do seu.' },
      { flag: Perm.KickMembers, name: 'Expulsar membros', hint: 'Permite remover do servidor quem tem cargos abaixo do seu. A pessoa pode voltar com um convite.' },
    ],
  },
  {
    title: 'Permissões de canais de texto',
    items: [
      { flag: Perm.SendMessages, name: 'Enviar mensagens', hint: 'Permite mandar mensagens e enquetes nos canais de texto e responder em conversas.' },
      { flag: Perm.AttachFiles, name: 'Anexar arquivos', hint: 'Permite enviar imagens, vídeos e outros arquivos.' },
      { flag: Perm.CreateThreads, name: 'Criar conversas', hint: 'Permite abrir conversas a partir de mensagens.' },
      { flag: Perm.CreatePolls, name: 'Criar enquetes', hint: 'Permite criar enquetes nos canais de texto.' },
      { flag: Perm.AddReactions, name: 'Adicionar reações', hint: 'Permite reagir com emojis novos. Sem ela, a pessoa só entra nas reações que já estão na mensagem.' },
      { flag: Perm.PinMessages, name: 'Fixar mensagens', hint: 'Permite fixar e desafixar mensagens no canal, com ou sem duração.' },
      {
        flag: Perm.MentionEveryone,
        name: 'Mencionar @todos, @aqui e todos os cargos',
        hint: 'Permite usar @aqui para notificar todos deste chat e @todos para notificar todos do servidor, além de mencionar cargos que não estão marcados como mencionáveis.',
      },
      { flag: Perm.ManageMessages, name: 'Gerenciar mensagens', hint: 'Permite apagar e fixar mensagens de outros membros.' },
    ],
  },
  {
    title: 'Permissões de canais de voz',
    items: [
      { flag: Perm.Connect, name: 'Conectar', hint: 'Permite entrar nos canais de voz.' },
      { flag: Perm.Speak, name: 'Falar', hint: 'Permite falar nos canais de voz. Sem ela, a pessoa entra sempre mutada.' },
      { flag: Perm.Video, name: 'Vídeo', hint: 'Permite ligar a câmera nos canais de voz.' },
      { flag: Perm.Stream, name: 'Transmitir', hint: 'Permite compartilhar a tela, uma janela ou um jogo nos canais de voz.' },
      { flag: Perm.SetVoiceStatus, name: 'Definir status do canal', hint: 'Permite mudar o status que aparece embaixo do nome do canal de voz.' },
      { flag: Perm.UseSoundboard, name: 'Usar efeitos sonoros', hint: 'Permite tocar os sons do painel de efeitos sonoros na chamada.' },
      { flag: Perm.MuteMembers, name: 'Silenciar membros', hint: 'Permite desativar o microfone e o áudio de outras pessoas nos canais de voz.' },
      { flag: Perm.MoveMembers, name: 'Mover membros', hint: 'Permite mover pessoas entre canais de voz e desconectá-las da chamada.' },
    ],
  },
  {
    title: 'Expressões',
    items: [
      { flag: Perm.ManageSoundboard, name: 'Gerenciar efeitos sonoros', hint: 'Permite adicionar, editar e excluir os sons do painel de efeitos sonoros do servidor.' },
    ],
  },
  {
    title: 'Agente',
    items: [
      { flag: Perm.UseAgent, name: 'Usar o agente', hint: 'Permite pedir músicas com /play, usar o /hoje, receber respostas inteligentes e votar no player.' },
      {
        flag: Perm.ManageAgent,
        name: 'Personalizar o agente',
        hint: 'Permite mudar o perfil, o status e as respostas inteligentes do agente e controlar qualquer música sem votação.',
      },
    ],
  },
  {
    title: 'Permissões avançadas',
    items: [
      {
        flag: Perm.Administrator,
        name: 'Administrador',
        hint: 'Quem tem esta permissão pode tudo e vê todos os canais, inclusive os privados. Cuidado ao dar.',
      },
    ],
  },
];
