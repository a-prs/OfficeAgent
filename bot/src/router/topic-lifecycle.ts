// Persistent topic lifecycle helpers (2026-06-18).
//
// A Telegram forum topic is a PERMANENT per-project channel; the claude
// session that backs it is disposable (idle-reaped after idle_ttl_ms). The
// owner wants to write into the same topic the next day and have the bot
// pick the thread back up — "continue after a restart" semantics, but per
// topic instead of for the master session.
//
// Continuity across session deaths comes from per-topic memory files that
// live OUTSIDE the session and are re-injected by session-start.sh on the
// next spawn. They sit next to the chat persona under {workspaceDir}/chats/{id}:
//   * journal.md  — rolling turn log (👤 user / 🤖 agent), written by
//                   MemoryWriter on every Stop hook. The HOT layer: a
//                   byte-capped window of "what was said".
//   * handoff.md  — curated project summary (what / where we stopped / open
//                   questions / next steps), written by the session itself.
//                   The DURABLE layer: refreshed along the way and on a final
//                   graceful dump before idle-kill. Survives journal trimming.
//
// The permanent raw audit (verbose-YYYY-MM-DD.jsonl) already captures every
// turn for all sessions, so nothing is ever truly lost — these two files are
// the fast-restore path, not the system of record.

import { join } from 'node:path'

/** Composite topic id shape: "<baseChatId>_t<threadId>". */
const TOPIC_ID_RE = /_t\d+$/

/** True iff chatId is a forum-topic composite (carries a _t<threadId>). */
export function isTopicChatId(chatId: string): boolean {
  return TOPIC_ID_RE.test(chatId)
}

/** Strip the _t<threadId> suffix to get the base chat id. */
export function baseChatIdOf(chatId: string): string {
  return chatId.replace(TOPIC_ID_RE, '')
}

/**
 * {chatsBase}/{chatId}/journal.md — the rolling per-topic turn log.
 * `chatsBase` is `{workspaceDir}/chats` (same dir tree that holds persona.md).
 */
export function topicJournalPath(chatsBase: string, chatId: string): string {
  return join(chatsBase, chatId, 'journal.md')
}

/** {chatsBase}/{chatId}/handoff.md — the curated per-topic summary. */
export function topicHandoffPath(chatsBase: string, chatId: string): string {
  return join(chatsBase, chatId, 'handoff.md')
}

/**
 * Operational sentinel a reaped session touches to acknowledge it has
 * written its final handoff. Lives under the STATE tree (transient, like
 * inbox/outbox) rather than the workspace, so it is scrubbed with the rest
 * of the chat's volatile queue state.
 */
export function shutdownAckPath(stateDir: string, chatId: string): string {
  return join(stateDir, 'chats', chatId, '.shutdown-ack')
}

/**
 * Sentinel touched by the multichat-entrypoint WATCHER itself (not the
 * agent) once a pre-kill `/compact` submitted to the pane has settled back
 * to idle. Separate from shutdownAckPath because it acknowledges a
 * different step (transcript compaction, not the handoff-summary rewrite)
 * that runs after it, in the same before-kill window.
 */
export function compactAckPath(stateDir: string, chatId: string): string {
  return join(stateDir, 'chats', chatId, '.compact-ack')
}

/**
 * Marker that opens an INTERNAL (non-chat) directive injected into a session
 * about to be idle-reaped. The session must recognise it as a system
 * instruction (update handoff, do NOT reply to chat). MemoryWriter skips
 * journaling any turn whose prompt starts with this marker, so the directive
 * itself never pollutes the journal it is meant to preserve.
 */
export const TOPIC_SHUTDOWN_MARKER = '🔻[topic-shutdown]'

/** Header line written atop a freshly-trimmed per-topic journal. */
export const TOPIC_JOURNAL_HEADER =
  '# Topic journal -- rolling turn log (hot layer)\n\n'
