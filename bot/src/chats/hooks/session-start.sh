#!/usr/bin/env bash
# Claude Code SessionStart hook for multichat-agent-c.
#
# Reads $CHAT_ID (set by tmux-session-pool when spawning the session),
# loads {WORKSPACE}/chats/{CHAT_ID}/persona.md and the chat's
# system_reminder from {WORKSPACE}/chats/policy.yaml, and emits the
# Claude Code SessionStart hook JSON:
#   {"hookSpecificOutput":{"hookEventName":"SessionStart",
#                          "additionalContext":"<persona>\n\n---\n\n<reminder>"}}
#
# Failure modes (graceful degradation — do not block the session):
#   * CHAT_ID empty / unset      -> log to stderr, exit 0 (no injection).
#   * persona.md missing         -> log to stderr, emit degraded-mode
#                                   additionalContext warning so the
#                                   session sees that pre-tool-use will
#                                   deny every tool call until persona
#                                   is provisioned. Exit 0.
#   * policy.yaml unreadable     -> log to stderr, exit 0.
#   * python3 unavailable        -> log to stderr, exit 0.
#
# Injection-safety: persona content and policy reminder are read into
# files and loaded by python3 via env-passed paths. Nothing from those
# files is interpolated into shell. The JSON is built by json.dumps.

set -euo pipefail

# Sentinel: this hook is multichat-specific. If MULTICHAT_STATE_DIR is unset
# the hook is running outside a per-chat tmux session (e.g. accidentally
# registered into the master Agent-c workspace). Exit cleanly without emitting
# any additionalContext so the master session is not polluted with a chat
# persona it never asked for.
if [[ -z "${MULTICHAT_STATE_DIR:-}" ]]; then
  exit 0
fi

if [[ -z "${CHAT_ID:-}" ]]; then
  echo "session-start: CHAT_ID not set, skipping persona injection" >&2
  exit 0
fi

WORKSPACE="${CLAUDE_WORKSPACE_DIR:-${HOME}/.claude-lab/agent-c/.claude}"
POLICY_PATH="${WORKSPACE}/chats/policy.yaml"
CHAT_ID_BASE="${CHAT_ID%%_t*}"
PERSONA_PATH="${WORKSPACE}/chats/${CHAT_ID_BASE}/persona.md"

# Persistent-topic restore (2026-06-18): a forum-topic composite id
# (<base>_t<threadId>) is a long-lived per-project channel. Its session is
# disposable, so on every (re)spawn we re-inject the topic's durable memory
# — handoff.md (curated summary) + the tail of journal.md (rolling turn
# log) — so the bot picks the thread back up as if no time had passed. Both
# files live next to the chat dir, keyed by the COMPOSITE id.
IS_TOPIC=0
case "$CHAT_ID" in
  *_t[0-9]*) IS_TOPIC=1 ;;
esac
HANDOFF_PATH="${WORKSPACE}/chats/${CHAT_ID}/handoff.md"
JOURNAL_PATH="${WORKSPACE}/chats/${CHAT_ID}/journal.md"

# Claude Code pipes the SessionStart hook JSON on stdin; it carries a
# `source` field ("startup" | "resume" | "clear" | "compact"). We read it to
# detect a RESUMED topic session: the entrypoint resumes a reaped topic's
# transcript (--resume), so the full prior conversation is already in context
# — re-injecting the handoff + journal tail would just duplicate it. On
# resume we inject only a short upkeep reminder; on a fresh start we do the
# full restore. Guarded with `[ ! -t 0 ]` so a manual terminal run (no piped
# stdin) never blocks on cat.
HOOK_INPUT=""
if [[ ! -t 0 ]]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "session-start: python3 not available, skipping injection" >&2
  exit 0
fi

# Persona missing while running inside a multichat session is an
# operationally degraded state — the session will boot but every
# subsequent tool call will be denied by pre-tool-use.sh (fail-closed
# branch when policy lookup fails or persona context is absent). Emit
# an explicit additionalContext warning so the Claude session sees the
# degradation on startup and can route the next action (escalate to
# operator, refuse work, etc.) instead of plowing into a wall of denies.
if [[ ! -f "$PERSONA_PATH" ]]; then
  echo "session-start: persona file not found at ${PERSONA_PATH} — emitting degraded-mode warning" >&2
  CHAT_ID="$CHAT_ID" \
  PERSONA_PATH="$PERSONA_PATH" \
  python3 - <<'PYEOF'
import json
import os

chat_id = os.environ.get('CHAT_ID', '')
persona_path = os.environ.get('PERSONA_PATH', '')

warning = (
    f"⚠ Persona file missing for chat {chat_id}: {persona_path}. "
    "Multichat session running in degraded mode — tool calls will be "
    "denied by pre-tool-use until persona is provisioned."
)

payload = {
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': warning,
    }
}
print(json.dumps(payload, ensure_ascii=False))
PYEOF
  exit 0
fi

if [[ ! -f "$POLICY_PATH" ]]; then
  echo "session-start: policy file not found at ${POLICY_PATH}" >&2
  exit 0
fi

# Python loads persona + policy, emits SessionStart JSON. All paths
# arrive via env vars — no shell interpolation into the payload.
CHAT_ID="$CHAT_ID" \
POLICY_PATH="$POLICY_PATH" \
PERSONA_PATH="$PERSONA_PATH" \
IS_TOPIC="$IS_TOPIC" \
HANDOFF_PATH="$HANDOFF_PATH" \
JOURNAL_PATH="$JOURNAL_PATH" \
HOOK_INPUT="$HOOK_INPUT" \
python3 - <<'PYEOF'
import json
import os
import sys

chat_id = os.environ.get('CHAT_ID', '')
policy_path = os.environ.get('POLICY_PATH', '')
persona_path = os.environ.get('PERSONA_PATH', '')
is_topic = os.environ.get('IS_TOPIC', '0') == '1'
handoff_path = os.environ.get('HANDOFF_PATH', '')
journal_path = os.environ.get('JOURNAL_PATH', '')

# SessionStart source: "resume" means the entrypoint resumed this topic's
# transcript, so the prior conversation is already loaded — skip the bulky
# restore and inject only an upkeep reminder.
is_resume = False
try:
    _hook = json.loads(os.environ.get('HOOK_INPUT') or '{}') or {}
    is_resume = _hook.get('source') == 'resume'
except (ValueError, TypeError):
    is_resume = False

try:
    import yaml  # type: ignore
except ImportError:
    print('session-start: PyYAML not available, skipping reminder', file=sys.stderr)
    yaml = None

persona = ''
try:
    with open(persona_path, 'r', encoding='utf-8') as f:
        persona = f.read()
except OSError as e:
    print(f'session-start: persona read failed: {e}', file=sys.stderr)
    sys.exit(0)

reminder = ''
if yaml is not None:
    try:
        with open(policy_path, 'r', encoding='utf-8') as f:
            policy = yaml.safe_load(f) or {}
        chat_cfg = (policy.get('chats') or {}).get(chat_id) or {}
        reminder = chat_cfg.get('system_reminder') or ''
    except Exception as e:  # noqa: BLE001 — best-effort
        print(f'session-start: policy parse failed: {e}', file=sys.stderr)

parts = [persona.rstrip()]
if reminder:
    parts.append('---')
    parts.append(reminder.strip())

# Persistent-topic restore: re-inject the topic's durable memory so a fresh
# session continues the project seamlessly ("as if I stepped away for 5
# minutes"). handoff.md is the curated summary; journal.md is the rolling
# turn log — we take only its tail to bound the injected context. On a
# RESUMED session the transcript already holds the conversation, so we skip
# the dump and inject only a one-line upkeep reminder (hybrid with the
# entrypoint's --resume).
if is_topic and is_resume:
    parts.append('---')
    parts.append(
        'Топик-проект возобновлён из транскрипта — контекст уже загружен, '
        'продолжай с места. Не забывай переписывать сводку '
        f'{handoff_path} после значимых шагов (память на следующий день).'
    )
elif is_topic:
    handoff_txt = ''
    try:
        with open(handoff_path, 'r', encoding='utf-8') as f:
            handoff_txt = f.read().strip()
    except OSError:
        pass
    journal_tail = ''
    try:
        with open(journal_path, 'r', encoding='utf-8') as f:
            jlines = f.read().splitlines()
        journal_tail = '\n'.join(jlines[-160:]).strip()
    except OSError:
        pass

    parts.append('---')
    parts.append(
        'РЕЖИМ ПОСТОЯННОГО ТОПИКА. Этот топик — отдельный долгоживущий проект. '
        'Сессия эфемерна (засыпает после простоя), но КОНТЕКСТ постоянный. '
        f'Веди файл-сводку {handoff_path}: после каждого значимого шага '
        'переписывай его (что за проект, что сделано, где остановились, '
        'открытые вопросы, конкретные следующие шаги) — это твоя память на '
        'следующий день. Журнал ходов пишется автоматически, его править не нужно.'
    )
    if handoff_txt:
        parts.append('--- ПАМЯТЬ ТОПИКА (handoff — продолжай отсюда) ---')
        parts.append(handoff_txt)
    if journal_tail:
        parts.append('--- ПОСЛЕДНИЕ СООБЩЕНИЯ ТОПИКА (журнал) ---')
        parts.append(journal_tail)
    if not handoff_txt and not journal_tail:
        parts.append(
            'Это новый топик — памяти пока нет. Начни вести handoff с первого '
            'значимого шага.'
        )

# Capability note (all chats): how to attach a file from a multichat session,
# which has no reply tool. The Stop hook turns the marker into an outbox
# attachment and the router sends it AFTER the text. Secrets are refused.
parts.append('---')
parts.append(
    'Отправка файла в чат: в этой сессии нет reply-инструмента, поэтому чтобы '
    'прикрепить файл, добавь в текст ответа маркер [[file: /абсолютный/путь]] '
    '(можно несколько). Файл уйдёт после текста. НЕ читай токен и не дёргай '
    'Telegram API напрямую. Секреты (.env, ключи, *.pem/*.key, secrets/) '
    'отправлять нельзя — они будут отклонены.'
)
additional_context = '\n\n'.join(parts)

payload = {
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': additional_context,
    }
}
print(json.dumps(payload, ensure_ascii=False))
PYEOF
