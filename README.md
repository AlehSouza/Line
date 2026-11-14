# Line

App de chat e comunidades para desktop (Windows e Linux), feito para uso pessoal com a sua galera: servidores, canais, mensagens privadas, amigos e status, tudo liberado e sem assinatura.

## Baixar

Os instaladores mais recentes ficam em **[Releases](https://github.com/AlehSouza/Line/releases/latest)**:

- **Windows 10/11**: baixe o `Line_*_x64-setup.exe` e execute (instala só para o seu usuário, sem pedir administrador).
- **Linux (Debian 12+, Ubuntu 22.04+ e derivados)**: baixe o `Line_*_amd64.deb` e rode `sudo apt install ./Line_*_amd64.deb`. Depois é só abrir "Line" no menu de aplicativos. No Linux o casco é Electron (`apps/desktop/linux`), porque o WebKitGTK das distros vem sem WebRTC; a interface é a de `useline.tech/app`.
- **Pelo navegador**: todo servidor Line também entrega o app web na raiz (`http://IP:4000/` ou `https://seu-dominio/`). Microfone e câmera no navegador exigem HTTPS (ou `localhost`).

Feito em **Rust** por baixo: o app é um casco **Tauri** (usa o WebView2 do Windows em vez de carregar um Chromium inteiro) com a interface em **Next.js + TypeScript**, e o servidor é **Rust (axum + Socket.IO + SQLite)**, que roda embutido no próprio app ou sozinho numa máquina sua.

## O que já funciona (fase 1)

- Cadastro e login com nome de usuário e senha
- Servidores públicos ou privados, convite por código, explorar servidores públicos
- Categorias e canais de texto
- Mensagens em tempo real com edição, exclusão, markdown (`**negrito**`, `*itálico*`, `` `código` ``, blocos, links) e @menções
- Mensagens privadas 1:1 e em grupo
- Amigos: pedidos, aceitar, recusar, desfazer
- Status: disponível, ausente (automático após 5 min parado), não perturbe e invisível, mais status personalizado
- Indicador de "digitando…", mensagens não lidas, notificações do Windows para DMs e menções
- Perfil com nome de exibição, bio e cor do avatar

E da fase 2:

- Canais de voz com WebRTC: entrar/sair, mudo, ensurdecer e indicador de quem está falando
- Câmera e compartilhamento de tela (com o seletor de tela/janela do Windows e áudio do sistema)
- Chamadas de voz e vídeo nas mensagens privadas, com aviso de chamada recebida

O plano completo, com voz, vídeo, tela, cargos, bots e o resto, está em [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

## Rodando em desenvolvimento

Requisitos: Node.js 22+, [Rust](https://rustup.rs) estável e, no Windows, as "Ferramentas de Build do C++" do Visual Studio (o instalador do Rust oferece). O WebView2 já vem no Windows 10/11.

```bash
npm install
npm run dev
```

Isso abre o app com o Next em modo dev (`http://localhost:3000`) e o servidor Line embutido em `http://localhost:4000`. Crie uma conta na tela inicial e pronto. A primeira compilação do Rust demora alguns minutos; as seguintes são rápidas.

Outros comandos úteis:

| Comando | O que faz |
| --- | --- |
| `npm run dev:server` | Só o servidor (`cargo run -p line-server`) |
| `npm run dev:web` | Só a interface no navegador (http://localhost:3000) |
| `npm test` | Testes do servidor: unitários em Rust + testes de contrato com `socket.io-client` |
| `npm run typecheck` | Checagem de tipos da interface |
| `npm run dist:win` | Gera o instalador do Windows em `target/release/bundle/nsis/` |
| `npm run dist:linux` | Gera o pacote `.deb` em `target/release/bundle/deb/` (precisa de `libwebkit2gtk-4.1-dev`) |

O CI do GitHub gera os dois instaladores a cada PR (artefatos "Line-instalador-windows" e "Line-linux-deb") e, a cada push na branch principal, publica os dois numa release nova.

## Jogando com os amigos

O app conversa com um servidor Line. Para os seus amigos entrarem, o servidor precisa estar acessível para eles. Opções simples:

1. **No seu PC + Tailscale** (recomendado para começar): instale o Tailscale em todos os PCs, abra o app (ele já sobe o servidor) ou rode `npm run dev:server` e os amigos usam `http://SEU-IP-TAILSCALE:4000` no campo "Servidor" da tela de login.
2. **Numa VPS barata**: compile com `cargo build --release -p line-server` e rode o binário `target/release/line-server` com `PORT` e `DATA_DIR` definidos (veja `apps/server/.env.example`), de preferência atrás de um proxy com HTTPS (Caddy faz isso sozinho).

Sobre voz e vídeo: o navegador só libera microfone e câmera em `localhost` ou HTTPS. Pelo app desktop funciona sempre; pela versão web acessada por IP, só com HTTPS. A voz conecta as pessoas direto entre si (WebRTC); se alguém estiver atrás de uma rede muito restrita, pode ser preciso um servidor TURN (fica para depois).

Os dados ficam num único arquivo SQLite em `DATA_DIR/line.db`. Para backup, basta copiar a pasta.

## Estrutura

```
apps/
  desktop/        Interface + app desktop
    src/          Interface React (Next App Router, exportada estática)
    src-tauri/    Casco Tauri em Rust: janela, ponte com a interface, servidor embutido
  server/         Servidor Line em Rust (crate line-server)
    src/          axum (REST), socketioxide (tempo real), rusqlite (banco)
    test/         Testes de contrato em TypeScript contra o binário
packages/
  shared/         Tipos, validações (zod) e eventos em tempo real usados pela interface
docs/             Arquitetura e roadmap
```

### Vindo da versão Electron

Na primeira vez que o app novo abre, ele copia o banco do servidor embutido antigo (`%APPDATA%\Line\server`) para a pasta nova, então contas, servidores e mensagens continuam lá. Senhas e o formato do banco são os mesmos. Só é preciso entrar de novo na conta uma vez.
