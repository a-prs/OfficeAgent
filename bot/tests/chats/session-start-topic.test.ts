// Persistent-topic restore in session-start.sh. A forum-topic composite id
// re-injects the topic's durable memory (handoff + journal tail) on a fresh
// spawn so the session continues seamlessly; on a --resume spawn it injects
// only a short upkeep reminder (the transcript already carries context).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_HOOK = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'chats',
  'hooks',
  'session-start.sh',
)

const BASE = '-100'
const COMPOSITE = '-100_t5'

let workspace: string

function run(env: Record<string, string>, stdin: string): { code: number; ctx: string; stdout: string } {
  const r = spawnSync('bash', [SESSION_HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      MULTICHAT_STATE_DIR: workspace,
      CLAUDE_WORKSPACE_DIR: workspace,
      CHAT_ID: COMPOSITE,
      ...env,
    },
  })
  let ctx = ''
  try {
    ctx = JSON.parse(r.stdout ?? '').hookSpecificOutput?.additionalContext ?? ''
  } catch {
    ctx = ''
  }
  return { code: r.status ?? -1, ctx, stdout: r.stdout ?? '' }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'session-start-topic-'))
  const chats = join(workspace, 'chats')
  mkdirSync(join(chats, BASE), { recursive: true })
  mkdirSync(join(chats, COMPOSITE), { recursive: true })
  // policy.yaml present (reminder lookup is keyed by composite → empty, fine).
  writeFileSync(join(chats, 'policy.yaml'), 'version: 1\nchats: {}\n', 'utf8')
  // Persona is shared per base group.
  writeFileSync(join(chats, BASE, 'persona.md'), 'Ты Дэнни, смотрящий офиса.', 'utf8')
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('session-start.sh — persistent topic restore', () => {
  test('fresh start with handoff + journal injects both + protocol', () => {
    const chats = join(workspace, 'chats')
    writeFileSync(
      join(chats, COMPOSITE, 'handoff.md'),
      'ПРОЕКТ: дашборд. Встали на правке feed_mirror.',
      'utf8',
    )
    writeFileSync(
      join(chats, COMPOSITE, 'journal.md'),
      '### 2026-06-18 12:00 [tg]\n**User:** запусти рендер\n**Дэнни:** ок, рендерю\n',
      'utf8',
    )

    const { code, ctx } = run({}, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))
    expect(code).toBe(0)
    expect(ctx).toContain('Дэнни') // persona
    expect(ctx).toContain('РЕЖИМ ПОСТОЯННОГО ТОПИКА') // protocol
    expect(ctx).toContain('дашборд') // handoff
    expect(ctx).toContain('запусти рендер') // journal tail
    expect(ctx).not.toContain('возобновлён из транскрипта')
  })

  test('new topic (no memory yet) injects protocol + "new topic" hint', () => {
    const { code, ctx } = run({}, JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))
    expect(code).toBe(0)
    expect(ctx).toContain('РЕЖИМ ПОСТОЯННОГО ТОПИКА')
    expect(ctx).toContain('новый топик')
  })

  test('resume start skips the bulky dump, injects only the upkeep reminder', () => {
    const chats = join(workspace, 'chats')
    writeFileSync(join(chats, COMPOSITE, 'handoff.md'), 'СЕКРЕТНАЯ СВОДКА ДАШБОРДА', 'utf8')
    writeFileSync(join(chats, COMPOSITE, 'journal.md'), 'СТРОКА ЖУРНАЛА XYZ', 'utf8')

    const { code, ctx } = run({}, JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }))
    expect(code).toBe(0)
    expect(ctx).toContain('возобновлён из транскрипта')
    // The dump is NOT duplicated on resume.
    expect(ctx).not.toContain('СЕКРЕТНАЯ СВОДКА ДАШБОРДА')
    expect(ctx).not.toContain('СТРОКА ЖУРНАЛА XYZ')
    expect(ctx).not.toContain('РЕЖИМ ПОСТОЯННОГО ТОПИКА')
  })
})
