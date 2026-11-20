/**
 * Novidades: o que mudou no Line, escrito para quem usa.
 *
 * Como acrescentar uma nota (todo commit que muda algo visível ao usuário):
 * - Coloque a nota nova NO TOPO da lista (a mais nova primeiro). O `id` é a data
 *   (AAAA-MM-DD); ele liga a nota aos comentários e reações, então nunca mude o id
 *   de uma nota publicada.
 * - Se já existe uma nota com a data de hoje, só acrescente tópicos nela.
 * - Cada tópico tem um título curto e um texto de uma ou duas frases.
 * - Fale do que muda na experiência, sem detalhes técnicos: nada de nomes de
 *   bibliotecas, bancos, serviços, arquivos ou protocolos.
 *   Ruim: "trocamos o banco de dados que guarda suas fotos por um serviço externo".
 *   Bom: "A forma como suas fotos são salvas ganhou uma nova estrutura, pensando
 *   na qualidade e na agilidade do seu dia a dia."
 * - Use "Conversa", nunca "Thread". Português do Brasil.
 */

/** Ícones disponíveis para os tópicos (veja ICONS em components/PatchNotes.tsx). */
export type PatchIcon =
  | 'mic'
  | 'headphones'
  | 'mouse'
  | 'eye'
  | 'pause'
  | 'image'
  | 'volume'
  | 'window'
  | 'zap'
  | 'clock'
  | 'monitor'
  | 'refresh'
  | 'sparkles'
  | 'message'
  | 'shield'
  | 'wrench';

export type PatchTopic = { icon: PatchIcon; title: string; text: string };

export type PatchNote = {
  /** Data da versão, AAAA-MM-DD. Também é o id usado nos comentários e reações. */
  id: string;
  /** Título da versão. */
  title: string;
  /** Frase de abertura. */
  intro: string;
  /** Destaques: aparecem grandes, em cartões. */
  highlights: PatchTopic[];
  /** Melhorias no dia a dia. */
  improvements?: PatchTopic[];
  /** O que foi corrigido. */
  fixes?: PatchTopic[];
};

export const PATCH_NOTES: PatchNote[] = [
  {
    id: '2026-11-20',
    title: 'Voz mais limpa e chamadas do seu jeito',
    intro: 'Esta atualização deixa suas chamadas mais claras, mais leves e muito mais fáceis de ajustar. Também chegou esta página, para você acompanhar tudo o que muda no Line.',
    highlights: [
      {
        icon: 'mic',
        title: 'Supressão de ruído em três níveis',
        text: 'Escolha entre Máximo, Equilibrado e Leve e deixe barulho de teclado, ventilador e rua de fora da conversa. Fica em Configurações → Voz e vídeo.',
      },
      {
        icon: 'headphones',
        title: 'Teste do microfone com retorno',
        text: 'Escute a sua própria voz antes de entrar na chamada e confira como os outros vão te ouvir.',
      },
      {
        icon: 'monitor',
        title: 'Transmissão de tela mais estável',
        text: 'Quando a internet aperta, a imagem agora se ajusta em vez de travar, e quem assiste de longe ganha mais folga para a imagem chegar inteira. Com várias pessoas assistindo, a qualidade se equilibra entre todas.',
      },
      {
        icon: 'eye',
        title: 'Veja a qualidade real da transmissão',
        text: 'Passe o mouse na tela transmitida e clique no ícone de sinal para ver a resolução, a fluidez e a estabilidade da conexão de verdade.',
      },
      {
        icon: 'sparkles',
        title: 'Página de Novidades',
        text: 'Um lugar para ver o que há de novo, reagir e comentar. Sempre que o Line mudar, a novidade aparece aqui.',
      },
    ],
    improvements: [
      {
        icon: 'mic',
        title: 'Voz mais firme em internet instável',
        text: 'A sua voz chega inteira mesmo quando a conexão perde um pedacinho, sem picotar.',
      },
      {
        icon: 'shield',
        title: 'Chamadas em redes mais fechadas',
        text: 'Ficou mais fácil entrar em chamadas em redes de empresa, faculdade e outras que bloqueiam conexões.',
      },
      {
        icon: 'mouse',
        title: 'A chamada do seu jeito',
        text: 'Clique com o botão direito na chamada para mostrar ou esconder participantes sem vídeo, a sua câmera e a sua própria transmissão.',
      },
      {
        icon: 'monitor',
        title: 'Transmissões organizadas',
        text: 'As telas que você não está assistindo ficam fora da grade, sem ocupar espaço, e voltam com um clique.',
      },
      {
        icon: 'eye',
        title: 'Saiba quem está assistindo',
        text: 'Um indicador no canto da transmissão mostra quem está acompanhando a sua tela.',
      },
      {
        icon: 'pause',
        title: 'Transmissão pausada com aviso',
        text: 'Quando uma transmissão pausa, quem assiste vê um aviso claro em vez de uma imagem congelada.',
      },
      {
        icon: 'image',
        title: 'Sua foto do servidor na chamada',
        text: 'Na chamada e na lista do canal de voz aparece a foto que cada pessoa usa naquele servidor.',
      },
      {
        icon: 'volume',
        title: 'Seus outros apps no volume certo',
        text: 'No Windows, entrar numa chamada não abaixa mais o som da música, do jogo ou do vídeo que você está curtindo.',
      },
      {
        icon: 'window',
        title: 'Volta de onde parou',
        text: 'Ao abrir o app você começa no Início com a janela maximizada. Ao recarregar ou atualizar, volta para a mesma conversa.',
      },
      {
        icon: 'zap',
        title: 'Atalho para o canal de voz',
        text: 'Clicar num canal de voz em Ativo agora leva você direto para o servidor e o canal.',
      },
      {
        icon: 'clock',
        title: 'Horários mais naturais',
        text: 'Mensagens de hoje mostram só a hora, as de ontem mostram "Ontem às" e as mais antigas, a data completa.',
      },
    ],
    fixes: [
      {
        icon: 'image',
        title: 'Fotos de perfil não somem mais',
        text: 'A foto e a capa que você escolhe para um servidor agora ficam guardadas de vez. Se a sua sumiu nos últimos dias, é só escolher de novo que ela fica.',
      },
      {
        icon: 'refresh',
        title: 'Transmissão estável',
        text: 'Sair e voltar a assistir não quebra mais a imagem, e depois de recarregar a tela que você assistia volta sozinha.',
      },
      {
        icon: 'shield',
        title: 'Atualizações sem travar',
        text: 'O app não fica mais travado depois de uma atualização.',
      },
      {
        icon: 'image',
        title: 'Fundo da chamada no lugar',
        text: 'A imagem de fundo da chamada não some mais.',
      },
      {
        icon: 'wrench',
        title: 'Pequenos ajustes',
        text: 'O menu de imagem do perfil fecha ao escolher Alterar avatar ou Mudar faixa, e a barra de ações não cobre mais o texto das mensagens.',
      },
    ],
  },
];

const SEEN_KEY = 'line.novidades.vista';

/** A nota mais nova ainda não foi aberta neste aparelho? (bolinha "Novo" na barra lateral) */
export function hasUnseenPatchNote(): boolean {
  const latest = PATCH_NOTES[0]?.id;
  if (!latest) return false;
  try {
    return localStorage.getItem(SEEN_KEY) !== latest;
  } catch {
    return false;
  }
}

export function markPatchNotesSeen() {
  const latest = PATCH_NOTES[0]?.id;
  if (!latest) return;
  try {
    localStorage.setItem(SEEN_KEY, latest);
  } catch {
    /* sem armazenamento: a bolinha volta na próxima vez */
  }
}
