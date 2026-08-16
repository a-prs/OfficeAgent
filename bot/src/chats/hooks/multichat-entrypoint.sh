#!/usr/bin/env bash
# multichat-entrypoint.sh — tmux session entrypoint for per-chat `claude`.
#
# Spawned by TmuxSessionPool.spawnInternal() instead of `claude` directly.
# Responsibilities:
#   1. Start a background inbox-watcher that polls (or inotifywait-watches)
#      ${MULTICHAT_STATE_DIR}/chats/${CHAT_ID}/inbox/ for new *.json files.
#   2. For each committed JSON: parse text + reply_context + media_paths,
#      build a single prompt string, and inject it into the tmux pane as a
#      bracketed paste (`tmux load-buffer` + `paste-buffer -p`) followed by
#      a VERIFIED Enter — see "Submit reliability" below.
#   3. Move processed files to inbox/.processed/ so the watcher does not
#      reprocess on the next pass.
#   4. exec claude in the foreground so the pane runs the interactive REPL
#      while the background watcher feeds it inbound messages.
#
# Submit reliability (FIX 2026-06-05): the original implementation used
# `send-keys -l "$text"` + `sleep 0.05` + `send-keys Enter`. Two failure
# mechanisms were observed in production (first message of a fresh spawn
# sat un-submitted in the composer until a human pressed Enter):
#   a) First-spawn race — the watcher's initial drain fires while the
#      Claude Code TUI is still booting (banner render, MCP loading), so
#      the trailing Enter lands before the input keymap is mounted.
#   b) Paste-burst grouping — the TUI groups a rapid keystroke burst as a
#      paste; an Enter 50ms behind a multi-line literal is swallowed into
#      the group as a soft newline instead of submitting.
# Countermeasures, in order: readiness gate (poll for the composer prompt
# before first injection), bracketed paste for the body (atomic — never
# grouped with later keys), a paste→submit separation pause, and an
# Enter-only verify loop (re-sends ONLY Enter, never the body, so a
# false "not submitted" reading can never duplicate the message).
#
# Fail-safe behaviour:
#   * CHAT_ID or MULTICHAT_STATE_DIR missing -> exit 2 (refuse to start).
#     This prevents a misconfigured spawn from running a stray master
#     claude with no chat isolation.
#   * TMUX_PANE missing (we are not inside tmux) -> watcher self-disables,
#     but claude still launches so the operator can attach and recover.
#   * python3 / json parse failure on a single file -> log to stderr,
#     skip the file (do NOT move to .processed/ — operator can retry).
#   * Submit unconfirmed after all retries -> the file is moved to
#     .processed/ with a `submit-unconfirmed-` prefix (NOT requeued: the
#     body already sits in the composer, so a re-paste would duplicate
#     it; the next inbound message's Enter flushes the stuck composer).
#
# Concurrency note: the watcher runs as a subshell in the background.
# `trap ... EXIT` ensures we tear it down when claude exits so we do not
# leak watchers across tmux restarts.

set -euo pipefail

# ───── Tunables (env-overridable; tests set tiny values) ─────
# Seconds between TUI-readiness polls, and max polls before giving up
# and injecting anyway (degraded mode = old fixed-sleep behaviour).
READY_POLL_INTERVAL="${MULTICHAT_READY_POLL_INTERVAL:-0.5}"
READY_POLL_MAX="${MULTICHAT_READY_POLL_MAX:-60}"
# Pause between the bracketed paste and the first Enter — must outlast
# the TUI's paste-burst detection window.
PASTE_SETTLE="${MULTICHAT_PASTE_SETTLE:-0.6}"
# Verify-loop: initial post-Enter wait, growth factor applied per retry,
# and total attempts.
SUBMIT_RETRY_DELAY="${MULTICHAT_SUBMIT_RETRY_DELAY:-0.4}"
SUBMIT_RETRY_FACTOR="${MULTICHAT_SUBMIT_RETRY_FACTOR:-1.8}"
SUBMIT_RETRY_MAX="${MULTICHAT_SUBMIT_RETRY_MAX:-5}"
# Poll budget for a raw slash-command (currently just /compact) to settle
# back to an idle composer. A full-transcript compaction is effectively an
# LLM call over the whole conversation, so this is much longer than the
# normal submit-verify retry loop above.
RAW_COMMAND_POLL_MAX="${MULTICHAT_RAW_COMMAND_POLL_MAX:-180}"

# ───── Injection helpers ─────
# All helpers read $PANE (the target tmux pane id) as a global set by the
# watcher subshell. Defined at top level so a test harness can source
# this file (MULTICHAT_ENTRYPOINT_TEST_ONLY=1) and exercise them with a
# stub `tmux` on PATH.

# Plain-text snapshot of the VISIBLE pane only. -p strips attributes,
# -J rejoins wrapped lines (so fingerprints survive narrow panes). We
# deliberately do NOT pass -S: Claude Code's TUI scrolls (no alternate
# screen), so pane history contains stale frames — an old generating
# footer ("esc to interrupt") in scrollback would read as a false
# submit-success. The composer always sits in the visible region.
pane_text() {
  tmux capture-pane -t "$PANE" -p -J 2>/dev/null || true
}

# Screens where the watcher must NOT touch the pane — any injected key
# (Enter, paste, digit) advances state we cannot safely recover from
# headless. Observed 2026-07-08: hitting the Max-subscription session
# limit mid pre-kill /compact left a topic on the CLI's own OAuth relogin
# screen; wait_claude_ready's old "timeout, inject anyway" fallback then
# fed Enter into the empty device-code field, producing a wedged
# "Invalid code" loop that only a manual `tmux kill-session` recovered
# from. Treat these as terminal for the current watcher action instead.
pane_is_stuck() {
  grep -qiE 'OAuth error|session limit|Upgrade your plan' <<<"$1"
}

# Block until the Claude Code composer is accepting input. The composer
# renders a `❯` prompt char once the input handler is mounted; the boot
# banner does not contain one. On timeout we proceed anyway — worst case
# we degrade to the pre-fix behaviour instead of dropping the message.
# Returns 1 (never "inject anyway") when the pane is on a limit/login
# screen instead — callers must bail rather than paste/send-keys into it.
wait_claude_ready() {
  local i snap
  for ((i = 0; i < READY_POLL_MAX; i++)); do
    snap="$(pane_text)"
    if grep -q '❯' <<<"$snap"; then
      # The prompt can render a beat before the keymap is live; one more
      # poll interval of settle keeps the first Enter from racing it.
      sleep "$READY_POLL_INTERVAL"
      return 0
    fi
    if pane_is_stuck "$snap"; then
      echo "multichat-entrypoint(watcher): pane stuck on limit/login screen, refusing to inject" >&2
      return 1
    fi
    sleep "$READY_POLL_INTERVAL"
  done
  echo "multichat-entrypoint(watcher): TUI readiness timeout, injecting anyway" >&2
  return 0
}

# Auto-accept the one-time "Bypass Permissions mode" confirmation screen.
# Topic sessions launch with --permission-mode bypassPermissions and there is
# NO supported flag/setting to pre-accept the warning (confirmed against Claude
# Code docs 2026-06-18), so a fresh spawn hangs on the screen until a human
# presses "2. Yes, I accept" — and any inbound message injected before that is
# swallowed by the screen. There is no human at the pane, so the watcher
# accepts it programmatically. SAFE: this clears only the UX guard; the real
# security gate is the PreToolUse hook (pre-tool-use.sh enforcing policy.yaml
# deny), which still runs in bypass mode. No-op when the screen is absent
# (default mode / already accepted) — we bail the instant the composer ❯ shows.
accept_bypass_gate() {
  local i snap
  for ((i = 0; i < READY_POLL_MAX; i++)); do
    snap="$(pane_text)"
    if grep -q '❯' <<<"$snap"; then
      return 0
    fi
    if grep -qi 'Bypass Permissions mode' <<<"$snap" \
        && grep -qi 'Yes, I accept' <<<"$snap"; then
      tmux send-keys -t "$PANE" "2" 2>/dev/null || true
      sleep 0.2
      tmux send-keys -t "$PANE" Enter 2>/dev/null || true
      return 0
    fi
    sleep "$READY_POLL_INTERVAL"
  done
  return 0
}

# A distinctive substring of the prompt used to judge "still sitting in
# the composer". Heuristic only: a false "still there" costs one extra
# Enter on an idle composer, which is harmless. python3 (already a hard
# dependency via build_prompt) keeps the 60-char truncation UTF-8-safe —
# byte-oriented `cut -c` would split multibyte Russian text and produce
# a pattern that can never match the pane.
prompt_fingerprint() {
  printf '%s' "$1" | python3 -c '
import sys
for line in sys.stdin.read().splitlines():
    line = line.strip()
    if len(line) >= 4:
        sys.stdout.write(line[:60])
        break
' || true
}

# Paste the body, then press Enter until the turn provably started.
# Success signals:
#   * footer shows "esc to interrupt" AND generation was NOT already
#     running before our paste — a pre-existing turn would read as a
#     false success, so when one is in flight we fall back to the
#     fingerprint signal only (Claude Code queues submits made during
#     generation, so pasting immediately is still correct);
#   * the fingerprint vanished from the pane — composer cleared (covers
#     turns that finish faster than our poll, and queued submits).
# The body is pasted exactly once; only Enter is ever retried, so a
# false "not submitted" reading can never duplicate the message.
submit_prompt() {
  local msg_text="$1"
  local fp attempt delay buf out pre_generating
  fp="$(prompt_fingerprint "$msg_text")"

  wait_claude_ready || return 1

  pre_generating=0
  if pane_text | grep -qiE 'esc to interrupt'; then
    pre_generating=1
  fi

  # Bracketed paste: the TUI receives one atomic paste event, so embedded
  # newlines stay soft newlines and the later Enter can never be grouped
  # into the paste. printf (not heredoc/<<<) avoids a trailing newline.
  # Explicit `|| return 1` on each tmux op: these run with errexit
  # suppressed (callers invoke us in `if` context), and a silently failed
  # paste would otherwise read as "fingerprint vanished" = false success
  # — losing the message entirely.
  buf="multichat-${CHAT_ID}-$$"
  printf '%s' "$msg_text" | tmux load-buffer -b "$buf" - || {
    echo "multichat-entrypoint(watcher): load-buffer failed" >&2
    return 1
  }
  tmux paste-buffer -d -t "$PANE" -b "$buf" -p || {
    echo "multichat-entrypoint(watcher): paste-buffer failed" >&2
    return 1
  }

  sleep "$PASTE_SETTLE"

  delay="$SUBMIT_RETRY_DELAY"
  for ((attempt = 1; attempt <= SUBMIT_RETRY_MAX; attempt++)); do
    tmux send-keys -t "$PANE" Enter || true
    sleep "$delay"

    out="$(pane_text)"
    if [[ "$pre_generating" == "0" ]] \
        && grep -qiE 'esc to interrupt' <<<"$out"; then
      return 0
    fi
    if [[ -n "$fp" ]] && ! grep -qF -- "$fp" <<<"$out"; then
      return 0
    fi
    if [[ -z "$fp" ]]; then
      # Nothing to verify against (empty/whitespace-only body) — assume
      # the Enter landed. Degraded path, equals the pre-fix behaviour.
      return 0
    fi

    delay="$(awk -v d="$delay" -v f="$SUBMIT_RETRY_FACTOR" \
      'BEGIN { printf "%.2f", d * f }')"
  done

  echo "multichat-entrypoint(watcher): submit not confirmed after ${SUBMIT_RETRY_MAX} attempts" >&2
  return 1
}

# Submit a literal CLI slash-command (currently only "/compact") with NO
# wrapping — used exclusively for the pre-kill maintenance directive
# (multichat-router.ts's gracefulPreKillCompact), never for chat content.
# submit_prompt's success heuristic is built around normal turn generation
# ("esc to interrupt" footer / fingerprint clearing); a slash command's own
# output shape is not guaranteed, so instead we wait for the composer to
# leave idle (command started) and then return to idle (command finished)
# — true for any completed CLI-level action regardless of what it prints.
submit_raw_command() {
  local cmd_text="$1" buf i out
  wait_claude_ready || return 1

  buf="multichat-raw-${CHAT_ID}-$$"
  printf '%s' "$cmd_text" | tmux load-buffer -b "$buf" - || {
    echo "multichat-entrypoint(watcher): raw command load-buffer failed" >&2
    return 1
  }
  tmux paste-buffer -d -t "$PANE" -b "$buf" -p || {
    echo "multichat-entrypoint(watcher): raw command paste-buffer failed" >&2
    return 1
  }
  sleep "$PASTE_SETTLE"
  tmux send-keys -t "$PANE" Enter || true

  # Wait for it to leave idle (command accepted / started). Best-effort —
  # a command that never visibly leaves idle (e.g. nothing to compact)
  # still resolves in the settle-poll below once the timeout budget passes.
  for ((i = 0; i < READY_POLL_MAX; i++)); do
    if ! pane_text | grep -q '❯'; then
      break
    fi
    sleep "$READY_POLL_INTERVAL"
  done

  # Wait for it to finish (idle prompt back, no generation footer). Bail
  # immediately (no further keys) on a limit/login screen instead of
  # burning the full timeout — e.g. /compact erroring with "session
  # limit" mid-run (2026-07-08).
  for ((i = 0; i < RAW_COMMAND_POLL_MAX; i++)); do
    out="$(pane_text)"
    if grep -q '❯' <<<"$out" && ! grep -qiE 'esc to interrupt' <<<"$out"; then
      return 0
    fi
    if pane_is_stuck "$out"; then
      echo "multichat-entrypoint(watcher): raw command '${cmd_text}' hit limit/login screen, aborting" >&2
      return 1
    fi
    sleep "$READY_POLL_INTERVAL"
  done
  echo "multichat-entrypoint(watcher): raw command '${cmd_text}' did not settle in time" >&2
  return 1
}

# Parse one JSON file into a single prompt string. Reads the file path
# from $INBOX_FILE so nothing user-controlled is interpolated into shell.
build_prompt() {
  INBOX_FILE="$1" python3 - <<'PYEOF'
import json
import os
import sys

path = os.environ.get('INBOX_FILE', '')
try:
    with open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
except Exception as e:  # noqa: BLE001
    print(f'multichat-entrypoint(watcher): parse failed for {path}: {e}',
          file=sys.stderr)
    sys.exit(1)

if not isinstance(d, dict):
    print(f'multichat-entrypoint(watcher): {path} is not a JSON object',
          file=sys.stderr)
    sys.exit(1)

parts = []

reply_context = d.get('reply_context')
if isinstance(reply_context, str) and reply_context:
    parts.append(reply_context)

text = d.get('text', '') or ''
user = d.get('user', '') or ''
if user:
    parts.append(f'[from @{user}] {text}')
else:
    parts.append(text)

# Prefer the rendered <media .../> descriptor tags: they carry the voice
# transcript inline and the photo's local_path, identical to what the master
# DM session sees. Fall back to the legacy [media: path] rendering only when
# descriptors are absent (messages dispatched by the pre-fix plugin), so an
# in-flight inbox file written before the restart still surfaces its photos.
media_descriptors = d.get('media_descriptors') or []
have_descriptors = isinstance(media_descriptors, list) and any(
    isinstance(m, str) and m for m in media_descriptors
)
if have_descriptors:
    for m in media_descriptors:
        if isinstance(m, str) and m:
            parts.append(m)
else:
    media_paths = d.get('media_paths') or []
    if isinstance(media_paths, list):
        for p in media_paths:
            if isinstance(p, str) and p:
                parts.append(f'[media: {p}]')

# Two-newline join so the model sees explicit paragraph breaks between
# the reply context, the main text, and the media descriptors.
sys.stdout.write('\n\n'.join(parts))
PYEOF
}

# mv wrapper that survives a vanished source file instead of taking the
# whole watcher down. Observed 2026-07-10: an unguarded `mv "$f" ...` hit
# "No such file or directory" (source raced away between the `find` scan
# and the mv — cause not fully diagnosed, but plausibly a second concurrent
# drain touching the same file) under `set -e`, which killed the entire
# watcher subshell instantly — every message after that point piled up
# unprocessed in inbox/ with nothing left running to drain it, and the
# topic silently stopped responding until someone noticed and force-killed
# the tmux session. mv failures must never be fatal to the watcher loop.
safe_mv() {
  local src="$1" dst="$2"
  if ! mv "$src" "$dst" 2>&1; then
    echo "multichat-entrypoint(watcher): mv failed (src gone or race?) src=$src dst=$dst — watcher continues" >&2
  fi
}

# Drain every committed *.json in inbox/ (sorted = ms-time order).
# NOTE: We deliberately do NOT recurse into .processed/ — `find -maxdepth 1`
# plus the leading-dot exclusion handled by the *.json glob keeps us safe.
process_inbox() {
  local f msg_text kind cmd_text ack_path
  while IFS= read -r -d '' f; do
    [[ -f "$f" ]] || continue

    # Internal maintenance directive (2026-07-06): raw_command bypasses the
    # normal chat-message path entirely — submitted verbatim, and the
    # WATCHER (not the agent) touches ack_path once the pane settles, since
    # a CLI slash command has no agent turn/tool-call to hang an ack off of.
    kind="$(python3 -c 'import json,sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get("kind", "") if isinstance(d, dict) else "")
except Exception:
    print("")' "$f" 2>/dev/null || true)"
    if [[ "$kind" == "raw_command" ]]; then
      cmd_text="$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
print(d.get("text", ""))' "$f" 2>/dev/null || true)"
      ack_path="$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
print(d.get("ack_path", ""))' "$f" 2>/dev/null || true)"
      if [[ -n "$cmd_text" ]] && submit_raw_command "$cmd_text"; then
        [[ -n "$ack_path" ]] && { touch "$ack_path" 2>/dev/null || true; }
        safe_mv "$f" "${PROCESSED}/$(basename "$f")"
      else
        safe_mv "$f" "${PROCESSED}/raw-command-failed-$(basename "$f")"
      fi
      continue
    fi

    msg_text="$(build_prompt "$f" || true)"
    if [[ -n "$msg_text" ]]; then
      if submit_prompt "$msg_text"; then
        safe_mv "$f" "${PROCESSED}/$(basename "$f")"
      else
        # Body is in the composer but submit never confirmed. Do NOT
        # requeue (a re-paste would duplicate the message) — mark for
        # operator triage; the next message's Enter flushes the stuck
        # composer.
        safe_mv "$f" "${PROCESSED}/submit-unconfirmed-$(basename "$f")"
      fi
    else
      # Parse failed — leave the file in place for operator triage but
      # rename it so we don't spin on it.
      safe_mv "$f" "${PROCESSED}/parse-failed-$(basename "$f")"
    fi
  done < <(find "$INBOX" -maxdepth 1 -name '*.json' -print0 | sort -z)
}

# ───── Test seam ─────
# When sourced with MULTICHAT_ENTRYPOINT_TEST_ONLY=1 the file defines the
# helpers above and stops: no env validation, no watcher, no exec. Lets
# tests drive submit_prompt/process_inbox against a stub tmux.
if [[ "${MULTICHAT_ENTRYPOINT_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

# ───── Required env (fail-safe) ─────
if [[ -z "${CHAT_ID:-}" || -z "${MULTICHAT_STATE_DIR:-}" ]]; then
  echo "multichat-entrypoint: CHAT_ID or MULTICHAT_STATE_DIR not set, refusing to start" >&2
  exit 2
fi

INBOX="${MULTICHAT_STATE_DIR}/chats/${CHAT_ID}/inbox"
PROCESSED="${INBOX}/.processed"
mkdir -p "$INBOX" "$PROCESSED"

# ───── Background inbox watcher ─────
(
  # tmux exports TMUX_PANE inside every pane. Without it we cannot inject
  # — the watcher logs a warning and exits cleanly so claude still runs.
  PANE="${TMUX_PANE:-}"
  if [[ -z "$PANE" ]]; then
    echo "multichat-entrypoint(watcher): TMUX_PANE not set, watcher disabled" >&2
    exit 0
  fi

  # Clear the one-time bypassPermissions confirmation screen (if shown)
  # before draining — otherwise the first injected message is swallowed by
  # the screen and lost (observed on the prod supergroup's first topic).
  accept_bypass_gate

  # Initial drain catches any pending messages that arrived between
  # writeToInbox() and our exec — see PLAN.md H5 (spawn order fix).
  # submit_prompt's readiness gate handles the boot race (no fixed sleep).
  process_inbox

  # Watcher-leak guard (2026-06-05): `exec claude` below replaces the
  # entrypoint shell, so the EXIT trap never fires when claude exits and
  # this subshell would outlive the session — a leaked watcher targeting
  # a dead pane still MOVES inbox files, eating messages meant for the
  # chat's next spawn. $$ inside the subshell is the original entrypoint
  # PID (= claude after the exec); when it dies, we exit too.
  parent_alive() {
    kill -0 "$$" 2>/dev/null
  }

  # Prefer inotifywait when available; fall back to polling.
  if command -v inotifywait >/dev/null 2>&1; then
    # --include filters to *.json so we ignore .tmp writes mid-rename.
    while parent_alive \
        && inotifywait -q -e create,moved_to --include '\.json$' "$INBOX" \
        >/dev/null 2>&1; do
      sleep 0.1  # debounce — rename() is atomic but bursts can stack
      parent_alive || exit 0
      process_inbox
    done
  else
    # 500ms cadence matches the outbox poller's order of magnitude.
    while parent_alive; do
      sleep 0.5
      process_inbox
    done
  fi
) &
WATCHER_PID=$!

# Tear down the watcher when claude (or this script) exits. `kill -0` test
# avoids `kill: no such process` noise when the watcher already died.
cleanup() {
  if kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill "$WATCHER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Hand the pane over to claude. tmux runs us in the foreground process
# of the session; exec keeps claude as the leaf process so tmux's
# remain-on-exit semantics work as expected.
#
# Permission mode (2026-06-06): a multichat session has NO human at the
# terminal — the owner drives it over Telegram and cannot answer Claude
# Code's interactive permission prompts, so a default-mode session STALLS on
# the first gated tool call (every Bash/edit/MCP/network use). We run in
# bypassPermissions so the session is autonomous; the SECURITY GATE is the
# PreToolUse hook (chats/hooks/pre-tool-use.sh enforcing policy.yaml deny),
# which still blocks regardless of permission mode. The hook holds the iron
# limit (secrets / .env / keys / server creds / private profiles).
# Override with MULTICHAT_PERMISSION_MODE if a deployment needs a stricter mode.
# Pin a DETERMINISTIC session id per chat (uuid5 of the composite CHAT_ID).
# Two payoffs:
#   1. external tools (the dashboard feed) can map a tmux session -> its
#      transcript jsonl without guessing — the file is <id>.jsonl.
#   2. a topic that was reaped (idle-TTL) RESUMES its transcript instead of
#      starting blank, so topic memory survives the reap.
# `--session-id` refuses an id that already exists ("already in use"), so we
# resume when the transcript file is already present and create otherwise.
# Falls back to a plain launch if the id cannot be computed (degrades cleanly:
# the feed just uses its newest-transcript fallback).
#
# Model override (2026-07-30): model-switch.ts relaunches a topic pane
# through THIS script (instead of a bare `claude` invocation) so the
# inbox-watcher above restarts on every /model switch, not just on a fresh
# spawn. MULTICHAT_MODEL_OVERRIDE carries the target model name (e.g.
# glm-5.2) for the GLM direction; ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN
# arrive as ordinary env vars set by the caller's shell prefix, so plain
# inheritance through `exec` already handles those. Absent (Claude
# direction, or a caller that didn't set it) -> no --model flag, unchanged
# behaviour from before this fix.
model_args=()
if [[ -n "${MULTICHAT_MODEL_OVERRIDE:-}" ]]; then
  model_args=(--model "$MULTICHAT_MODEL_OVERRIDE")
fi
MULTICHAT_SESSION_ID="$(python3 -c 'import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, "multichat:"+sys.argv[1]))' "$CHAT_ID" 2>/dev/null || true)"
if [[ -n "$MULTICHAT_SESSION_ID" ]]; then
  _proj_dir="${HOME:-/home/$(id -un)}/.claude/projects/$(printf '%s' "$PWD" | sed 's#[/.]#-#g')"
  if [[ -f "${_proj_dir}/${MULTICHAT_SESSION_ID}.jsonl" ]]; then
    exec claude --resume "$MULTICHAT_SESSION_ID" --permission-mode "${MULTICHAT_PERMISSION_MODE:-bypassPermissions}" "${model_args[@]}"
  fi
  exec claude --session-id "$MULTICHAT_SESSION_ID" --permission-mode "${MULTICHAT_PERMISSION_MODE:-bypassPermissions}" "${model_args[@]}"
fi
exec claude --permission-mode "${MULTICHAT_PERMISSION_MODE:-bypassPermissions}" "${model_args[@]}"
