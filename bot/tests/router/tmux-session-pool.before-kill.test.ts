// Persistent topics (2026-06-18): the idle watchdog runs a best-effort
// graceful pre-kill hook (onBeforeKill) before killing a reaped session,
// and a `reaping` guard stops a second watchdog tick from double-reaping a
// session whose dump is still in flight.
//
// runTmux is module-private and kill() swallows its errors, so we can drive
// runIdleCheck() against an injected session without a live tmux server: the
// kill-session call simply no-ops/errors-and-continues.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MultichatPolicy } from '../../src/chats/policy-loader.js'
import { TmuxSessionPool } from '../../src/router/tmux-session-pool.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Minimal policy: runIdleCheck only reads chats[base].idle_ttl_ms.
const policy = {
  chats: { '-100': { idle_ttl_ms: 1000 } },
} as unknown as MultichatPolicy

let stateDir: string

function makePool(): TmuxSessionPool {
  return new TmuxSessionPool({
    policy,
    stateDir,
    workspaceDir: stateDir,
    logger: noopLogger,
  })
}

// Inject a session that is well past its idle TTL so runIdleCheck reaps it.
function injectIdleSession(pool: TmuxSessionPool, chatId: string): void {
  ;(pool as unknown as { sessions: Map<string, unknown> }).sessions.set(chatId, {
    chatId,
    sessionName: `multichat-${chatId}`,
    spawnedAt: 0,
    lastMessageAt: 0,
  })
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'pool-before-kill-'))
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('TmuxSessionPool — graceful pre-kill', () => {
  test('onBeforeKill runs BEFORE the session is killed and removed', async () => {
    const pool = makePool()
    injectIdleSession(pool, '-100_t5')
    const order: string[] = []
    pool.onBeforeKill = async (cid) => {
      order.push(`before:${cid}`)
    }
    pool.onKill = (cid) => {
      order.push(`kill:${cid}`)
    }

    await pool.runIdleCheck()

    expect(order).toEqual(['before:-100_t5', 'kill:-100_t5'])
    // Session evicted from the live map.
    expect(
      (pool as unknown as { sessions: Map<string, unknown> }).sessions.has('-100_t5'),
    ).toBe(false)
  })

  test('reaping guard: a concurrent tick does not double-run onBeforeKill', async () => {
    const pool = makePool()
    injectIdleSession(pool, '-100_t5')

    let beforeCalls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    pool.onBeforeKill = async () => {
      beforeCalls += 1
      await gate // hold the first reap in-flight
    }

    // First tick: starts the reap, blocks inside onBeforeKill.
    const first = pool.runIdleCheck()
    await Promise.resolve() // let the loop reach the awaited gate
    // Second tick while the first is still dumping: must skip (reaping guard).
    await pool.runIdleCheck()
    expect(beforeCalls).toBe(1)

    release()
    await first
    expect(beforeCalls).toBe(1)
  })

  test('missing onBeforeKill still kills (no-op hook)', async () => {
    const pool = makePool()
    injectIdleSession(pool, '-100_t9')
    let killed = ''
    pool.onKill = (cid) => {
      killed = cid
    }
    await pool.runIdleCheck()
    expect(killed).toBe('-100_t9')
  })
})
