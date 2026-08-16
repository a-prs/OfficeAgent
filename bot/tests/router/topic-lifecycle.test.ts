// Pure helpers for the persistent-topic lifecycle.

import { describe, expect, test } from 'bun:test'

import {
  baseChatIdOf,
  isTopicChatId,
  shutdownAckPath,
  topicHandoffPath,
  topicJournalPath,
} from '../../src/router/topic-lifecycle.js'

describe('topic-lifecycle helpers', () => {
  test('isTopicChatId distinguishes composites from base ids', () => {
    expect(isTopicChatId('-1004481335289_t118')).toBe(true)
    expect(isTopicChatId('448238861_t5')).toBe(true)
    expect(isTopicChatId('448238861')).toBe(false)
    expect(isTopicChatId('-1004481335289')).toBe(false)
    // A _t not followed by digits is not a topic suffix.
    expect(isTopicChatId('-100_topic')).toBe(false)
  })

  test('baseChatIdOf strips only a trailing _t<digits>', () => {
    expect(baseChatIdOf('-1004481335289_t118')).toBe('-1004481335289')
    expect(baseChatIdOf('448238861')).toBe('448238861')
  })

  test('memory paths live under {chatsBase}/{compositeId}', () => {
    const base = '/ws/chats'
    expect(topicJournalPath(base, '-100_t5')).toBe('/ws/chats/-100_t5/journal.md')
    expect(topicHandoffPath(base, '-100_t5')).toBe('/ws/chats/-100_t5/handoff.md')
  })

  test('ack sentinel lives under the state tree', () => {
    expect(shutdownAckPath('/state', '-100_t5')).toBe(
      '/state/chats/-100_t5/.shutdown-ack',
    )
  })
})
