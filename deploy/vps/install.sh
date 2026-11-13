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
REF="${2:-claude/project-thread-dqswre}"
REPO="https://github.com/AlehSouza/Line.git"
SRC=/opt/line/src
TURN_MIN=49160
TURN_MAX=49200

[ "$(id -u)" = 0 ] || { echo "Rode com sudo."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> Pacotes do sistema"
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg build-essential pkg-config coturn \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent openssl

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
if [ -d "$SRC/.git" ]; then
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
	request_body {
		max_size 110MB
	}
	# Atualizações do app desktop (o CI envia instalador + latest.json para cá).
	handle_path /updates/* {
		header /latest.json Cache-Control "no-cache"
		root * /opt/line/updates
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:4000
	}
}
CADDY

echo "==> Pasta de atualizações do app"
# Usuário sem privilégios que o CI usa para enviar os arquivos (chave pública em /etc/line/deploy.pub).
id line-deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash line-deploy
install -d -o line-deploy -g line-deploy -m 755 /opt/line/updates
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

systemctl daemon-reload
systemctl enable --now line.service
systemctl restart line.service coturn caddy
systemctl enable coturn caddy >/dev/null

sleep 2
if curl -fsS http://127.0.0.1:4000/api/health >/dev/null; then
  echo
  echo "Pronto! Abra https://$DOMAIN no navegador ou coloque esse endereço no campo Servidor do app."
  echo "(O certificado HTTPS pode levar 1 minuto para sair na primeira vez.)"
else
  echo "O servidor não respondeu. Veja: journalctl -u line -n 50"
  exit 1
fi
