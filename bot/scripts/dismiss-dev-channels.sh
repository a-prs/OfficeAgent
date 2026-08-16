#!/usr/bin/env bash
# dismiss-dev-channels.sh — OUT-OF-PANE dismissal of the
# --dangerously-load-development-channels warning.
#
# WHY THIS EXISTS:
# `claude --dangerously-load-development-channels server:<channel-name>` is
# how the bot's own channel plugin gets loaded into the master tmux pane's
# `claude` process (see docs/architecture.md). It shows an interactive
# "1. I am using this for local development / 2. Exit" confirmation every
# time a FRESH process boots. model-switch.ts respawns the pane
# (`tmux respawn-pane -k`) to swap model/backends — that kills the current
# `claude` process AND its child processes.
#
# The channel plugin's server.ts (bun ./src/server.ts) is one of those
# children (PPid == claude). Polling+dismissing the prompt from INSIDE
# server.ts doesn't work: respawn-pane kills server.ts the instant it
# triggers the respawn, so any in-process dismissal code dies before it can
# ever press Enter — the pane then sits on the warning until a human
# presses Enter by hand.
#
# This script is invoked by model-switch.ts as a DETACHED, unref'd
# subprocess (setsid), so it is reparented to init and survives the pane's
# death. It polls the pane content and presses Enter the moment the warning
# actually renders, then confirms the composer is ready. Same poll-for-text
# pattern as multichat-entrypoint.sh's wait_claude_ready / accept_bypass_gate
# — no blind sleeps.
#
# Usage:
#   setsid dismiss-dev-channels.sh <paneTarget> [socketName]
#
# Output goes to a log file (state dir) so the switch is diagnosable; the
# caller does NOT wait on it (detached fire-and-forget).
set -u

PANE_TARGET="${1:?dismiss-dev-channels.sh: missing paneTarget}"
SOCKET_NAME="${2:-}"

tmux_cmd=(tmux)
[[ -n "$SOCKET_NAME" ]] && tmux_cmd+=(-L "$SOCKET_NAME")

# MULTICHAT_STATE_DIR / OFFICEAGENT_STATE_DIR are the two places a running
# instance is expected to export state root from; fall back to /tmp so this
# never fails hard just because logging has nowhere to write.
LOG_FILE="${MULTICHAT_STATE_DIR:-${OFFICEAGENT_STATE_DIR:-/tmp}}/model-switch-dismiss.log"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

capture() { "${tmux_cmd[@]}" capture-pane -t "$PANE_TARGET" -p 2>/dev/null || true; }

log "start: pane=$PANE_TARGET socket=${SOCKET_NAME:-default}"

POLL_INTERVAL=0.5
MAX_POLLS=40   # 20s budget — generous for a loaded host, still bounded
DISMISSED=0

for ((i = 0; i < MAX_POLLS; i++)); do
  snap="$(capture)"
  if grep -qi 'I am using this for local development' <<<"$snap"; then
    "${tmux_cmd[@]}" send-keys -t "$PANE_TARGET" Enter 2>/dev/null || true
    DISMISSED=1
    log "dismissed dev-channels prompt (waited ${i}*${POLL_INTERVAL}s)"
    break
  fi
  # Composer already up and no warning → nothing to do (e.g. trusted state
  # or a target that does not load dev channels).
  if grep -q '❯' <<<"$snap" \
      && ! grep -qi 'I am using this for local development' <<<"$snap"; then
    log "composer ready, no dev-channels prompt seen (waited ${i}*${POLL_INTERVAL}s) — nothing to dismiss"
    exit 0
  fi
  sleep "$POLL_INTERVAL"
done

if [[ "$DISMISSED" -ne 1 ]]; then
  log "WARN: dev-channels prompt never appeared within budget — pane may need manual Enter"
  exit 0
fi

# Confirm the Enter landed: composer visible, dialog gone. Logs a WARN if
# it never settles rather than silently assuming success.
for ((i = 0; i < MAX_POLLS; i++)); do
  snap="$(capture)"
  if grep -q '❯' <<<"$snap" \
      && ! grep -qi 'I am using this for local development' <<<"$snap"; then
    log "pane confirmed ready post-dismiss"
    exit 0
  fi
  sleep "$POLL_INTERVAL"
done

log "WARN: pane did not reach ready state after dismiss"
exit 0
