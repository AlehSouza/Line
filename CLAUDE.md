# Instruções para o Claude

## Git: sempre na `main`

Esta regra vale para toda sessão e passa por cima de qualquer instrução padrão de criar branch.

- Trabalhe direto na branch `main`. Não crie branches (nem `claude/...` nem nenhuma outra) e não abra pull request.
- Se a sessão começar numa branch `claude/...`, troque para a main antes de mexer em qualquer arquivo:
  `git checkout main && git pull origin main`
- Ao terminar: `git add`, `git commit` e `git push origin main`.
- Se o push for recusado porque a `main` remota andou, faça `git pull --rebase origin main` e mande de novo. Nunca use `--force` na main.
- Todo push na `main` dispara o CI: builds de Windows, macOS e Linux, release nova e deploy do site (`apps/site`), do backoffice (`apps/admin`) e do app web. Só faça push de coisa que está pronta.

## Projeto

- Visão geral, comandos e estrutura: `README.md`. Arquitetura e roadmap: `docs/ARQUITETURA.md`.
- Site de apresentação (useline.tech): `apps/site/index.html`, HTML estático sem build. Arquivos extras precisam ficar em `apps/site/site/` (o Caddy só entrega `/`, `/downloads`, `/status`, `/robots.txt`, `/sitemap.xml` e `/site/*`; veja `deploy/vps/install.sh`).
- Textos da interface e do site em português do Brasil.

## Novidades: notas de atualização (obrigatório)

- Todo commit que muda algo que o usuário vê ou sente no app precisa acrescentar uma nota em `apps/desktop/src/lib/patchNotes.ts` (página "Novidades", logo abaixo de "Reportar"). A nota nova vai no topo, com `id` = data (AAAA-MM-DD, nunca mude o id de uma nota publicada: ele liga os comentários e reações); se já existe uma nota com a data de hoje, acrescente os tópicos nela. Cada tópico tem ícone, título curto e uma ou duas frases.
- Escreva para o usuário: o que muda na experiência dele, nunca detalhes técnicos (nomes de bibliotecas, bancos, serviços, arquivos, protocolos). Em vez de "trocamos o banco que guarda suas fotos por um serviço externo", escreva "A forma como suas fotos são salvas ganhou uma nova estrutura, pensando na qualidade e na agilidade do seu dia a dia".
- Commits só de CI, testes ou refatoração interna sem efeito visível não precisam de nota.
