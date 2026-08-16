import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getModelState, resetModelStateOnKill, setModelState } from '../../src/channel/model-state.js'
import type { Logger } from '../../src/log.js'

function silentLog(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
}

let dir: string
let statePath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'model-state-'))
  statePath = join(dir, 'model-switch-state.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('model-state', () => {
  test('getModelState is undefined before any write', async () => {
    expect(await getModelState(statePath, 'multichat-x_t1')).toBeUndefined()
  })

  test('setModelState persists and getModelState reads it back', async () => {
    await setModelState(statePath, 'multichat-x_t1', 'glm', silentLog())
    const entry = await getModelState(statePath, 'multichat-x_t1')
    expect(entry?.target).toBe('glm')
    expect(typeof entry?.updatedAt).toBe('number')
  })

  test('setModelState for one pane does not clobber another pane entry', async () => {
    await setModelState(statePath, 'multichat-a_t1', 'glm', silentLog())
    await setModelState(statePath, 'multichat-b_t2', 'claude', silentLog())
    expect((await getModelState(statePath, 'multichat-a_t1'))?.target).toBe('glm')
    expect((await getModelState(statePath, 'multichat-b_t2'))?.target).toBe('claude')
  })

  test('resetModelStateOnKill flips a glm entry back to claude', async () => {
    await setModelState(statePath, 'multichat-x_t1', 'glm', silentLog())
    await resetModelStateOnKill(statePath, 'multichat-x_t1', silentLog())
    expect((await getModelState(statePath, 'multichat-x_t1'))?.target).toBe('claude')
  })

  test('resetModelStateOnKill is a no-op when the pane has no recorded entry', async () => {
    await resetModelStateOnKill(statePath, 'multichat-never-switched', silentLog())
    expect(await getModelState(statePath, 'multichat-never-switched')).toBeUndefined()
  })
})
