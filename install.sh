#!/usr/bin/env bash
# install.sh -- install OfficeAgent on a fresh Ubuntu/Debian host.
#
# Architecture (see README.md "Status" / systemd/*.service): Postgres runs
# in Docker (the one piece that benefits from a pinned, reproducible
# image); bot/ and gbrain/ run as ordinary host processes under systemd,
# same pattern our own production system and the edgelab-install
# competitor both use. There is NO docker-compose stack for bot/gbrain --
# only `docker compose up db`.
#
# This script is intentionally linear and readable over clever -- an
# operator debugging a failed install should be able to read it top to
# bottom and know exactly what ran.
#
# STATUS: written but NOT run end-to-end in this environment (no real
# host to test against). Read before trusting it in production -- see
# README.md "Status".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT=/opt/officeagent
CONFIG_ROOT=/etc/officeagent
VAULT_ROOT=/var/lib/officeagent/vault
WORKSPACES_ROOT=/var/lib/officeagent/workspaces

log()  { printf '[install] %s\n' "$*"; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }
step() { printf '\n[install] --- %s ---\n' "$*"; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run as root (as root, or via: sudo bash install.sh)"
  fi
}

# ---------------------------------------------------------------------
# Step 1/7: platform check
# ---------------------------------------------------------------------
step "1/7 platform check"
require_root
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
case "${ID}-${VERSION_ID}" in
  ubuntu-22.04|ubuntu-24.04|debian-12) ;;
  *) log "WARNING: untested on ${ID} ${VERSION_ID} -- continuing anyway" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) ;;
  *) die "unsupported architecture: $ARCH" ;;
esac
FREE_KB="$(df -Pk /opt 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "${FREE_KB:-}" ] && [ "$FREE_KB" -lt 15000000 ]; then
  log "WARNING: less than 15GB free under /opt -- fastembed model + Postgres data may not fit"
fi

# ---------------------------------------------------------------------
# Step 2/7: system packages
# ---------------------------------------------------------------------
step "2/7 system packages (Node 20, Python 3.11+, git, docker)"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg tmux python3 python3-venv python3-pip rsync openssl

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//;s/\..*//')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi

if ! command -v claude >/dev/null 2>&1; then
  npm i -g @anthropic-ai/claude-code@2.1.x
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not found"

# ---------------------------------------------------------------------
# Step 3/7: system user (no elevated privileges -- runtime processes
# never need them; the installer itself runs as root once, the services
# it sets up don't)
# ---------------------------------------------------------------------
step "3/7 system user"
if ! id officeagent >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin officeagent
  log "created system user 'officeagent' (nologin, no elevated privileges)"
else
  log "system user 'officeagent' already exists"
fi

# ---------------------------------------------------------------------
# Step 4/7: five questions
# ---------------------------------------------------------------------
step "4/7 configuration"
read -rp "Telegram bot token (from @BotFather): " TELEGRAM_BOT_TOKEN
read -rp "Your Telegram numeric user id (from @userinfobot): " OWNER_TELEGRAM_USER_ID
read -rp "Claude auth -- paste ANTHROPIC_API_KEY, or leave empty to use CLAUDE_CODE_OAUTH_TOKEN instead: " ANTHROPIC_API_KEY
CLAUDE_CODE_OAUTH_TOKEN=""
if [ -z "$ANTHROPIC_API_KEY" ]; then
  read -rp "  CLAUDE_CODE_OAUTH_TOKEN (Claude subscription OAuth token): " CLAUDE_CODE_OAUTH_TOKEN
fi
read -rp "Full-text search language [russian/english/simple] (default english): " FTS_LANGUAGE
FTS_LANGUAGE="${FTS_LANGUAGE:-english}"
read -rp "Alternative model provider (GLM/Z.ai or similar)? [y/N]: " WANT_ALT
ALT_PROVIDER_BASE_URL="" ; ALT_PROVIDER_TOKEN="" ; ALT_PROVIDER_MODEL="" ; ALT_PROVIDER_LABEL="Alternative model"
if [[ "$WANT_ALT" =~ ^[Yy]$ ]]; then
  read -rp "  ALT_PROVIDER_BASE_URL: " ALT_PROVIDER_BASE_URL
  read -rp "  ALT_PROVIDER_TOKEN: " ALT_PROVIDER_TOKEN
  read -rp "  ALT_PROVIDER_MODEL: " ALT_PROVIDER_MODEL
  read -rp "  ALT_PROVIDER_LABEL (display name, default 'Alternative model'): " ALT_PROVIDER_LABEL
  ALT_PROVIDER_LABEL="${ALT_PROVIDER_LABEL:-Alternative model}"
fi

# ---------------------------------------------------------------------
# Step 5/7: generate config, install app trees
# ---------------------------------------------------------------------
step "5/7 writing config + installing app trees"
mkdir -p "$CONFIG_ROOT" "$VAULT_ROOT" "$WORKSPACES_ROOT" "$INSTALL_ROOT"
PG_PASSWORD="$(openssl rand -hex 24)"
TELEGRAM_WEBHOOK_TOKEN="$(openssl rand -hex 32)"
OFFICEAGENT_OWNER_TOKEN="$(openssl rand -hex 32)"

cat > "$CONFIG_ROOT/officeagent.env" <<EOF
PG_DATABASE=officeagent
PG_USER=officeagent
PG_PASSWORD=${PG_PASSWORD}
PG_HOST=127.0.0.1
PG_PORT=5432
EOF
chmod 0600 "$CONFIG_ROOT/officeagent.env"

cat > "$CONFIG_ROOT/gbrain.env" <<EOF
MCP_HOST=127.0.0.1
MCP_PORT=8770
VAULT_ROOT=${VAULT_ROOT}
FTS_LANGUAGE=${FTS_LANGUAGE}
OFFICEAGENT_TOOLS=all
OFFICEAGENT_HMAC_AUTH_ENABLED=0
OFFICEAGENT_SUPERSEDE_AUTO=0.85
OFFICEAGENT_SUPERSEDE_HINT=0.70
AGENT_GATEWAYS={"owner":"http://127.0.0.1:8093/hooks/agent"}
GATEWAY_WEBHOOK_TOKEN=${TELEGRAM_WEBHOOK_TOKEN}
FASTEMBED_CACHE_PATH=${INSTALL_ROOT}/gbrain/.model-cache
HF_HOME=${INSTALL_ROOT}/gbrain/.model-cache
EOF
chmod 0600 "$CONFIG_ROOT/gbrain.env"

cat > "$CONFIG_ROOT/bot.env" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_ALLOWED_USER_IDS=${OWNER_TELEGRAM_USER_ID}
TELEGRAM_ALLOWED_CHAT_IDS=${OWNER_TELEGRAM_USER_ID}
TELEGRAM_WEBHOOK_ENABLED=1
TELEGRAM_WEBHOOK_HOST=0.0.0.0
TELEGRAM_WEBHOOK_PORT=8093
TELEGRAM_WEBHOOK_TOKEN=${TELEGRAM_WEBHOOK_TOKEN}
TELEGRAM_STATE_DIR=${INSTALL_ROOT}/bot/state
OFFICEAGENT_MCP_URL=http://127.0.0.1:8770
OFFICEAGENT_OWNER_TOKEN=${OFFICEAGENT_OWNER_TOKEN}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN}
ALT_PROVIDER_BASE_URL=${ALT_PROVIDER_BASE_URL}
ALT_PROVIDER_TOKEN=${ALT_PROVIDER_TOKEN}
ALT_PROVIDER_MODEL=${ALT_PROVIDER_MODEL}
ALT_PROVIDER_LABEL=${ALT_PROVIDER_LABEL}
EOF
chmod 0600 "$CONFIG_ROOT/bot.env"

rsync -a --delete "$REPO_ROOT/gbrain/" "$INSTALL_ROOT/gbrain/" --exclude .venv --exclude __pycache__
rsync -a --delete "$REPO_ROOT/bot/" "$INSTALL_ROOT/bot/" --exclude node_modules --exclude state
rsync -a --delete "$REPO_ROOT/templates/" "$INSTALL_ROOT/templates/"
rsync -a --delete "$REPO_ROOT/skills/" "$INSTALL_ROOT/skills/"
cp "$REPO_ROOT/docker-compose.yml" "$INSTALL_ROOT/docker-compose.yml"
chown -R officeagent:officeagent "$INSTALL_ROOT" "$VAULT_ROOT" "$WORKSPACES_ROOT"

log "installing gbrain Python venv"
runuser -u officeagent -- python3 -m venv "$INSTALL_ROOT/gbrain/.venv"
runuser -u officeagent -- "$INSTALL_ROOT/gbrain/.venv/bin/pip" install --no-cache-dir -r "$INSTALL_ROOT/gbrain/requirements.txt"

log "downloading embedding model into .model-cache (one-time, ~1-2GB)"
runuser -u officeagent -- env \
  FASTEMBED_CACHE_PATH="$INSTALL_ROOT/gbrain/.model-cache" \
  HF_HOME="$INSTALL_ROOT/gbrain/.model-cache" \
  "$INSTALL_ROOT/gbrain/.venv/bin/python" -c \
  "from fastembed import TextEmbedding; TextEmbedding('intfloat/multilingual-e5-large')"

log "installing bot dependencies (bun)"
(cd "$INSTALL_ROOT/bot" && runuser -u officeagent -- bun install --production)

# ---------------------------------------------------------------------
# Step 6/7: start Postgres, run migrations
# ---------------------------------------------------------------------
step "6/7 starting Postgres + applying migrations"
(cd "$INSTALL_ROOT" && docker compose --env-file "$CONFIG_ROOT/officeagent.env" up -d db)
for i in $(seq 1 30); do
  docker exec officeagent-db pg_isready -U officeagent -d officeagent >/dev/null 2>&1 && break
  sleep 2
done
docker exec officeagent-db psql -U officeagent -d officeagent -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

runuser -u officeagent -- env \
  --chdir="$INSTALL_ROOT/gbrain" \
  PG_HOST=127.0.0.1 PG_DATABASE=officeagent PG_USER=officeagent PG_PASSWORD="$PG_PASSWORD" MCP_PORT=8770 \
  "$INSTALL_ROOT/gbrain/.venv/bin/python" scripts/migrate.py

# ---------------------------------------------------------------------
# Step 7/7: systemd units
# ---------------------------------------------------------------------
step "7/7 installing systemd units"
cp "$REPO_ROOT/systemd/officeagent-db.service" /etc/systemd/system/
cp "$REPO_ROOT/systemd/officeagent-gbrain.service" /etc/systemd/system/
cp "$REPO_ROOT/systemd/officeagent-bot.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now officeagent-db.service
sleep 3
systemctl enable --now officeagent-gbrain.service
sleep 3
systemctl enable --now officeagent-bot.service

log ""
log "Install complete. Check status with:"
log "  systemctl status officeagent-db officeagent-gbrain officeagent-bot"
log "  journalctl -u officeagent-bot -f"
log ""
log "Message your bot on Telegram to confirm it responds."
