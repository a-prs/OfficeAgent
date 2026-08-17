// pane-inject.ts — deliver an inbound Telegram message to the master
// `claude` session by typing it directly into its tmux pane, instead of via
// the MCP `notifications/claude/channel` push (see notify.ts).
//
// Why this exists (found the hard way, 2026-08-16, GLM-primary trial
// install): `--dangerously-load-development-channels` does not unconditionally
// enable the channel-push path. Disassembly of claude.exe traced it to
// `gateChannelServer`, which additionally requires the GrowthBook feature
// flag `tengu_harbor` to resolve `true` — and that flag is resolved via an
// authenticated Anthropic API call (`/api/eval-authed/...`), cached in
// `~/.claude.json`. A GLM/Z.ai-only session (no Anthropic OAuth/API key at
// all) never gets a `true` here, so the flag silently no-ops: the pane prints
// "Channels are not currently available" and nothing is ever delivered — this
// is why DM worked in our own production system (real Anthropic login, flag
// cached true long ago) but not on a fresh GLM-primary install of the exact
// same code.
//
// This module replaces that push with the same mechanism a human operator
// uses: paste text into the pane and press Enter. Since Claude Code's own
// client-side rendering of a channel notification (building the `<channel
// ...>content</channel>` block) never runs on this path, we build that
// envelope by hand — see buildEnvelope() — and inject the result as a
// literal bracketed paste (`tmux load-buffer` + `paste-buffer -p`), which
// avoids tmux/shell special-character interpretation entirely.
//
// This is intentionally a DIFFERENT delivery mechanism than the per-chat
// router/inbox-bridge path used for groups and topics (see router/). Reusing
// that path for DM was considered and rejected (see
// docs/critic-review-glm-primary-dm-2026-08-16.md, answer to plan's Q1): it
// would spawn a fresh per-chat session instead of reusing the always-on
// master session, silently dropping 5 real capabilities the master session
// already has wired (reply/react/edit_message/download_attachment tools via
// .mcp.json, the permission-gate hook, the fallback-reply hook, and the
// AskUserQuestion relay) — none of which the router/inbox-bridge path
// provides today.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Logger } from '../log.js'
import type { ChannelEvent } from './notify.js'

export interface PaneInjectConfig {
  // tmux target, `session` or `session:window.pane` syntax — the master
  // session's own pane (officeagent-bot.service's tmux session name).
  paneTarget: string
  // Server/plugin name this event is "from" — matches the .mcp.json key
  // (officeagent-channel) so the envelope reads the same as a real channel
  // push would have.
  serverName: string
  // Optional tmux socket name (`tmux -L <name>`).
  socketName?: string
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c)
}

// Builds the `<channel ...>content</channel>` envelope. The body is fully
// XML-entity-escaped — deliberately stricter than the client's own partial
// (closing-tag-only) neutralisation found in disassembly. Telegram message
// text is untrusted; full escaping means it can never close this tag early
// or smuggle in attributes the model would otherwise trust as
// system-supplied metadata, regardless of what the real client does.
export function buildEnvelope(serverName: string, event: ChannelEvent): string {
  const attrs = [`source="${escapeXml(serverName)}"`]
  for (const [key, value] of Object.entries(event.meta)) {
    attrs.push(`${key}="${escapeXml(value)}"`)
  }
  return `<channel ${attrs.join(' ')}>${escapeXml(event.content)}</channel>`
}

function runTmux(args: string[], input?: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`tmux ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}: ${stderr.trim()}`))
    })
    if (input !== undefined) {
      child.stdin?.write(input)
    }
    child.stdin?.end()
  })
}

// Returns true on success; false when the pane injection failed (caller
// dead-letters the update, same contract as sendChannelNotification).
export async function injectIntoMasterPane(
  cfg: PaneInjectConfig,
  event: ChannelEvent,
  log: Logger,
): Promise<boolean> {
  const envelope = buildEnvelope(cfg.serverName, event)
  const bufName = `officeagent-inject-${randomUUID()}`
  const withSocket = (args: string[]) =>
    cfg.socketName ? ['-L', cfg.socketName, ...args] : args
  try {
    await runTmux(withSocket(['load-buffer', '-b', bufName, '-']), envelope)
    await runTmux(withSocket(['paste-buffer', '-d', '-t', cfg.paneTarget, '-b', bufName, '-p']))
    await runTmux(withSocket(['send-keys', '-t', cfg.paneTarget, 'Enter']))
    return true
  } catch (err) {
    log.error('pane injection failed', {
      error: err instanceof Error ? err.message : String(err),
      pane_target: cfg.paneTarget,
    })
    return false
  }
}
