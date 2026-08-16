import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeServerToolUseIds } from '../../src/channel/model-switch.js'
import type { Logger } from '../../src/log.js'

function silentLog(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
}

let projectsRoot: string

beforeEach(async () => {
  projectsRoot = await mkdtemp(join(tmpdir(), 'model-switch-sanitize-'))
})

afterEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true })
})

async function writeTranscript(cwd: string, filename: string, lines: string[]): Promise<string> {
  const projectDirName = cwd.replace(/[/.]/g, '-')
  const projectDir = join(projectsRoot, projectDirName)
  await mkdir(projectDir, { recursive: true })
  const target = join(projectDir, filename)
  await writeFile(target, lines.map((l) => `${l}\n`).join(''), 'utf8')
  return target
}

describe('sanitizeServerToolUseIds', () => {
  test('rewrites a malformed server_tool_use id and its paired tool_result.tool_use_id', async () => {
    const cwd = '/home/office/scratch-project'
    const badId = 'call_52e9b768d60546b481e23679'
    const line1 = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'glm-5.2',
        content: [{ type: 'server_tool_use', id: badId, name: 'analyze_image', input: {} }],
      },
    })
    const line2 = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_result', tool_use_id: badId, content: 'ok' }],
      },
    })
    const target = await writeTranscript(cwd, 'session-a.jsonl', [line1, line2])

    const result = await sanitizeServerToolUseIds(cwd, silentLog(), projectsRoot)

    expect(result).toEqual({ patched: true, fixedCount: 1 })
    const patched = await readFile(target, 'utf8')
    expect(patched).not.toContain(`"${badId}"`)
    expect(patched).toContain(`"srvtoolu_${badId}"`)
    // Both occurrences (server_tool_use.id and tool_result.tool_use_id) fixed.
    expect(patched.split(`srvtoolu_${badId}`).length - 1).toBe(2)
  })

  test('leaves an already-valid srvtoolu_ id untouched', async () => {
    const cwd = '/home/office/scratch-project-ok'
    const goodId = 'srvtoolu_01AbCxyz789'
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'server_tool_use', id: goodId, name: 'web_search', input: {} }],
      },
    })
    const target = await writeTranscript(cwd, 'session-b.jsonl', [line])
    const before = await readFile(target, 'utf8')

    const result = await sanitizeServerToolUseIds(cwd, silentLog(), projectsRoot)

    expect(result).toEqual({ patched: false, fixedCount: 0 })
    const after = await readFile(target, 'utf8')
    expect(after).toBe(before)
  })

  test('picks the most recently modified transcript when multiple exist', async () => {
    const cwd = '/home/office/scratch-project-multi'
    const badId = 'call_old'
    const oldLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'server_tool_use', id: badId, name: 'x', input: {} }] },
    })
    await writeTranscript(cwd, 'session-old.jsonl', [oldLine])
    // Ensure a distinct mtime ordering.
    await new Promise((r) => setTimeout(r, 10))
    const newTarget = await writeTranscript(cwd, 'session-new.jsonl', [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ])

    const result = await sanitizeServerToolUseIds(cwd, silentLog(), projectsRoot)

    expect(result).toEqual({ patched: false, fixedCount: 0 })
    const untouched = await readFile(newTarget, 'utf8')
    expect(untouched).not.toContain('srvtoolu_')
  })

  test('is a no-op when the project dir does not exist', async () => {
    const result = await sanitizeServerToolUseIds('/nonexistent/cwd/for/this/test', silentLog(), projectsRoot)
    expect(result).toEqual({ patched: false, fixedCount: 0 })
  })

  test('explicitSessionId targets the exact file, ignoring a newer sibling in the same shared cwd', async () => {
    // Simulates the per-topic case: multiple sessions share one cwd
    // (chatsBasePath), so mtime-guessing would patch the wrong topic's
    // transcript. explicitSessionId must bypass that guess entirely.
    const cwd = '/home/office/multi2/orchestrator/.claude/chats'
    const badId = 'call_target_topic'
    const targetSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const targetLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'server_tool_use', id: badId, name: 'x', input: {} }] },
    })
    const target = await writeTranscript(cwd, `${targetSessionId}.jsonl`, [targetLine])
    // A newer sibling session in the SAME shared project dir — mtime-based
    // selection would pick this one instead; explicitSessionId must not.
    await new Promise((r) => setTimeout(r, 10))
    const otherId = 'call_other_topic'
    const otherLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'server_tool_use', id: otherId, name: 'x', input: {} }] },
    })
    const other = await writeTranscript(cwd, 'other-session.jsonl', [otherLine])

    const result = await sanitizeServerToolUseIds(cwd, silentLog(), projectsRoot, targetSessionId)

    expect(result).toEqual({ patched: true, fixedCount: 1 })
    const patchedTarget = await readFile(target, 'utf8')
    expect(patchedTarget).toContain(`srvtoolu_${badId}`)
    const untouchedOther = await readFile(other, 'utf8')
    expect(untouchedOther).not.toContain('srvtoolu_')
    expect(untouchedOther).toContain(`"${otherId}"`)
  })

  test('explicitSessionId is a clean no-op when the transcript does not exist yet (fresh topic, --session-id branch)', async () => {
    const cwd = '/home/office/multi2/orchestrator/.claude/chats-fresh'
    await writeTranscript(cwd, 'unrelated.jsonl', [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } })])

    const result = await sanitizeServerToolUseIds(cwd, silentLog(), projectsRoot, 'ffffffff-0000-0000-0000-000000000000')

    expect(result).toEqual({ patched: false, fixedCount: 0 })
  })
})
