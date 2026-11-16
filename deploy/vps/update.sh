#!/usr/bin/env bash
# install.lastversion.update: atualiza o Line da VPS para a última versão da branch principal no GitHub.
# Baixa o código em /opt/line/src (git, repo público), faz um backup do banco e roda o install.sh.
# Dados (/var/lib/line), segredos (/etc/line/*.env, turn-secret) e backups não são tocados.
#
# Uso:  install.lastversion.update            atualiza se houver versão nova
#       install.lastversion.update --force    roda o install.sh mesmo sem versão nova
# Instalado em /usr/local/bin pelo install.sh. Log completo em /root/line-install.log.
set -euo pipefail

REPO="https://github.com/AlehSouza/Line.git"
REF="${LINE_REF:-claude/project-thread-dqswre}"
SRC=/opt/line/src
LOG=/root/line-install.log
DOMAIN="$(cat /etc/line/domain 2>/dev/null || echo useline.tech)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

b() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m✔ %s\033[0m\n' "$*"; }
err() { printf '\033[31m✘ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { err "Rode como root (ou com sudo)."; exit 1; }
command -v git >/dev/null || { apt-get update -q && apt-get install -y -q git; }

# Uma atualização por vez.
exec 9>/run/line-update.lock
flock -n 9 || { err "Já tem uma atualização rodando."; exit 1; }

b "==> Buscando a última versão ($REF) no GitHub"
mkdir -p "$SRC"
if [ ! -d "$SRC/.git" ]; then
  # Código enviado antes por scp: vira um clone sem apagar target/ e node_modules (compila mais rápido).
  git -C "$SRC" init -q
  git -C "$SRC" remote add origin "$REPO"
fi
git -C "$SRC" remote set-url origin "$REPO"
OLD="$(git -C "$SRC" rev-parse -q --verify HEAD 2>/dev/null || echo nenhuma)"
git -C "$SRC" fetch -q --depth=1 origin "$REF"
NEW="$(git -C "$SRC" rev-parse FETCH_HEAD)"
echo "    Instalada: ${OLD:0:7}   GitHub: ${NEW:0:7} — $(git -C "$SRC" log -1 --format=%s FETCH_HEAD)"

if [ "$OLD" = "$NEW" ] && [ "$FORCE" = 0 ]; then
  ok "Já está na última versão. (Use --force para reinstalar mesmo assim.)"
  exit 0
fi

git -C "$SRC" checkout -q -f -B "$REF" FETCH_HEAD
git -C "$SRC" clean -q -fd   # tira arquivos velhos; mantém os ignorados (target/, node_modules/)

b "==> Backup do banco antes de atualizar"
if [ -x /usr/local/bin/line-backup ] && [ -f /var/lib/line/line.db ]; then
  /usr/local/bin/line-backup && ok "Backup em /var/backups/line"
else
  echo "    (sem banco ou sem line-backup ainda, pulando)"
fi

b "==> Instalando (compilar leva uns 4 minutos; log em $LOG)"
START=$(date +%s)
if SKIP_GIT=1 bash "$SRC/deploy/vps/install.sh" "$DOMAIN" "$REF" 2>&1 | tee "$LOG"; then
  echo
  ok "Line atualizado para ${NEW:0:7} em $(( ($(date +%s) - START) / 60 )) min."
  curl -fsS http://127.0.0.1:4000/api/health >/dev/null && ok "Servidor respondendo em https://$DOMAIN"
else
  echo
  err "A atualização falhou. Veja o log: $LOG  e  journalctl -u line -n 50"
  exit 1
fi
