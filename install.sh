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
  ca-certificates curl git gnupg tmux python3 python3-venv python3-pip rsync openssl unzip

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//;s/\..*//')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  # Copy (not symlink) the binary out to /usr/local/bin: the installer
  # runs as root, so bun lands under $HOME/.bun (i.e. /root/.bun) --
  # a symlink there is unreachable for the unprivileged `officeagent`
  # user later (root's home is 0700), so `runuser -u officeagent -- bun`
  # fails with "Permission denied" even though the symlink itself resolves.
  install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
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

# Seed ~/.claude.json so claude's first-ever launch in $INSTALL_ROOT/bot never
# hits the interactive "Is this a project you created or one you trust?"
# dialog (found the hard way testing a from-scratch install: the blind
# ExecStartPost keystrokes are timed for the OLDER dev-channels warning, not
# this dialog, and dismiss it wrong often enough that the service sits there
# doing nothing until a human notices). Only written if it doesn't exist yet
# -- never overwrite a real config on a re-run.
if [ ! -f /home/officeagent/.claude.json ]; then
  cat > /home/officeagent/.claude.json <<EOF
{
  "hasCompletedOnboarding": true,
  "projects": {
    "$INSTALL_ROOT/bot": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true,
      "projectOnboardingSeenCount": 1
    }
  }
}
EOF
  chown officeagent:officeagent /home/officeagent/.claude.json
  chmod 0600 /home/officeagent/.claude.json
fi

# Seed user-level settings so `--permission-mode bypassPermissions` never
# hits its own one-time interactive confirmation ("WARNING: Claude Code
# running in Bypass Permissions mode ... 1. No, exit / 2. Yes, I accept").
# Found the hard way: ExecStartPost's blind Enter keystrokes select the
# highlighted DEFAULT option, which is "1. No, exit" -- claude exits
# immediately, tmux (single pane, no remain-on-exit) closes with it, and
# the service crash-loops forever with no visible reason in `journalctl`
# (the real error only lives in the tmux pane, which is already gone by
# the time anyone looks). The accept path in claude's own source writes
# exactly this key to user-scope settings -- write it up front instead of
# fighting the dialog with more keystrokes.
mkdir -p /home/officeagent/.claude
if [ ! -f /home/officeagent/.claude/settings.json ]; then
  printf '{\n  "skipDangerousModePermissionPrompt": true\n}\n' > /home/officeagent/.claude/settings.json
  chown officeagent:officeagent /home/officeagent/.claude/settings.json
  chmod 0600 /home/officeagent/.claude/settings.json
fi
chown officeagent:officeagent /home/officeagent/.claude

# ---------------------------------------------------------------------
# Step 4/7: five questions
# ---------------------------------------------------------------------
step "4/7 configuration"
read -rp "Telegram bot token (from @BotFather): " TELEGRAM_BOT_TOKEN
read -rp "Your Telegram numeric user id (from @userinfobot): " OWNER_TELEGRAM_USER_ID
read -rp "Claude auth -- paste ANTHROPIC_API_KEY, or leave empty to log in with your Claude subscription: " ANTHROPIC_API_KEY
CLAUDE_CODE_OAUTH_TOKEN=""
if [ -z "$ANTHROPIC_API_KEY" ]; then
  read -rp "  Already have a CLAUDE_CODE_OAUTH_TOKEN? [y/N]: " HAVE_TOKEN
  if [[ "$HAVE_TOKEN" =~ ^[Yy]$ ]]; then
    read -rp "  Paste it: " CLAUDE_CODE_OAUTH_TOKEN
  else
    # Generate it right here instead of sending the operator off to install
    # Claude Code on a second machine -- `claude` is already on this box
    # from step 2 above. `claude setup-token` prints a login link (open on
    # any device with a browser -- a phone is fine); if the browser can't
    # redirect back (common over SSH) it shows a short code to paste below.
    # (owner: "нам нужно авторизовать Claude без запуска клода [где-то ещё]", 2026-08-20)
    echo
    echo ">>> Opening Claude subscription login. Open the link below on any device"
    echo ">>> with a browser, approve access, and paste back any code it asks for."
    echo
    claude setup-token || true
    echo
    read -rp "  Paste the token 'claude setup-token' printed above: " CLAUDE_CODE_OAUTH_TOKEN
  fi
fi
read -rp "Full-text search language [russian/english/simple] (default english): " FTS_LANGUAGE
FTS_LANGUAGE="${FTS_LANGUAGE:-english}"
read -rp "Also connect GLM (Z.ai) as an alternative model? [y/N]: " WANT_ALT
ALT_PROVIDER_BASE_URL="" ; ALT_PROVIDER_TOKEN="" ; ALT_PROVIDER_MODEL="" ; ALT_PROVIDER_LABEL=""
if [[ "$WANT_ALT" =~ ^[Yy]$ ]]; then
  # Only the token is asked -- base_url/model/label are GLM's own fixed,
  # known-good values (2026-08-16, owner: don't make the installer ask
  # things a non-technical person can't answer). Someone who genuinely
  # wants a DIFFERENT Anthropic-compatible provider (not GLM) can still
  # override ALT_PROVIDER_BASE_URL/MODEL/LABEL by hand afterward in
  # /etc/officeagent/bot.env -- that is a power-user path, not the
  # installer's default flow.
  read -rp "  GLM (Z.ai) API token: " ALT_PROVIDER_TOKEN
  ALT_PROVIDER_BASE_URL="https://api.z.ai/api/anthropic"
  ALT_PROVIDER_MODEL="glm-5.2"
  ALT_PROVIDER_LABEL="GLM 5.2 (Z.ai)"
fi

DEFAULT_MODEL_TARGET=""
if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -n "$ALT_PROVIDER_TOKEN" ]; then
  DEFAULT_MODEL_TARGET="alt"
  log "No Anthropic credential given -- every session will default to the alternative provider ($ALT_PROVIDER_LABEL, no Anthropic account ever used)"
fi

# Manual-only by design (owner decision, 2026-08-17): auto-provisioning a
# chat the moment the bot is added to it was considered and rejected --
# one accidental add-to-5-groups turns a single-owner install into an
# unbounded multi-tenant one with no consent step, which is a much bigger
# feature (and a much bigger security surface) than this installer takes
# on. A supergroup is opt-in, one at a time, entered by hand; anyone who
# wants real auto-provisioning can build it on top.
read -rp "Also connect a Telegram supergroup for topic-based chat? Add the bot to the group, message inside it, and paste the id a bot like @userinfobot shows there (or leave empty to skip): " OWNER_SUPERGROUP_CHAT_ID
# Normalize: Telegram's Bot API always represents a supergroup (and
# channel) chat_id as -100<internal id>, but that's an API-layer detail,
# not something the person pasting a number from @userinfobot should have
# to know or type (owner: "нужно сделать так, чтобы в id группы -100
# вставало автоматически", 2026-08-17). Strip a leading "-" if present,
# then strip a leading "100" if present, then always rebuild as
# "-100<remainder>" -- idempotent and handles every input shape
# (bare digits, "-100<id>", or just "-<id>" with the "100" forgotten,
# which owner caught (2026-08-17): a plain minus with no "100" is NOT a
# valid supergroup id and the old logic silently left it broken).
if [ -n "$OWNER_SUPERGROUP_CHAT_ID" ]; then
  OWNER_SUPERGROUP_CHAT_ID="${OWNER_SUPERGROUP_CHAT_ID#-}"
  OWNER_SUPERGROUP_CHAT_ID="${OWNER_SUPERGROUP_CHAT_ID#100}"
  OWNER_SUPERGROUP_CHAT_ID="-100${OWNER_SUPERGROUP_CHAT_ID}"
  log "supergroup chat_id normalized to ${OWNER_SUPERGROUP_CHAT_ID}"
fi

# ---------------------------------------------------------------------
# Step 5/7: generate config, install app trees
# ---------------------------------------------------------------------
step "5/7 writing config + installing app trees"
mkdir -p "$CONFIG_ROOT" "$VAULT_ROOT" "$WORKSPACES_ROOT" "$INSTALL_ROOT"

# Reuse already-generated secrets on a re-run instead of blindly generating
# fresh ones every time: Postgres only honours POSTGRES_PASSWORD on first
# init of an empty data directory, so regenerating PG_PASSWORD on a second
# run (retrying after a failure, or a future --upgrade) silently desyncs
# the config from the already-initialized DB role -- auth then fails with
# no indication why. Same idea for the two webhook/owner tokens: nothing
# forces them to rotate on a re-run, and rotating them invalidates any
# already-issued in-flight state for no reason.
reuse_or_generate() {
  # $1 = existing env file to check, $2 = var name, $3 = openssl arg for a fresh value
  local file="$1" var="$2" bits="$3" existing
  if [ -f "$file" ]; then
    existing="$(grep -m1 "^${var}=" "$file" | cut -d= -f2-)"
    if [ -n "$existing" ]; then
      printf '%s' "$existing"
      return
    fi
  fi
  openssl rand -hex "$bits"
}
PG_PASSWORD="$(reuse_or_generate "$CONFIG_ROOT/officeagent.env" PG_PASSWORD 24)"
TELEGRAM_WEBHOOK_TOKEN="$(reuse_or_generate "$CONFIG_ROOT/bot.env" TELEGRAM_WEBHOOK_TOKEN 32)"
OFFICEAGENT_OWNER_TOKEN="$(reuse_or_generate "$CONFIG_ROOT/bot.env" OFFICEAGENT_OWNER_TOKEN 32)"

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

# A bot token is always "<numeric bot id>:<rest>" -- the config schema
# requires bot_id (via TELEGRAM_EXPECTED_BOT_ID) as a separate field rather
# than parsing it out of the token itself at runtime, so extract it here
# instead of asking a 6th interactive question for a value the token
# already contains.
TELEGRAM_EXPECTED_BOT_ID="${TELEGRAM_BOT_TOKEN%%:*}"

cat > "$CONFIG_ROOT/bot.env" <<EOF
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_EXPECTED_BOT_ID=${TELEGRAM_EXPECTED_BOT_ID}
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
DEFAULT_MODEL_TARGET=${DEFAULT_MODEL_TARGET}
TELEGRAM_MULTICHAT_ENABLED=1
TELEGRAM_MULTICHAT_WORKSPACE_DIR=${WORKSPACES_ROOT}
TELEGRAM_MASTER_PANE_TARGET=officeagent-bot
TELEGRAM_MASTER_PANE_SERVER_NAME=officeagent-channel
TELEGRAM_PERMISSION_GATE_ENABLED=1
TELEGRAM_STATUS_ENABLED=1
EOF
chmod 0600 "$CONFIG_ROOT/bot.env"

# Multichat bootstrap: policy.yaml (every chat_id the router will accept
# MUST have an explicit entry -- no wildcard fallback, unlisted chats are
# denied) + the owner's own DM chat_id as the one pre-registered chat, so
# a fresh install can be messaged directly with no supergroup/topics setup
# required first. A supergroup is opt-in via the question above -- when
# given, its chat_id gets a second `chats:` entry here (respond_to_all, so
# the owner doesn't have to @mention the bot inside their own group; NOT
# topics_only, so the General topic works too, not just dedicated topics).
# Per-topic forum thread ids (`<chat_id>_t<thread_id>`) still are NOT
# auto-provisioned (dynamic per-topic provisioning, still a TODO -- see
# README "Status") -- adding a topic means adding its own entry here by
# hand and restarting officeagent-bot, same as before.
mkdir -p "$WORKSPACES_ROOT/chats" "$WORKSPACES_ROOT/chats/${OWNER_TELEGRAM_USER_ID}"
cat > "$WORKSPACES_ROOT/chats/policy.yaml" <<EOF
version: 1
allowlist:
  chats:
    - "${OWNER_TELEGRAM_USER_ID}"
EOF
if [ -n "$OWNER_SUPERGROUP_CHAT_ID" ]; then
  echo "    - \"${OWNER_SUPERGROUP_CHAT_ID}\"" >> "$WORKSPACES_ROOT/chats/policy.yaml"
fi
cat >> "$WORKSPACES_ROOT/chats/policy.yaml" <<EOF
  users:
    - "${OWNER_TELEGRAM_USER_ID}"
mention_allowlist: []
chats:
  "${OWNER_TELEGRAM_USER_ID}":
    mode: private
    streaming: off
    edit_message_progress: false
    delivery: final_only
    persona_file: persona.md
    handoff_file: handoff.md
    system_reminder: ""
    respond_to_all: true
    topics_only: false
EOF
if [ -n "$OWNER_SUPERGROUP_CHAT_ID" ]; then
  mkdir -p "$WORKSPACES_ROOT/chats/${OWNER_SUPERGROUP_CHAT_ID}"
  cat >> "$WORKSPACES_ROOT/chats/policy.yaml" <<EOF
  "${OWNER_SUPERGROUP_CHAT_ID}":
    mode: public
    streaming: off
    edit_message_progress: false
    delivery: final_only
    persona_file: persona.md
    handoff_file: handoff.md
    system_reminder: ""
    respond_to_all: true
    topics_only: false
EOF
  cat > "$WORKSPACES_ROOT/chats/${OWNER_SUPERGROUP_CHAT_ID}/persona.md" <<'EOF'
# OfficeAgent

You are OfficeAgent, a Telegram-based assistant running on the owner's own
server, talking in a supergroup the owner added you to. Reply in whatever
language the group writes to you in. You have Bash/Read/Write/Edit tools
scoped to your own workspace, and MCP tools for persistent memory
(gbrain-memory / gbrain-recall) -- use `remember`-style tools when told
something worth keeping across sessions, and recall before assuming you
don't already know something.
EOF
  touch "$WORKSPACES_ROOT/chats/${OWNER_SUPERGROUP_CHAT_ID}/handoff.md"
  log "supergroup ${OWNER_SUPERGROUP_CHAT_ID} registered -- message it directly, no @mention needed (respond_to_all)"
fi
cat > "$WORKSPACES_ROOT/chats/${OWNER_TELEGRAM_USER_ID}/persona.md" <<'EOF'
# OfficeAgent

You are OfficeAgent, a Telegram-based assistant running on the owner's own
server. Reply in whatever language the owner writes to you in. You have
Bash/Read/Write/Edit tools scoped to your own workspace, and MCP tools for
persistent memory (gbrain-memory / gbrain-recall) -- use `remember`-style
tools when the owner tells you something worth keeping across sessions, and
recall before assuming you don't already know something.
EOF
touch "$WORKSPACES_ROOT/chats/${OWNER_TELEGRAM_USER_ID}/handoff.md"
chown -R officeagent:officeagent "$WORKSPACES_ROOT"

rsync -a --delete "$REPO_ROOT/gbrain/" "$INSTALL_ROOT/gbrain/" --exclude .venv --exclude __pycache__ --exclude .model-cache
rsync -a --delete "$REPO_ROOT/bot/" "$INSTALL_ROOT/bot/" --exclude node_modules --exclude /state
rsync -a --delete "$REPO_ROOT/templates/" "$INSTALL_ROOT/templates/"
rsync -a --delete "$REPO_ROOT/skills/" "$INSTALL_ROOT/skills/"
cp "$REPO_ROOT/docker-compose.yml" "$INSTALL_ROOT/docker-compose.yml"

# Per-chat (group/topic) session runtime (2026-08-17, found live testing a
# supergroup): TmuxSessionPool.spawnInternal() runs claude through
# {chatsBasePath}/hooks/multichat-entrypoint.sh INSTEAD of a bare `claude`
# -- that script is what actually applies --model/ANTHROPIC_BASE_URL for
# DEFAULT_MODEL_TARGET=alt, auto-accepts the Bypass Permissions dialog (no
# human is ever at a topic session's terminal to answer it), and runs the
# inbox-watcher that feeds inbound messages into the pane. None of this was
# being deployed -- TmuxSessionPool checks for the file at exactly this
# path and silently falls back to a bare `claude` (no flags, no model, no
# watcher) when it's missing, which is indistinguishable from "spawned
# fine" until you look at the pane and find it stuck on Anthropic's own
# trust dialog, unable to do anything at all.
mkdir -p "$WORKSPACES_ROOT/chats/hooks" "$WORKSPACES_ROOT/chats/.claude"
cp "$INSTALL_ROOT/bot/src/chats/hooks/multichat-entrypoint.sh" \
  "$INSTALL_ROOT/bot/src/chats/hooks/pre-tool-use.sh" \
  "$INSTALL_ROOT/bot/src/chats/hooks/session-start.sh" \
  "$INSTALL_ROOT/bot/src/chats/hooks/stop-to-outbox.py" \
  "$WORKSPACES_ROOT/chats/hooks/"
chmod 0755 "$WORKSPACES_ROOT/chats/hooks/"*.sh "$WORKSPACES_ROOT/chats/hooks/"*.py
# Hooks registration mirrors our own production per-chat settings.json
# exactly -- unlike the master session's
# settings.json, these commands need no TELEGRAM_HOOK_*/bearer-token
# env-prefixing: the hooks read CHAT_ID/MULTICHAT_STATE_DIR/etc. straight
# from the process environment multichat-entrypoint.sh already exported.
cat > "$WORKSPACES_ROOT/chats/.claude/settings.json" <<EOF
{
  "hooks": {
    "PreToolUse": [{"matcher":".*","hooks":[{"type":"command","command":"${WORKSPACES_ROOT}/chats/hooks/pre-tool-use.sh"}]}],
    "SessionStart": [{"hooks":[{"type":"command","command":"${WORKSPACES_ROOT}/chats/hooks/session-start.sh"}]}],
    "Stop": [{"hooks":[{"type":"command","command":"${WORKSPACES_ROOT}/chats/hooks/stop-to-outbox.py"}]}]
  }
}
EOF

# Same trust-dialog seeding as Step 3 (see there for the full "why"), for
# the SECOND project path claude ever launches in: multichat-entrypoint.sh
# runs with cwd=$WORKSPACES_ROOT/chats (C4, tmux-session-pool.ts), a
# completely different path from the master session's $INSTALL_ROOT/bot --
# seeding one does not seed the other, and every group/topic spawn is
# headless (no human to click through the dialog).
if [ -f /home/officeagent/.claude.json ]; then
  python3 - "$WORKSPACES_ROOT/chats" <<'PYEOF'
import json, sys
path = "/home/officeagent/.claude.json"
with open(path) as f:
    data = json.load(f)
data.setdefault("projects", {})[sys.argv[1]] = {
    "hasTrustDialogAccepted": True,
    "hasCompletedProjectOnboarding": True,
    "projectOnboardingSeenCount": 1,
}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PYEOF
fi

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

# Default permission-gate policy (2026-08-16, found live on a GLM-primary
# trial install): without an explicit policy.yaml, permission-gate-hook.ts
# falls back to FALLBACK_POLICY = {default_tier: 'confirm'} -- confirm on
# EVERY mutating tool call, including `reply` itself. Combined with
# permission_gate.enabled defaulting to false (below), that hook was
# reachable, found no policy, tried to confirm, hit the disabled relay
# (HTTP 503), and fail-closed to permanent deny -- the master session could
# receive a DM (pane-inject) but could never answer it, on ANY backend, not
# just GLM. Ported from our own production template:
# default_tier=allow (a
# bypassPermissions session should just work for ordinary tool use),
# confirm only on genuinely risky bash patterns (relayed to Telegram as an
# Allow/Deny button), hard-deny on secrets/destructive git with no button
# at all. MCP tools (reply/react/edit_message/...) aren't bash patterns, so
# they fall to default_tier=allow and are never gated.
cat > "$INSTALL_ROOT/bot/permission-policy.yaml" <<'EOF'
# Permission gate (bypassPermissions session). Built-in hard-deny (secrets,
# rm -rf /, mkfs) and built-in confirm (sudo, git push, docker, package
# installs) always apply on top of this file.
version: 1
default_tier: allow
confirm:
  bash_patterns: ["systemctl restart", "systemctl stop", "docker "]
confirm_overrides:
  builtin_rules:
    - "git push"
deny:
  read_paths:
    - "**/*.token"
    - "**/token.txt"
    - "**/*.pem"
    - "**/*.p12"
    - "**/*.pfx"
    - "**/credentials.json"
    - "**/*.credentials.json"
    - "**/secrets/**"
    - "**/.ssh/**"
    - "**/*.env"
  bash_patterns:
    - "git push --force"
    - "git push -f"
    - "git push --delete"
    - "git push -d "
    - "push origin :"
    - "gh repo delete"
    - "gh repo archive"
    - "gh api -x delete"
EOF
chown officeagent:officeagent "$INSTALL_ROOT/bot/permission-policy.yaml"
chmod 0644 "$INSTALL_ROOT/bot/permission-policy.yaml"

# Master-session hooks (2026-08-16, critic MF-2/PR#0): without this, a fresh
# install has NO outgoing DM path at all, on ANY backend (Anthropic or GLM) --
# .mcp.json alone registers the officeagent-channel tools, but SessionStart/
# Stop/PreToolUse hooks (fallback-reply, read-receipt, permission-gate) are
# what actually wire replies/permissions to Telegram. install-hooks.sh writes
# these into the master session's OWN settings.json (its workspace is
# $INSTALL_ROOT/bot, matching WorkingDirectory= in the systemd unit) --
# --agent-id MUST be officeagent-channel, matching .mcp.json's key.
# --policy-path points PreToolUse at the file just written above -- without
# it the hook falls back to its workspace-relative default, which doesn't
# exist on a fresh install either.
bash "$INSTALL_ROOT/bot/scripts/install-hooks.sh" \
  --settings "$INSTALL_ROOT/bot/.claude/settings.json" \
  --chat-id "$OWNER_TELEGRAM_USER_ID" \
  --webhook-url "http://127.0.0.1:8093/hooks/agent" \
  --agent-id officeagent-channel \
  --permission-gate \
  --policy-path "$INSTALL_ROOT/bot/permission-policy.yaml"
chown -R officeagent:officeagent "$INSTALL_ROOT/bot/.claude"

# ---------------------------------------------------------------------
# Step 6/7: start Postgres, run migrations
# ---------------------------------------------------------------------
step "6/7 starting Postgres + applying migrations"
(cd "$INSTALL_ROOT" && docker compose --env-file "$CONFIG_ROOT/officeagent.env" up -d db)
# The official postgres image, on a genuinely first-ever start (fresh empty
# volume), runs its own internal restart cycle: initdb -> temporary startup
# to execute init scripts -> shutdown -> final startup. `pg_isready` can
# return success for a moment during that temporary startup, right before
# the shutdown -- a client that connects in that exact window gets "FATAL:
# the database system is shutting down" (found the hard way testing a
# from-scratch install, not on a re-run against an already-initialized
# volume, which is why earlier iterative testing never hit this). Require
# 3 consecutive successful checks, not just one, before trusting readiness.
ready_streak=0
for i in $(seq 1 60); do
  if docker exec officeagent-db pg_isready -U officeagent -d officeagent >/dev/null 2>&1; then
    ready_streak=$((ready_streak + 1))
    [ "$ready_streak" -ge 3 ] && break
  else
    ready_streak=0
  fi
  sleep 1
done
# Belt-and-suspenders: retry the actual DDL too, in case the 3-in-a-row
# check still raced the internal restart on a slow disk.
for i in $(seq 1 10); do
  docker exec officeagent-db psql -U officeagent -d officeagent -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 && break
  sleep 2
done

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
# `enable --now` only STARTS a unit that isn't running yet -- on a re-run
# (retrying after a fix, or a future upgrade) where the unit is already
# active (or crash-looping under Restart=), it is a no-op and silently
# leaves the OLD unit definition (and old code, if bot/gbrain changed)
# running. `restart` starts a not-yet-running unit exactly like `start`
# would, so it is always the right call here, not just the already-active
# case -- every re-run of this script picks up whatever changed.
for unit in officeagent-db officeagent-gbrain officeagent-bot; do
  systemctl enable "${unit}.service" >/dev/null
  systemctl restart "${unit}.service"
  sleep 3
done

log ""
log "Install complete. Check status with:"
log "  systemctl status officeagent-db officeagent-gbrain officeagent-bot"
log "  journalctl -u officeagent-bot -f"
log ""
log "Message your bot on Telegram to confirm it responds."
