#!/usr/bin/env bash
# Instala (ou atualiza) o servidor do Line numa VPS Ubuntu/Debian, com:
#   - line-server (API + Socket.IO + app web) como serviço systemd
#   - Caddy na frente, com HTTPS automático (Let's Encrypt)
#   - coturn (TURN) para chamadas atravessarem redes chatas (4G, CGNAT)
#
# Uso:   sudo bash install.sh line-xande.duckdns.org [branch]
# Rodar de novo atualiza para a versão mais nova da branch (dados ficam em /var/lib/line).
set -euo pipefail

DOMAIN="${1:?Informe o domínio, ex.: sudo bash install.sh line-xande.duckdns.org}"
REF="${2:-main}"
REPO="https://github.com/AlehSouza/Line.git"
SRC=/opt/line/src
TURN_MIN=49160
TURN_MAX=49200

[ "$(id -u)" = 0 ] || { echo "Rode com sudo."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Pacotes do sistema"
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg build-essential pkg-config coturn \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent openssl sqlite3

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if [ ! -x /root/.cargo/bin/cargo ]; then
  echo "==> Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="/root/.cargo/bin:$PATH"

echo "==> Código ($REF)"
if [ "${SKIP_GIT:-}" = "1" ]; then
  echo "    SKIP_GIT=1: usando o código já enviado para $SRC"
elif [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q origin "$REF" && git -C "$SRC" checkout -q -B "$REF" FETCH_HEAD
else
  mkdir -p /opt/line && git clone -q --branch "$REF" "$REPO" "$SRC"
fi

echo "==> Compilando (pode levar uns minutos na primeira vez)"
cd "$SRC"
npm ci --no-audit --no-fund
npm run build:web -w @line/desktop
cargo build --release -p line-server

echo "==> Instalando"
id line >/dev/null 2>&1 || useradd --system --home /var/lib/line --shell /usr/sbin/nologin line
mkdir -p /var/lib/line /etc/line
chown line:line /var/lib/line
install -m 755 target/release/line-server /opt/line/line-server
rm -rf /opt/line/web && cp -r apps/desktop/out /opt/line/web
# Comando para atualizar pela VPS: baixa a última versão do GitHub e roda este script.
echo "$DOMAIN" > /etc/line/domain
install -m 755 deploy/vps/update.sh /usr/local/bin/install.lastversion.update

PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
PRIVATE_IP="$(hostname -I | awk '{print $1}')"
if [ ! -f /etc/line/turn-secret ]; then openssl rand -hex 32 > /etc/line/turn-secret; fi
TURN_SECRET="$(cat /etc/line/turn-secret)"
chmod 600 /etc/line/turn-secret

cat > /etc/line/line.env <<ENV
PORT=4000
HOST=127.0.0.1
DATA_DIR=/var/lib/line
WEB_DIR=/opt/line/web
TURN_URLS=turn:$DOMAIN:3478,turn:$DOMAIN:3478?transport=tcp
TURN_SECRET=$TURN_SECRET
RUST_LOG=info
ENV
chmod 640 /etc/line/line.env && chgrp line /etc/line/line.env

cat > /etc/systemd/system/line.service <<'UNIT'
[Unit]
Description=Servidor Line
After=network-online.target
Wants=network-online.target

[Service]
User=line
Group=line
EnvironmentFile=/etc/line/line.env
# Opcional, não é sobrescrito pelo script: TURNSTILE_SITE_KEY e TURNSTILE_SECRET (captcha do cadastro).
EnvironmentFile=-/etc/line/captcha.env
EnvironmentFile=-/etc/line/giphy.env
# SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM: email do "Esqueci minha senha".
EnvironmentFile=-/etc/line/smtp.env
# GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET: "Entrar com Google".
EnvironmentFile=-/etc/line/google.env
# IGDB_CLIENT_ID e IGDB_CLIENT_SECRET (app da Twitch): capas dos jogos na Atividade.
EnvironmentFile=-/etc/line/igdb.env
# ADMIN_USERS: ids das contas com acesso ao painel backoffice.useline.tech (separados por vírgula).
EnvironmentFile=-/etc/line/admin.env
ExecStart=/opt/line/line-server
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/line
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip
	# Segurança: só HTTPS (HSTS), sem adivinhar tipo de arquivo, sem vazar o caminho no Referer.
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	# Site e app web não podem ser abertos dentro de outro site (clickjacking). O captcha
	# (/api/auth/captcha) fica de fora porque o app desktop o abre num iframe.
	@noframe not path /api/*
	header @noframe X-Frame-Options SAMEORIGIN
	# App web: só roda scripts do próprio Line, do YouTube (bot de música) e do captcha.
	# Iframes: YouTube, players oficiais de Instagram/TikTok/X nos links do chat e o captcha.
	@app path /app /app/*
	header @app Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://www.instagram.com https://www.tiktok.com https://platform.twitter.com https://challenges.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
	request_body {
		max_size 110MB
	}
	# Atualizações do app desktop (o CI envia instalador + latest.json para cá).
	handle_path /updates/* {
		header /latest.json Cache-Control "no-cache"
		root * /opt/line/updates
		file_server
	}
	# Site de apresentação na raiz (o CI envia apps/site para /opt/line/site).
	@site path / /index.html /downloads /downloads/ /status /status/ /robots.txt /sitemap.xml /site/*
	handle @site {
		rewrite /downloads* /index.html
		# Status dos servidores (apps/site/site/status.html).
		rewrite /status* /site/status.html
		root * /opt/line/site
		file_server
	}
	# Painel administrador mudou para backoffice.$DOMAIN; a API admin só responde por lá.
	redir /admin* https://backoffice.$DOMAIN/
	@adminapi path /api/admin/*
	handle @adminapi {
		respond 404
	}
	# App web completo em /app/ (o servidor entrega a interface em /).
	redir /app /app/
	handle_path /app/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		reverse_proxy 127.0.0.1:4000
	}
}

# Backoffice (projeto apps/admin; o CI envia para /opt/line/admin). As páginas só saem para admins
# (conferido no servidor) e a API admin responde apenas para eles. Precisa do DNS: A admin -> IP da VPS.
backoffice.$DOMAIN {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
		X-Robots-Tag "noindex, nofollow"
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://$DOMAIN; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
		-Server
	}
	# Só a API admin e o que a tela de login usa chegam ao servidor do Line.
	@api path /api/admin/* /api/auth/config /api/health
	handle @api {
		reverse_proxy 127.0.0.1:4000
	}
	@otherapi {
		path /api/*
		not path /api/admin/* /api/auth/config /api/health
	}
	handle @otherapi {
		respond 404
	}
	# Tela de login: a única página entregue sem sessão.
	@public path /login.html /login.js /admin.css
	handle @public {
		header Cache-Control "no-cache"
		root * /opt/line/admin
		file_server
	}
	# Todo o resto só sai depois do servidor conferir o cookie: admin passa, quem entrou e não é
	# admin vai para o app, quem não entrou vai para /login.html.
	handle {
		forward_auth 127.0.0.1:4000 {
			uri /api/admin/gate
		}
		header Cache-Control "no-cache"
		root * /opt/line/admin
		file_server
	}
}
CADDY

echo "==> Pasta de atualizações do app"
# Usuário sem privilégios que o CI usa para enviar os arquivos (chave pública em /etc/line/deploy.pub).
id line-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash line-deploy
install -d -o line-deploy -g line-deploy -m 755 /opt/line/updates /opt/line/site /opt/line/admin
# O CI também publica o app web (mesmo build do desktop) a cada merge.
chown -R line-deploy:line-deploy /opt/line/web
# Primeira instalação: coloca o site da branch já baixada (depois o CI mantém atualizado).
if [ ! -f /opt/line/site/index.html ] && [ -f "$SRC/apps/site/index.html" ]; then
  cp -r "$SRC/apps/site/." /opt/line/site/ && chown -R line-deploy:line-deploy /opt/line/site
fi
# Painel admin: sempre a versão do código instalado (o CI também atualiza a cada merge).
if [ -f "$SRC/apps/admin/index.html" ]; then
  cp -r "$SRC/apps/admin/." /opt/line/admin/ && chown -R line-deploy:line-deploy /opt/line/admin
fi
if [ -f /etc/line/deploy.pub ]; then
  install -d -o line-deploy -g line-deploy -m 700 /home/line-deploy/.ssh
  install -o line-deploy -g line-deploy -m 600 /etc/line/deploy.pub /home/line-deploy/.ssh/authorized_keys
fi

echo "==> TURN (coturn)"
cat > /etc/turnserver.conf <<TURN
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
min-port=$TURN_MIN
max-port=$TURN_MAX
external-ip=${PUBLIC_IP:-$PRIVATE_IP}/$PRIVATE_IP
no-cli
no-tls
no-dtls
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
total-quota=200
TURN
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true

echo "==> Firewall da máquina (as imagens da Oracle bloqueiam tudo por padrão)"
open_port() { iptables -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null || iptables -I INPUT -p "$1" --dport "$2" -j ACCEPT; }
open_port tcp 80
open_port tcp 443
open_port udp 443
open_port tcp 3478
open_port udp 3478
open_port udp "$TURN_MIN:$TURN_MAX"
netfilter-persistent save >/dev/null

echo "==> Backup diário do banco (/var/backups/line, guarda 14 dias)"
cat > /usr/local/bin/line-backup <<'BACKUP'
#!/bin/sh
# Cópia consistente do banco do Line (funciona com o servidor rodando) + segredos.
set -eu
DIR=/var/backups/line
STAMP=$(date +%Y%m%d-%H%M)
install -d -m 700 "$DIR"
sqlite3 /var/lib/line/line.db ".backup '$DIR/line-$STAMP.db'"
gzip -f "$DIR/line-$STAMP.db"
tar -czf "$DIR/segredos-$STAMP.tar.gz" -C / var/lib/line/jwt-secret etc/line 2>/dev/null || true
chmod 600 "$DIR"/*
find "$DIR" -name 'line-*.db.gz' -mtime +14 -delete
find "$DIR" -name 'segredos-*.tar.gz' -mtime +14 -delete
BACKUP
chmod 755 /usr/local/bin/line-backup
cat > /etc/systemd/system/line-backup.service <<'UNIT'
[Unit]
Description=Backup do banco do Line

[Service]
Type=oneshot
ExecStart=/usr/local/bin/line-backup
UNIT
cat > /etc/systemd/system/line-backup.timer <<'UNIT'
[Unit]
Description=Backup diário do banco do Line

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Admin do painel (backoffice.$DOMAIN): na primeira vez, a conta mais antiga (a do dono do Line). Para trocar, edite
# /etc/line/admin.env (ADMIN_USERS=<id>[,<id>]) e rode systemctl restart line.
if [ ! -f /etc/line/admin.env ] && [ -f /var/lib/line/line.db ]; then
  FIRST="$(sqlite3 /var/lib/line/line.db "SELECT id || ' ' || username FROM users WHERE bot_server_id IS NULL ORDER BY created_at LIMIT 1" || true)"
  if [ -n "$FIRST" ]; then
    echo "ADMIN_USERS=${FIRST%% *}" > /etc/line/admin.env
    chmod 640 /etc/line/admin.env && chgrp line /etc/line/admin.env
    echo "    Painel admin liberado para @${FIRST#* } (${FIRST%% *})"
  fi
fi
[ -f /etc/line/admin.env ] && echo "    Admins do painel: $(cat /etc/line/admin.env)"
systemctl daemon-reload
systemctl enable --now line-backup.timer >/dev/null
systemctl enable --now line.service
systemctl restart line.service coturn caddy
systemctl enable coturn caddy >/dev/null

sleep 2
if curl -fsS http://127.0.0.1:4000/api/health >/dev/null; then
  echo
  echo "Pronto! Abra https://$DOMAIN no navegador ou coloque esse endereço no campo Servidor do app."
  echo "(O certificado HTTPS pode levar 1 minuto para sair na primeira vez.)"
  echo "Para atualizar depois, rode: install.lastversion.update"
else
  echo "O servidor não respondeu. Veja: journalctl -u line -n 50"
  exit 1
fi
