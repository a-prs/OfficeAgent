import { describe, expect, test } from 'bun:test'

import { resolveTopicSessionId } from '../../src/channel/model-switch.js'

describe('resolveTopicSessionId', () => {
  test('matches the exact formula multichat-entrypoint.sh uses (uuid5 of "multichat:"+chatId)', async () => {
    // Cross-checked against a live `python3 -c 'import uuid...'` run with
    // the same chatId — this pins the value so a future refactor can't
    // silently drift from multichat-entrypoint.sh:523's own computation.
    const id = await resolveTopicSessionId('-1004481335289_t8372')
    expect(id).toBe('2dd66e6c-dcb0-58b4-aec8-d2c2b131e0fb')
  })

  test('is deterministic — same chatId always yields the same id', async () => {
    const a = await resolveTopicSessionId('448238861')
    const b = await resolveTopicSessionId('448238861')
    expect(a).toBe(b)
  })

  test('different chatIds yield different ids', async () => {
    const a = await resolveTopicSessionId('448238861')
    const b = await resolveTopicSessionId('448238861_t1')
    expect(a).not.toBe(b)
  })
})
