# Line

App de chat e comunidades para desktop (Windows), feito para uso pessoal com a sua galera: servidores, canais, mensagens privadas, amigos e status, tudo liberado e sem assinatura.

Feito com **Electron + Next.js + TypeScript** no app, e **Node.js (Fastify + Socket.IO + SQLite)** no servidor que você mesmo hospeda.

## O que já funciona (fase 1)

- Cadastro e login com nome de usuário e senha
- Servidores públicos ou privados, convite por código, explorar servidores públicos
- Categorias e canais de texto (canais de voz já aparecem; o áudio chega na fase 2)
- Mensagens em tempo real com edição, exclusão, markdown (`**negrito**`, `*itálico*`, `` `código` ``, blocos, links) e @menções
- Mensagens privadas 1:1 e em grupo
- Amigos: pedidos, aceitar, recusar, desfazer
- Status: disponível, ausente (automático após 5 min parado), não perturbe e invisível, mais status personalizado
- Indicador de "digitando…", mensagens não lidas, notificações do Windows para DMs e menções
- Perfil com nome de exibição, bio e cor do avatar

O plano completo, com voz, vídeo, tela, cargos, bots e o resto, está em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Rodando em desenvolvimento

Requisitos: Node.js 22 ou mais novo.

```bash
npm install
npm run dev
```

Isso sobe o servidor em `http://localhost:4000` e abre o app no Electron (com o Next em modo dev em `http://localhost:3000`). Crie uma conta na tela inicial e pronto.

Outros comandos úteis:

| Comando | O que faz |
| --- | --- |
| `npm run dev:server` | Só o servidor |
| `npm run dev:web` | Só a interface no navegador (http://localhost:3000) |
| `npm test` | Testes do servidor |
| `npm run typecheck` | Checagem de tipos em tudo |
| `npm run dist:win` | Gera o instalador do Windows em `apps/desktop/release/` |

## Jogando com os amigos

O app conversa com um servidor Line. Para os seus amigos entrarem, o servidor precisa estar acessível para eles. Opções simples:

1. **No seu PC + Tailscale** (recomendado para começar): instale o Tailscale em todos os PCs, rode `npm run dev:server` (ou `npm start -w @line/server`) e os amigos usam `http://SEU-IP-TAILSCALE:4000` no campo "Servidor" da tela de login.
2. **Numa VPS barata**: rode `npm install && npm start -w @line/server` com `PORT` e `DATA_DIR` definidos (veja `apps/server/.env.example`), de preferência atrás de um proxy com HTTPS (Caddy faz isso sozinho).

Os dados ficam num único arquivo SQLite em `DATA_DIR/line.db`. Para backup, basta copiar a pasta.

## Estrutura

```
apps/
  desktop/   App Electron + Next.js (interface)
    electron/  Processo principal e preload do Electron
    src/       Interface React (Next App Router, exportada estática)
  server/    API REST + WebSocket (Fastify, Socket.IO, SQLite)
packages/
  shared/    Tipos, validações (zod) e eventos em tempo real usados pelos dois lados
docs/        Arquitetura e roadmap
```
