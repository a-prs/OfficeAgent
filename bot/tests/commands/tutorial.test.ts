import { describe, expect, test } from 'bun:test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { buildMenuView, buildSectionView, CALLBACK_PREFIX, MENU_KEY } from '../../src/commands/tutorial.js'

function writeContent(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tutorial-test-'))
  const path = join(dir, 'tutorial.yaml')
  writeFileSync(path, yaml, 'utf8')
  return path
}

const SAMPLE = `
version: 1
sections:
  - key: alpha
    menu_title: "Alpha"
    title: "Alpha Title"
    body: "Alpha body text"
  - key: beta
    menu_title: "Beta"
    title: "Beta Title"
    body: "Beta body text"
`

describe('tutorial content engine', () => {
  test('the real bundled content/tutorial.yaml loads and has sections', () => {
    const menu = buildMenuView()
    expect(menu.replyMarkup.inline_keyboard.length).toBeGreaterThan(0)
  })

  test('buildMenuView renders one row per section, in file order', () => {
    const path = writeContent(SAMPLE)
    const menu = buildMenuView(path)
    expect(menu.replyMarkup.inline_keyboard).toEqual([
      [{ text: 'Alpha', callback_data: `${CALLBACK_PREFIX}alpha` }],
      [{ text: 'Beta', callback_data: `${CALLBACK_PREFIX}beta` }],
    ])
  })

  test('buildSectionView returns the section body + a single Back button', () => {
    const path = writeContent(SAMPLE)
    const view = buildSectionView('beta', path)
    expect(view).toBeDefined()
    expect(view!.text).toContain('Beta Title')
    expect(view!.text).toContain('Beta body text')
    expect(view!.replyMarkup.inline_keyboard).toEqual([
      [{ text: '◀️ Назад', callback_data: `${CALLBACK_PREFIX}${MENU_KEY}` }],
    ])
  })

  test('buildSectionView returns undefined for an unknown key (stale button)', () => {
    const path = writeContent(SAMPLE)
    expect(buildSectionView('nonexistent', path)).toBeUndefined()
  })

  test('rejects a section key with unsafe characters', () => {
    const path = writeContent(`
version: 1
sections:
  - key: "bad key!"
    menu_title: "x"
    title: "x"
    body: "x"
`)
    expect(() => buildMenuView(path)).toThrow()
  })
})
