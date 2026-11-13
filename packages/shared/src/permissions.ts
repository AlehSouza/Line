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
} as const;

export const ALL_PERMS = (1 << 19) - 1;

export const hasPerm = (perms: number, flag: number) => (perms & flag) === flag;

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
      { flag: Perm.ManageServer, name: 'Gerenciar servidor', hint: 'Permite mudar nome, descrição, cor e visibilidade do servidor e gerar um novo código de convite.' },
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
      { flag: Perm.SendMessages, name: 'Enviar mensagens', hint: 'Permite mandar mensagens e enquetes nos canais de texto e responder em threads.' },
      { flag: Perm.AttachFiles, name: 'Anexar arquivos', hint: 'Permite enviar imagens, vídeos e outros arquivos.' },
      { flag: Perm.CreateThreads, name: 'Criar threads', hint: 'Permite abrir threads a partir de mensagens.' },
      {
        flag: Perm.MentionEveryone,
        name: 'Mencionar @everyone, @here e todos os cargos',
        hint: 'Permite usar @everyone e @here para avisar todo mundo, e mencionar cargos que não estão marcados como mencionáveis.',
      },
      { flag: Perm.ManageMessages, name: 'Gerenciar mensagens', hint: 'Permite apagar mensagens de outros membros.' },
    ],
  },
  {
    title: 'Permissões de canais de voz',
    items: [
      { flag: Perm.Connect, name: 'Conectar', hint: 'Permite entrar nos canais de voz.' },
      { flag: Perm.Speak, name: 'Falar', hint: 'Permite falar nos canais de voz. Sem ela, a pessoa entra sempre mutada.' },
      { flag: Perm.Video, name: 'Vídeo', hint: 'Permite ligar a câmera e compartilhar a tela nos canais de voz.' },
      { flag: Perm.MuteMembers, name: 'Silenciar membros', hint: 'Permite desativar o microfone e o áudio de outras pessoas nos canais de voz.' },
      { flag: Perm.MoveMembers, name: 'Mover membros', hint: 'Permite mover pessoas entre canais de voz e desconectá-las da chamada.' },
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
