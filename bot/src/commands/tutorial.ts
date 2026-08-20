// /tutorial — inline-button help menu. Content/engine split (owner
// requirement, 2026-08-20): every word shown here lives in
// content/tutorial.yaml, not in this file. Editing the menu text, adding
// an FAQ entry, or reordering sections never requires touching TypeScript
// — this module only knows how to render whatever the YAML contains.
//
// UX: /tutorial sends the menu (one button per section). Tapping a button
// EDITS that same message into the section body + a single "◀️ Назад"
// button; tapping Back edits it back to the menu. See server.ts's
// `tutorial:` callback_query branch for the tap handling — this module
// only builds the text/keyboard pairs, it never talks to Telegram itself.

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import type { InlineKeyboardLike } from '../channel/tools.js'

export interface TutorialSection {
  key: string
  menu_title: string
  title: string
  body: string
}

interface TutorialFile {
  version: number
  sections: TutorialSection[]
}

const CONTENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content', 'tutorial.yaml')

// Only a handful of callers per process lifetime (one per /tutorial tap) —
// re-reading the file each time keeps a content edit picked up without a
// restart, which is the whole point of separating it from code.
function loadSections(contentPath: string = CONTENT_PATH): TutorialSection[] {
  const raw = readFileSync(contentPath, 'utf8')
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA }) as TutorialFile | undefined
  const sections = parsed?.sections
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new Error(`tutorial.yaml has no sections: ${contentPath}`)
  }
  for (const s of sections) {
    if (!/^[A-Za-z0-9_]+$/.test(s.key)) {
      throw new Error(`tutorial.yaml section key must be url/callback-safe: ${JSON.stringify(s.key)}`)
    }
  }
  return sections
}

export const CALLBACK_PREFIX = 'tutorial:'
export const MENU_KEY = 'menu'

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export interface TutorialView {
  text: string
  replyMarkup: InlineKeyboardLike
}

/** Main menu: one button per section, in file order. */
export function buildMenuView(contentPath?: string): TutorialView {
  const sections = loadSections(contentPath)
  return {
    text: '<b>Туториал</b>\n\nВыбери раздел:',
    replyMarkup: {
      inline_keyboard: sections.map((s) => [
        { text: s.menu_title, callback_data: `${CALLBACK_PREFIX}${s.key}` },
      ]),
    },
  }
}

/** One section's body + a Back button. Returns undefined if key is unknown
 * (e.g. content was edited and a stale button from an old menu got tapped). */
export function buildSectionView(key: string, contentPath?: string): TutorialView | undefined {
  const sections = loadSections(contentPath)
  const section = sections.find((s) => s.key === key)
  if (!section) return undefined
  return {
    // body is authored content (installer/operator-controlled, not user
    // input) — not escaped, so authors can use <b>/<code> like the rest of
    // the bot's HTML-formatted messages. Menu titles/keys ARE escaped
    // below since a future author might paste something with a stray '<'.
    text: `<b>${escapeHtml(section.title)}</b>\n\n${section.body.trim()}`,
    replyMarkup: {
      inline_keyboard: [[{ text: '◀️ Назад', callback_data: `${CALLBACK_PREFIX}${MENU_KEY}` }]],
    },
  }
}
