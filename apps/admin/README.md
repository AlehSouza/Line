# Line Admin

Painel administrador do Line, em **https://backoffice.useline.tech**. Projeto à parte do app: HTML, CSS e
JavaScript puros, sem build.

- O Caddy do subdomínio (deploy/vps/install.sh) serve esta pasta e repassa para o servidor do Line só
  o login (`/api/auth/login`, `/api/auth/config`, `/api/auth/google/finish`) e `/api/admin/*`.
- A API admin só responde para as contas em `ADMIN_USERS` (`/etc/line/admin.env`, ids separados por vírgula).
- O CI copia esta pasta para `/opt/line/admin` na VPS a cada merge.
- DNS: registro `A` com nome `backoffice` apontando para o IP da VPS.
