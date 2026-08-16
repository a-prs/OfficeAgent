// Persistent-topic journals (2026-06-18). MemoryWriter routes a forum-topic
// composite chatId's Stop hook to a PER-TOPIC journal under
// {chatsBase}/{compositeId}/journal.md instead of the shared recent.md, and
// skips the internal idle-shutdown directive so it never pollutes the log.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLogger } from '../../src/log.js'
import { MemoryWriter, type MemoryConfig } from '../../src/memory/writer.js'
import type { ClaudeHookPayload } from '../../src/schemas.js'
import { TOPIC_SHUTDOWN_MARKER } from '../../src/router/topic-lifecycle.js'

let workspace: string
let logsDir: string
const FIXED_NOW = 1_700_000_000_000

function cfg(): MemoryConfig {
  return {
    workspacePath: workspace,
    logsPath: logsDir,
    sourceTag: 'tg',
    agentLabel: 'Дэнни',
    maxHotBytes: 20480,
    trimKeepLines: 600,
    bufferTtlMs: 5 * 60 * 1000,
    bufferMaxEntries: 100,
  }
}

function makeWriter(): MemoryWriter {
  const w = new MemoryWriter(cfg(), createLogger('error'), () => FIXED_NOW)
  w.setTopicJournalBase(join(workspace, 'chats'))
  return w
}

// Drive one full turn (UserPromptSubmit then Stop) through the writer. No
// transcript_path → readLastAssistantText yields '' → agent snippet falls
// back to '(inline)', which keeps the test independent of transcript format.
async function turn(w: MemoryWriter, chatId: string, prompt: string): Promise<void> {
  await w.onHook({
    hook_event_name: 'UserPromptSubmit',
    chatId,
    prompt,
    session_id: 'sid',
  } as unknown as ClaudeHookPayload)
  await w.onHook({
    hook_event_name: 'Stop',
    chatId,
    session_id: 'sid',
  } as unknown as ClaudeHookPayload)
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'topic-journal-ws-'))
  logsDir = mkdtempSync(join(tmpdir(), 'topic-journal-logs-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(logsDir, { recursive: true, force: true })
})

describe('MemoryWriter — per-topic journal routing', () => {
  test('topic composite chatId writes to per-topic journal, NOT recent.md', async () => {
    const w = makeWriter()
    await turn(w, '-1004481335289_t118', 'Поднимаем дашборд')

    const journal = join(workspace, 'chats', '-1004481335289_t118', 'journal.md')
    const recent = join(workspace, 'core', 'hot', 'recent.md')

    expect(existsSync(journal)).toBe(true)
    expect(existsSync(recent)).toBe(false)

    const body = readFileSync(journal, 'utf8')
    expect(body).toContain('Поднимаем дашборд')
    expect(body).toContain('**Дэнни:** (inline)')
    expect(body).toContain('[tg]')
  })

  test('non-topic (master DM) chatId still writes recent.md, no per-topic dir', async () => {
    const w = makeWriter()
    await turn(w, '448238861', 'привет')

    const recent = join(workspace, 'core', 'hot', 'recent.md')
    expect(existsSync(recent)).toBe(true)
    expect(readFileSync(recent, 'utf8')).toContain('привет')
    // No per-topic journal dir for a plain chat id.
    expect(existsSync(join(workspace, 'chats', '448238861'))).toBe(false)
  })

  test('internal idle-shutdown directive is NOT journaled', async () => {
    const w = makeWriter()
    const chatId = '-100_t9'
    await turn(w, chatId, `${TOPIC_SHUTDOWN_MARKER} сверни handoff и не отвечай`)

    // The marker turn produces no journal file at all (it was the only turn).
    expect(existsSync(join(workspace, 'chats', chatId, 'journal.md'))).toBe(false)

    // A subsequent real turn DOES journal, and the directive text is absent.
    await turn(w, chatId, 'продолжаем работу')
    const body = readFileSync(join(workspace, 'chats', chatId, 'journal.md'), 'utf8')
    expect(body).toContain('продолжаем работу')
    expect(body).not.toContain(TOPIC_SHUTDOWN_MARKER)
  })

  test('without setTopicJournalBase, topic turns fall back to recent.md', async () => {
    // Multichat-off deployment: no per-topic routing wired.
    const w = new MemoryWriter(cfg(), createLogger('error'), () => FIXED_NOW)
    await turn(w, '-100_t1', 'fallback turn')
    expect(existsSync(join(workspace, 'core', 'hot', 'recent.md'))).toBe(true)
    expect(existsSync(join(workspace, 'chats', '-100_t1', 'journal.md'))).toBe(false)
  })
})
