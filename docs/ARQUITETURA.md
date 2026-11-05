# Arquitetura e roadmap do Line

## Visão geral

```
┌──────────────────────────────┐          ┌────────────────────────────────┐
│  App desktop (Electron)      │          │  Servidor Line (Node.js)        │
│                              │  HTTPS   │                                │
│  Next.js + React + Zustand ──┼── REST ──┼─► Fastify (rotas /api)          │
│                              │          │                                │
│  socket.io-client ───────────┼── WS ────┼─► Socket.IO (gateway)           │
│                              │          │      salas user:<id> e         │
│  WebRTC (fase 2) ◄───────────┼─ P2P/SFU ┤      server:<id>               │
│                              │          │                                │
│  preload: notificações,      │          │  SQLite (better-sqlite3)       │
│  badge, piscar na barra      │          │  arquivos em DATA_DIR          │
└──────────────────────────────┘          └────────────────────────────────┘
```

### Por que essas escolhas

| Peça | Escolha | Motivo |
| --- | --- | --- |
| App | Electron + Next.js (export estático) | Você queria JS/TS em tudo; o Next gera HTML/JS estático que o Electron serve pelo protocolo `app://`, sem servidor Node dentro do app. |
| Estado da interface | Zustand | Simples, sem boilerplate, ótimo para muitos eventos em tempo real. |
| API | Fastify | Rápido, tipado, plugins para upload/rate limit quando precisarmos. |
| Tempo real | Socket.IO sobre WebSocket | Reconexão automática, salas e acks prontos. Também serve de sinalização para o WebRTC. |
| Banco | SQLite (better-sqlite3) | Uso pessoal: zero configuração, um arquivo, backup = copiar a pasta. Tem busca full-text (FTS5) embutida para a fase 3. Se um dia crescer, as consultas ficam todas em `store.ts` e dá para migrar para Postgres. |
| Senhas | scrypt (nativo do Node) | Sem dependência nativa extra. |
| Sessão | JWT (HS256, 30 dias) | Funciona igual para REST e WebSocket. |
| Voz/vídeo/tela | WebRTC | Padrão dos navegadores; o Electron já tem tudo, inclusive captura de tela com `desktopCapturer`. |

### Fluxo de uma mensagem

1. O app faz `POST /api/channels/:id/messages`.
2. O servidor valida (zod), confere acesso, grava no SQLite.
3. O gateway emite `message:create` para a sala `server:<id>` (canal de servidor) ou para as salas `user:<id>` de cada participante (DM).
4. Cada app conectado atualiza o estado; quem não está olhando o canal ganha "não lido" e, se for DM ou menção, notificação do Windows.

### Presença

O servidor guarda em memória quantas conexões cada usuário tem e quais estão ociosas. A presença que os outros veem combina conexões (nenhuma = offline), o status escolhido (invisível aparece offline, ocupado = não perturbe) e inatividade (todas as janelas paradas há 5 minutos = ausente). Mudanças vão para quem tem servidor, DM ou amizade em comum.

## Roadmap

As 24 funcionalidades da lista original, agrupadas por fase. Cada fase vira um PR (ou alguns).

### Fase 1: fundação ✅ (este PR)

- Monorepo, app Electron + Next, servidor, pacote de tipos compartilhados
- (1) Servidores públicos/privados, convites, explorar
- (2) Canais de texto e categorias
- (6) Mensagens privadas 1:1 e em grupo
- (13) Sistema de amizades
- (14) Status: online, ausente, ocupado, invisível
- (20) Perfil básico: nome de exibição, bio, cor do avatar, status personalizado
- Base de (17) notificações: DMs e menções geram notificação do Windows; "não perturbe" silencia

### Fase 2: mídia e voz

- (15) Envio de arquivos: imagens, vídeos e documentos, com prévia (upload para `DATA_DIR/uploads`)
- (11) Reações com emoji e seletor de emojis
- (3) Canais de voz com WebRTC: no começo em malha (cada um conecta com cada um, bom para até ~6 pessoas), sinalização pelo Socket.IO, com mudo, ensurdecer, indicador de quem está falando e push-to-talk pelo Electron
- (4) Chamadas de vídeo em DMs e canais de voz
- (5) e (22) Compartilhamento de tela e transmissão de jogos/apps com `desktopCapturer` do Electron (com áudio do sistema no Windows)
- Servidor TURN opcional (coturn) para quem estiver atrás de NAT difícil
- Para salas grandes: trocar a malha por um SFU auto-hospedado (LiveKit ou mediasoup) sem mudar a interface

### Fase 3: organização e controle

- (9) Cargos e permissões: cargos com cor e posição, permissões em bits (ver canal, enviar, gerenciar mensagens, expulsar, banir…) e sobrescritas por canal/categoria
- (8) Threads dentro de canais
- (7) Canais de fórum: publicações com título, tags e respostas
- (16) Busca de mensagens com SQLite FTS5 (filtros por autor, canal, data, "tem arquivo")
- (17) Notificações personalizadas por servidor e canal (tudo, só menções, nada; silenciar por um tempo)
- (20) Perfil completo: foto de avatar, banner, cores do perfil
- (11) Emojis personalizados por servidor, figurinhas e busca de GIFs (Tenor/Giphy com sua chave)
- Respostas a mensagens, mensagens fixadas, edição de apelido por servidor

### Fase 4: comunidade e automação

- (10) Bots: contas de bot com token, o mesmo gateway WebSocket e um SDK em TypeScript (`@line/bot`) para você escrever bots de moderação, jogos e integrações
- Webhooks de entrada por canal
- (18) Moderação: AutoMod (palavras bloqueadas, links, spam, menções em massa), banimentos, silenciar temporariamente, bloquear usuários, denúncias
- (12) Eventos agendados com RSVP e lembrete
- (21) Onboarding: tela de boas-vindas, regras e escolha de interesses que dá cargos automaticamente
- (19) Integrações: GitHub (webhooks de push/PR/issue), Twitch (avisar quando entrar ao vivo), YouTube (novos vídeos), via bots oficiais do Line
- (23) Aplicativos integrados: atividades em `webview` isolado dentro dos canais de voz (jogos, quadro branco, assistir junto)
- (24) Personalização: temas (claro/escuro/personalizado com os tokens de cor), tamanho de fonte, modo compacto, atalhos de teclado, iniciar com o Windows, minimizar para a bandeja, atualização automática (electron-updater)
