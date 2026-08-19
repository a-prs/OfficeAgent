// model-switch (2026-07-30 per-topic extension) — webhook route tests for
// GET /hooks/model/status and POST /hooks/model/switch. Modeled on
// react-route.test.ts's harness. A stub ModelSwitchLike avoids spinning up
// real tmux; the pane-liveness check (`tmux has-session`) runs for real
// against a session name that never exists in the test sandbox, which is
// itself the thing under test for the 409 "pane not running" path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'os'
import { join } from 'path'

import { getStatePaths, loadConfig, type AppConfig, type StatePaths } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { ensureStateDirs } from '../../src/state/store.js'
import { getModelState } from '../../src/channel/model-state.js'
import type { ModelSwitchLike, ModelSwitchResult, ModelTarget, TopicSwitchOverride } from '../../src/channel/model-switch.js'
import { startWebhookServer, type WebhookDeps, type WebhookServerHandle } from '../../src/webhook/server.js'

const FAKE_TOKEN = '123456789:AAH-fake_test_token_with_at_least_thirty_chars'
const WEBHOOK_TOKEN = 'wh_test_token_32_chars__________'
const OWNER_ID = '164795011'
const GROUP_ID = '-1003784643974'
const MASTER_PANE = 'test-fixture-master-pane-never-alive'

let stateDir: string
let paths: StatePaths
let baseConfig: AppConfig
let handle: WebhookServerHandle | null

interface StubMcp {
  server: { notification: () => Promise<void> }
}
function makeMcpStub(): StubMcp {
  return { server: { notification: async () => { /* noop */ } } }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'officeagent-channel-model-switch-'))
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  const env = {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_STATE_DIR: stateDir,
    TELEGRAM_ALLOWED_CHAT_IDS: `${OWNER_ID},${GROUP_ID}`,
  }
  baseConfig = loadConfig(env)
  paths = getStatePaths(baseConfig, { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_STATE_DIR: stateDir })
  ensureStateDirs(paths)
  handle = null
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
  delete process.env.TELEGRAM_WEBHOOK_TOKEN
  rmSync(stateDir, { recursive: true, force: true })
})

class StubModelSwitch implements ModelSwitchLike {
  calls: { target: ModelTarget; topic?: TopicSwitchOverride }[] = []
  result: ModelSwitchResult = { ok: true, target: 'claude' }
  async switchTo(target: ModelTarget, topic?: TopicSwitchOverride): Promise<ModelSwitchResult> {
    this.calls.push(topic === undefined ? { target } : { target, topic })
    return { ...this.result, target }
  }
}

async function start(
  opts: { omitModelSwitch?: boolean; stub?: StubModelSwitch } = {},
): Promise<{ h: WebhookServerHandle; stub: StubModelSwitch; stateFilePath: string }> {
  const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
  const stub = opts.stub ?? new StubModelSwitch()
  const stateFilePath = join(stateDir, 'model-switch-state.json')
  const deps: WebhookDeps = {
    mcpServer: makeMcpStub().server as never,
    config,
    statePaths: paths,
    log: createLogger('test-model-switch'),
    permissionAllowedChats: [GROUP_ID],
    ...(opts.omitModelSwitch
      ? {}
      : { modelSwitchUi: { masterPaneTarget: MASTER_PANE, modelSwitch: stub, stateFilePath } }),
  }
  const h = await startWebhookServer(config, deps)
  if (!h) throw new Error('expected handle')
  handle = h
  return { h, stub, stateFilePath }
}

function url(h: WebhookServerHandle, path: string): string {
  return `http://${h.host}:${h.port}${path}`
}

function post(h: WebhookServerHandle, path: string, body: unknown, token: string | null = WEBHOOK_TOKEN): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url(h, path), { method: 'POST', headers, body: JSON.stringify(body) })
}

function get(h: WebhookServerHandle, path: string, token: string | null = WEBHOOK_TOKEN): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url(h, path), { headers })
}

describe('GET /hooks/model/status', () => {
  test('503 when model-switch capability is not wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({ omitModelSwitch: true })
    const resp = await get(h, `/hooks/model/status?pane=${MASTER_PANE}`)
    expect(resp.status).toBe(503)
  })

  test('401 without bearer', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await get(h, `/hooks/model/status?pane=${MASTER_PANE}`, null)
    expect(resp.status).toBe(401)
  })

  test('400 when pane is missing', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await get(h, '/hooks/model/status')
    expect(resp.status).toBe(400)
  })

  test('403 for an unallowlisted topic pane', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await get(h, '/hooks/model/status?pane=multichat-999999999_t1')
    expect(resp.status).toBe(403)
  })

  test('200 target=unknown for the master pane before any switch', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await get(h, `/hooks/model/status?pane=${MASTER_PANE}`)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ pane: MASTER_PANE, target: 'unknown' })
  })

  test('200 reflects a previously written state entry for an allowlisted topic pane', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, stateFilePath } = await start()
    const { setModelState } = await import('../../src/channel/model-state.js')
    await setModelState(stateFilePath, `multichat-${GROUP_ID}_t1`, 'glm', createLogger('t'))
    const resp = await get(h, `/hooks/model/status?pane=multichat-${GROUP_ID}_t1`)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toEqual({ pane: `multichat-${GROUP_ID}_t1`, target: 'glm' })
  })
})

describe('POST /hooks/model/switch', () => {
  test('503 when model-switch capability is not wired', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start({ omitModelSwitch: true })
    const resp = await post(h, '/hooks/model/switch', { pane: MASTER_PANE, target: 'glm' })
    expect(resp.status).toBe(503)
  })

  test('401 without bearer', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, '/hooks/model/switch', { pane: MASTER_PANE, target: 'glm' }, null)
    expect(resp.status).toBe(401)
  })

  test('400 on malformed body (bad target enum)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h } = await start()
    const resp = await post(h, '/hooks/model/switch', { pane: MASTER_PANE, target: 'gpt5' })
    expect(resp.status).toBe(400)
  })

  test('403 for a pane that is neither the master nor an allowlisted topic', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, stub } = await start()
    const resp = await post(h, '/hooks/model/switch', { pane: 'multichat-999999999_t1', target: 'glm' })
    expect(resp.status).toBe(403)
    expect(stub.calls).toEqual([])
  })

  test('403 for an arbitrary non-multichat pane name (defence in depth — not just syntax)', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, stub } = await start()
    const resp = await post(h, '/hooks/model/switch', { pane: 'some-other-tmux-session', target: 'glm' })
    expect(resp.status).toBe(403)
    expect(stub.calls).toEqual([])
  })

  test('409 when the target pane has no live tmux session', async () => {
    process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
    const { h, stub } = await start()
    // MASTER_PANE ("channel-orchestrator") is allowlisted (it IS the
    // master) but no such tmux session exists in the test sandbox.
    const resp = await post(h, '/hooks/model/switch', { pane: MASTER_PANE, target: 'glm' })
    expect(resp.status).toBe(409)
    expect(stub.calls).toEqual([])
  })

  describe('with a live tmux pane', () => {
    const liveSession = `model-switch-route-test-${process.pid}`

    beforeEach(() => {
      execFileSync('tmux', ['new-session', '-d', '-s', liveSession, '-x', '80', '-y', '24'])
    })

    afterEach(() => {
      try {
        execFileSync('tmux', ['kill-session', '-t', liveSession])
      } catch {
        // already gone — fine.
      }
    })

    test('master pane: 200, calls switchTo with no topic override, persists state', async () => {
      process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
      const stub = new StubModelSwitch()
      const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
      const stateFilePath = join(stateDir, 'model-switch-state.json')
      // masterPaneTarget points at the live scratch session spawned above
      // (rather than the harness's usual MASTER_PANE, which is never alive
      // in the sandbox) so this exercises the real tmux has-session + the
      // no-topic-override branch together.
      const h2 = await startWebhookServer(config, {
        mcpServer: makeMcpStub().server as never,
        config,
        statePaths: paths,
        log: createLogger('test-model-switch-live'),
        permissionAllowedChats: [GROUP_ID],
        modelSwitchUi: { masterPaneTarget: liveSession, modelSwitch: stub, stateFilePath },
      })
      if (!h2) throw new Error('expected handle')
      handle = h2

      const resp = await post(h2, '/hooks/model/switch', { pane: liveSession, target: 'glm' })
      expect(resp.status).toBe(200)
      expect(await resp.json()).toEqual({ ok: true, target: 'glm' })
      expect(stub.calls).toEqual([{ target: 'glm' }])
      const entry = await getModelState(stateFilePath, liveSession)
      expect(entry?.target).toBe('glm')
    })

    test('topic pane: 200, calls switchTo WITH a resolved TopicSwitchOverride, persists state', async () => {
      process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
      const stub = new StubModelSwitch()
      const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
      const stateFilePath = join(stateDir, 'model-switch-state.json')
      // The pane name IS the tmux session — spawn one matching the
      // multichat- naming convention so has-session succeeds.
      const topicChatId = `${GROUP_ID}_t1`
      const topicPane = `multichat-${topicChatId}`
      execFileSync('tmux', ['new-session', '-d', '-s', topicPane, '-x', '80', '-y', '24'])
      try {
        const h2 = await startWebhookServer(config, {
          mcpServer: makeMcpStub().server as never,
          config,
          statePaths: paths,
          log: createLogger('test-model-switch-topic'),
          permissionAllowedChats: [GROUP_ID],
          modelSwitchUi: { masterPaneTarget: MASTER_PANE, modelSwitch: stub, stateFilePath },
        })
        if (!h2) throw new Error('expected handle')
        handle = h2

        const resp = await post(h2, '/hooks/model/switch', { pane: topicPane, target: 'claude' })
        expect(resp.status).toBe(200)
        expect(stub.calls).toHaveLength(1)
        expect(stub.calls[0]?.target).toBe('claude')
        expect(stub.calls[0]?.topic?.paneTarget).toBe(topicPane)
        expect(typeof stub.calls[0]?.topic?.sessionId).toBe('string')
        expect(stub.calls[0]?.topic?.sessionId.length).toBeGreaterThan(0)
        const entry = await getModelState(stateFilePath, topicPane)
        expect(entry?.target).toBe('claude')
      } finally {
        try {
          execFileSync('tmux', ['kill-session', '-t', topicPane])
        } catch {
          // already gone — fine.
        }
      }
    })

    test('a failed switchTo does not persist state', async () => {
      process.env.TELEGRAM_WEBHOOK_TOKEN = WEBHOOK_TOKEN
      const stub = new StubModelSwitch()
      stub.result = { ok: false, target: 'glm', error: 'exit code 1' }
      const config: AppConfig = { ...baseConfig, webhook: { enabled: true, host: '127.0.0.1', port: 0 } }
      const stateFilePath = join(stateDir, 'model-switch-state.json')
      const h2 = await startWebhookServer(config, {
        mcpServer: makeMcpStub().server as never,
        config,
        statePaths: paths,
        log: createLogger('test-model-switch-fail'),
        permissionAllowedChats: [GROUP_ID],
        modelSwitchUi: { masterPaneTarget: liveSession, modelSwitch: stub, stateFilePath },
      })
      if (!h2) throw new Error('expected handle')
      handle = h2

      const resp = await post(h2, '/hooks/model/switch', { pane: liveSession, target: 'glm' })
      expect(resp.status).toBe(502)
      expect(await resp.json()).toEqual({ ok: false, target: 'glm', error: 'exit code 1' })
      expect(await getModelState(stateFilePath, liveSession)).toBeUndefined()
    })
  })
})
