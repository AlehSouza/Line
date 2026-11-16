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
