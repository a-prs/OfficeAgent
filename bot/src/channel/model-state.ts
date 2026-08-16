// model-state.ts — persisted "which model is this pane on" map, shared by
// Telegram (/model, inline buttons) and the dashboard (GET/POST
// /hooks/model/*) so both surfaces show the same state without polling
// /proc or capture-pane. Single source of truth: every switch (master or
// topic) goes through ModelSwitch.switchTo(), and only that code path
// writes here — see model-switch.ts.
//
// Idle-kill correctness (2026-07-30, found in adversarial review of the
// per-topic extension): a topic pane killed by the idle watchdog cold-boots
// plain `claude` on the next inbound message — TMUX_CHILD_ENV_ALLOWLIST
// (tmux-session-pool.ts) carries no ANTHROPIC_* vars, so the respawned pane
// is ALWAYS Claude regardless of what was selected before the kill. Without
// resetting the entry on kill, this file would keep claiming "glm" for a
// pane that is actually back on Claude — status endpoints would lie, not
// just go stale. MultichatRouter.onSessionKilled (wired in server.ts) calls
// resetModelStateOnKill for exactly this reason.

import { readFile, rename, writeFile } from 'node:fs/promises'
import type { ModelTarget } from './model-switch.js'
import type { Logger } from '../log.js'

export interface ModelStateEntry {
  target: ModelTarget
  updatedAt: number
}

type ModelStateFile = Record<string, ModelStateEntry>

async function readStateFile(path: string): Promise<ModelStateFile> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ModelStateFile
    }
    return {}
  } catch {
    return {}
  }
}

async function writeStateFile(path: string, state: ModelStateFile, log: Logger): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (err) {
    // Best-effort: a failed state write must never block the actual model
    // switch (which has already happened by the time we get here) — just
    // means the UI might show stale state until the next successful write.
    log.warn('model-state: write failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function getModelState(
  stateFilePath: string,
  paneTarget: string,
): Promise<ModelStateEntry | undefined> {
  const state = await readStateFile(stateFilePath)
  return state[paneTarget]
}

export async function setModelState(
  stateFilePath: string,
  paneTarget: string,
  target: ModelTarget,
  log: Logger,
): Promise<void> {
  const state = await readStateFile(stateFilePath)
  state[paneTarget] = { target, updatedAt: Date.now() }
  await writeStateFile(stateFilePath, state, log)
}

// Called on tmux pane kill (idle watchdog or explicit) — see module doc
// comment. `paneTarget` for a topic is `multichat-<chatId>`; callers
// resolve that from the raw chatId the pool hands back on kill.
export async function resetModelStateOnKill(
  stateFilePath: string,
  paneTarget: string,
  log: Logger,
): Promise<void> {
  const state = await readStateFile(stateFilePath)
  if (!(paneTarget in state)) return
  state[paneTarget] = { target: 'claude', updatedAt: Date.now() }
  await writeStateFile(stateFilePath, state, log)
}
