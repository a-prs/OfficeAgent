// model-switch.ts — kill+respawn a claude tmux pane with a different
// model/backend, preserving conversation context via `claude --continue`.
//
// Validated live 2026-07-27 on an isolated scratch tmux session: Sonnet 5 ->
// GLM 5.2 (Z.ai) -> back to Sonnet 5. A planted secret survived both
// switches intact — `--continue` resumes the most recent session in the
// pane's cwd, no session-id lookup needed. `tmux respawn-pane -k` replaces
// the pane's running process without tearing down the tmux session/window,
// so hooks and other automation addressing the same pane target keep working.
//
// Why this exists (not just /reset or /new): those commands start a FRESH
// session (no context carried over). This one preserves context across a
// forced model switch — the point is to keep working through a Claude Max
// session-limit hit, not to start over.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../log.js'

const execFileAsync = promisify(execFile)

// Resolve the out-of-pane dismissal helper relative to THIS module so it
// works regardless of cwd. The helper lives at
// `plugin/scripts/dismiss-dev-channels.sh`; this file is at
// `plugin/src/channel/model-switch.ts`, so `../../scripts/...` from the
// module's dir yields the right path in both source and compiled layouts.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DISMISS_SCRIPT_PATH = resolve(
  MODULE_DIR,
  '..',
  '..',
  'scripts',
  'dismiss-dev-channels.sh',
)

export type ModelTarget = 'glm' | 'claude'

export interface ModelSwitchOptions {
  // tmux target, `session` or `session:window.pane` syntax.
  paneTarget: string
  // Optional tmux socket name (`tmux -L <name>`), for hosts running the
  // channel unit on a dedicated socket.
  socketName?: string
  // Path to the env file holding `ZAI_AUTH_TOKEN=...` (config/env/glm-fallback.env).
  glmEnvFile: string
  // Defaults to the GLM model claude-fallback.sh already uses in production.
  glmModel?: string
  // Only needed for TOPIC switches (see TopicSwitchOverride below). Lets
  // switchTo relaunch a respawned topic pane through
  // `{multichatWorkspaceDir}/chats/hooks/multichat-entrypoint.sh` — the
  // script that owns the background inbox-watcher — instead of a bare
  // `claude` invocation. Omit on master-only deployments (multichat
  // disabled): there is no topic pane to switch anyway.
  multichatWorkspaceDir?: string
  multichatStateDir?: string
  log: Logger
}

export interface ModelSwitchResult {
  ok: boolean
  target: ModelTarget
  error?: string
}

// Per-call override for switching a PANE OTHER than the master DM (i.e. a
// per-topic multichat session). Omit entirely to keep switching the master
// pane exactly as before (100% unchanged behavior/tests).
//
// Topic sessions are architecturally different from the master pane — see
// multichat-entrypoint.sh:523-531 and tmux-session-pool.ts's chatsBasePath
// comments (2026-07-29 per-topic model-switch investigation):
//   * They never load `--dangerously-load-development-channels` (no
//     office2-channel MCP plugin — driven by the file-based inbox/outbox
//     bridge instead), so channelFlag must NOT be included.
//   * They always run with `--permission-mode bypassPermissions`.
//   * They all share ONE cwd (chatsBasePath), so `claude --continue`
//     (which resumes "the most recent session in cwd") is ambiguous and
//     unsafe — must use `--resume <sessionId>` with the SAME deterministic
//     id the entrypoint computed at spawn time
//     (uuid5(NAMESPACE_URL, "multichat:"+chatId)), so it resumes the exact
//     right transcript. Same id is passed to the sanitizer as
//     explicitSessionId for the same reason.
export interface TopicSwitchOverride {
  // tmux target: `multichat-<compositeChatId>`.
  paneTarget: string
  // uuid5(NAMESPACE_URL, "multichat:"+chatId) — see resolveTopicSessionId.
  sessionId: string
}

function readZaiToken(path: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  for (const line of raw.split('\n')) {
    const m = /^ZAI_AUTH_TOKEN=(.*)$/.exec(line.trim())
    if (m && m[1]) return m[1].trim()
  }
  return undefined
}

// Single-quote for POSIX shell: close, escaped literal quote, reopen.
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", String.raw`'\''`)}'`
}

// Exact same formula `multichat-entrypoint.sh:523` uses to derive the
// deterministic session id it passes to `claude --resume`/`--session-id`.
// Shelling out to the SAME python3 one-liner (rather than reimplementing
// uuid5 in JS) is deliberate: Node/Bun have no built-in uuid v5 (only
// `crypto.randomUUID()` = v4, and there is no `uuid` package in
// package.json), so a hand-rolled JS port risks a silent byte-order/
// variant-bit divergence from Python's `uuid.uuid5` — which would compute
// a DIFFERENT id than the entrypoint used, causing `--resume <id>` to miss
// the transcript entirely. chatId is passed as argv[1] (a separate
// execFile array element), never string-interpolated into the -c source,
// matching how the bash script passes "$CHAT_ID" as sys.argv[1] — this
// keeps it injection-safe regardless of what characters chatId contains.
const UUID5_PY_SRC = 'import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, "multichat:"+sys.argv[1]))'

export async function resolveTopicSessionId(chatId: string): Promise<string> {
  const { stdout } = await execFileAsync('python3', ['-c', UUID5_PY_SRC, chatId], { timeout: 5000 })
  const id = stdout.trim()
  if (id === '') throw new Error('resolveTopicSessionId: empty output from python3 uuid5')
  return id
}

// Claude Code project-dir naming convention: cwd with every `/` and `.`
// replaced by `-`. Empirically verified against several live directories
// under ~/.claude/projects/ (2026-07-29) — not officially documented, but
// consistent across every sample checked.
function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

// Transcript corruption found live 2026-07-29: while a session ran under
// GLM 5.2 (Z.ai), a built-in server-executed tool call (e.g. analyze_image)
// got persisted as a `server_tool_use` content block whose `id` is in
// Z.ai/OpenAI's `call_...` shape instead of Anthropic's required
// `^srvtoolu_[a-zA-Z0-9_]+$` pattern. Z.ai's Anthropic-compatible endpoint
// accepts that shape back on retry, but the REAL Anthropic API validates
// history strictly — once that block is anywhere in the transcript,
// EVERY future turn on `claude --continue` 400s permanently (a restart
// does not help; it replays the same poisoned history). Confirmed via the
// crashed session's own transcript: `messages.41.content.3.server_tool_use.id`
// traced to a glm-5.2-authored block with id `call_52e9b768d60546b481e23679`.
//
// Fix: before switching a pane TO claude, scan the pane cwd's most
// recently modified session transcript (the one `--continue` will resume)
// for any `server_tool_use.id` not matching the required pattern, and
// rewrite it (and the paired `tool_result.tool_use_id`) to a synthesized
// valid id — a raw quoted-string substitution across the file, not a
// full JSON re-serialize, so nothing else in the transcript is reformatted.
//
// Best-effort by design: any failure here (missing project dir, unreadable
// file, no pending session yet) must never block the model switch itself —
// callers wrap this in its own try/catch.
export async function sanitizeServerToolUseIds(
  paneCwd: string,
  log: Logger,
  // Test-only override for `~/.claude/projects` — Bun's os.homedir()
  // caches its value on first call within a process, so tests cannot
  // rely on mutating process.env.HOME between cases.
  projectsRoot: string = resolve(homedir(), '.claude', 'projects'),
  // Topic sessions (2026-07-29 per-topic extension) all share ONE cwd
  // (`chatsBasePath`), so "most recently modified .jsonl in the project
  // dir" is ambiguous and can patch a DIFFERENT topic's transcript than
  // the one actually being resumed. When the caller knows the exact
  // session id it is about to `--resume` (topics always do — it's
  // deterministic, see resolveSwitchPlan), pass it here to target
  // `{projectDir}/{explicitSessionId}.jsonl` directly instead of
  // guessing. Master keeps using mtime-guessing (omit this param) — its
  // cwd is unique to it, so there is nothing to disambiguate.
  explicitSessionId?: string,
): Promise<{ patched: boolean; fixedCount: number }> {
  const projectDir = resolve(projectsRoot, cwdToProjectDirName(paneCwd))

  let targetPath: string
  if (explicitSessionId !== undefined) {
    targetPath = resolve(projectDir, `${explicitSessionId}.jsonl`)
    // Best-effort: a topic's very first-ever message spawns via
    // `--session-id` with no pre-existing transcript file yet — that's a
    // normal, expected case (nothing to sanitize), not an error.
    try {
      await stat(targetPath)
    } catch {
      return { patched: false, fixedCount: 0 }
    }
  } else {
    let entries: string[]
    try {
      entries = await readdir(projectDir)
    } catch {
      return { patched: false, fixedCount: 0 }
    }
    const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'))
    if (jsonlFiles.length === 0) return { patched: false, fixedCount: 0 }

    // `claude --continue` resumes the most recently modified transcript in
    // the project dir — mirror that selection so we patch the file it will
    // actually read.
    const withMtime = await Promise.all(
      jsonlFiles.map(async (f) => {
        const p = resolve(projectDir, f)
        try {
          return { p, mtimeMs: (await stat(p)).mtimeMs }
        } catch {
          return { p, mtimeMs: -1 }
        }
      }),
    )
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const newest = withMtime[0]
    if (newest === undefined || newest.mtimeMs < 0) return { patched: false, fixedCount: 0 }
    targetPath = newest.p
  }

  let raw: string
  try {
    raw = await readFile(targetPath, 'utf8')
  } catch {
    return { patched: false, fixedCount: 0 }
  }

  // Detection via JSON parsing (order-independent, robust to schema
  // drift) — collect only the malformed ids, one JSONL line at a time.
  const badIds = new Set<string>()
  for (const line of raw.split('\n')) {
    if (line.length === 0 || !line.includes('server_tool_use')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const content = (parsed as { message?: { content?: unknown } })?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block !== null
        && typeof block === 'object'
        && (block as { type?: unknown }).type === 'server_tool_use'
      ) {
        const id = (block as { id?: unknown }).id
        if (typeof id === 'string' && !/^srvtoolu_[a-zA-Z0-9_]+$/.test(id)) {
          badIds.add(id)
        }
      }
    }
  }
  if (badIds.size === 0) return { patched: false, fixedCount: 0 }

  // Fix via raw quoted-string substitution — touches only the exact id
  // occurrences (as `"id":"<id>"` AND the paired `"tool_use_id":"<id>"`),
  // leaves every other byte of the transcript untouched.
  let patched = raw
  for (const id of badIds) {
    // Strip anything outside the pattern's allowed charset before
    // prefixing, so the synthesized id is guaranteed to match
    // `^srvtoolu_[a-zA-Z0-9_]+$` even if the source id had stray chars.
    const safeSuffix = id.replace(/[^a-zA-Z0-9_]/g, '_')
    patched = patched.split(`"${id}"`).join(`"srvtoolu_${safeSuffix}"`)
  }

  const tmp = `${targetPath}.sanitize.tmp`
  await writeFile(tmp, patched, 'utf8')
  await rename(tmp, targetPath)
  log.warn('model-switch: sanitized malformed server_tool_use ids in transcript', {
    file: targetPath,
    fixedCount: badIds.size,
  })
  return { patched: true, fixedCount: badIds.size }
}

// Narrow structural surface for callers (oob.ts, webhook/server.ts) so
// tests can stub a switch without spinning up real tmux. `ModelSwitch`
// satisfies this by construction; kept separate from the concrete class so
// the interface can't accidentally grow a dependency on private fields.
export interface ModelSwitchLike {
  switchTo(target: ModelTarget, topic?: TopicSwitchOverride): Promise<ModelSwitchResult>
}

export class ModelSwitch implements ModelSwitchLike {
  private readonly opts: ModelSwitchOptions

  constructor(opts: ModelSwitchOptions) {
    this.opts = opts
  }

  async switchTo(target: ModelTarget, topic?: TopicSwitchOverride): Promise<ModelSwitchResult> {
    const { socketName, glmEnvFile, log } = this.opts
    const glmModel = this.opts.glmModel ?? 'glm-5.2'
    const paneTarget = topic?.paneTarget ?? this.opts.paneTarget

    // CRITICAL: must match the systemd ExecStart flag (`claude
    // --dangerously-load-development-channels server:office2-channel`) or the
    // respawned pane resumes the conversation via --continue but boots
    // WITHOUT the office2-channel plugin — no Telegram bridge, no reply/
    // download_attachment tools, no inbound notification path. Confirmed
    // 2026-07-27: this omission is the likely cause of the DM message-loss
    // incident that required a full `systemctl restart` to recover (a plain
    // restart re-runs the correct ExecStart, which does include the flag).
    // Topic sessions never load this plugin in the first place (see
    // TopicSwitchOverride doc comment) — omit the flag for them entirely.
    const channelFlag = topic
      ? ''
      : ' --dangerously-load-development-channels server:office2-channel'

    // Only the glm -> claude direction is at risk (see
    // sanitizeServerToolUseIds' doc comment) — Z.ai's endpoint accepts
    // whatever shape it itself produced, so there is nothing to repair
    // when switching TO glm. Best-effort: never let a sanitize failure
    // block the actual switch.
    // Topic panes are ALWAYS spawned on the literal `default` tmux socket
    // (tmux-session-pool.ts spawns with no `-L`, and deliberately excludes
    // TMUX from the child env allowlist so a topic never inherits the
    // master's ambient socket). A master running on a dedicated
    // `tmux_mirror.socket_name` must NOT apply that socket to topic tmux
    // calls — otherwise every topic switch silently targets the wrong
    // server and reports "pane not found" for a pane that IS running.
    // Two sibling call sites already hardcode `-L default` for topic panes
    // (server.ts's keypad handler, multichat-router.ts's topic mirror) —
    // matched here (2026-07-30 adversarial review finding).
    const targetSocketArgs = topic ? ['-L', 'default'] : socketName ? ['-L', socketName] : []

    if (target === 'claude') {
      try {
        const sockArgs = targetSocketArgs
        const { stdout } = await execFileAsync(
          'tmux',
          [...sockArgs, 'display-message', '-p', '-t', paneTarget, '#{pane_current_path}'],
          { timeout: 5000 },
        )
        const paneCwd = stdout.trim()
        if (paneCwd !== '') {
          await sanitizeServerToolUseIds(paneCwd, log, undefined, topic?.sessionId)
        }
      } catch (err) {
        log.warn('model-switch: transcript sanitize skipped (pane cwd lookup failed)', {
          paneTarget,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Read the GLM token once, up front — both the topic and master
    // branches below need it for target === 'glm'.
    let glmToken: string | undefined
    if (target === 'glm') {
      glmToken = readZaiToken(glmEnvFile)
      if (!glmToken) {
        log.warn('model-switch: missing ZAI_AUTH_TOKEN', { glmEnvFile })
        return { ok: false, target, error: 'missing ZAI_AUTH_TOKEN in glm env file' }
      }
    }

    let innerCmd: string
    if (topic) {
      // FIX (2026-07-30, found live): a topic pane's inbox-watcher — the
      // background loop that drains {stateDir}/chats/{chatId}/inbox/ and
      // injects Telegram messages into the pane — is started by
      // multichat-entrypoint.sh, NOT by `claude` itself. The original
      // topic switch below respawned the pane with a bare `claude --resume
      // ...`, which boots a perfectly working session but starts no
      // watcher: every message sent to the topic after a mid-conversation
      // /model switch just piled up unprocessed in inbox/ forever (and the
      // dashboard mirror "froze" because nothing was happening in the pane
      // at all). Relaunching through the SAME entrypoint script the
      // initial spawn uses (TmuxSessionPool.spawnInternal) restarts the
      // watcher exactly like a fresh spawn would. The script recomputes
      // the deterministic session id itself from CHAT_ID (same uuid5
      // formula as topic.sessionId — see resolveTopicSessionId), so it
      // naturally picks --resume over --session-id once a transcript
      // exists, matching what we want here.
      const chatIdMatch = /^multichat-(.+)$/.exec(topic.paneTarget)
      const topicChatId = chatIdMatch?.[1]
      const { multichatWorkspaceDir, multichatStateDir } = this.opts
      const entrypointPath =
        multichatWorkspaceDir !== undefined
          ? resolve(multichatWorkspaceDir, 'chats', 'hooks', 'multichat-entrypoint.sh')
          : undefined
      const entrypointUsable =
        topicChatId !== undefined
        && multichatStateDir !== undefined
        && entrypointPath !== undefined
        && existsSync(entrypointPath)

      if (!entrypointUsable) {
        // Best-effort degrade: still perform the switch (better than
        // refusing outright), but log loudly — this is exactly the bug
        // that shipped 2026-07-30, so a silent fallback here would just
        // reintroduce it invisibly.
        log.warn(
          'model-switch: multichat-entrypoint.sh unavailable for topic switch — '
          + 'falling back to a bare claude respawn, inbox watcher will NOT restart',
          { paneTarget, entrypointPath },
        )
      }

      const envAssignments: string[] = []
      if (entrypointUsable) {
        envAssignments.push(
          `CHAT_ID=${shellQuote(topicChatId!)}`,
          `MULTICHAT_STATE_DIR=${shellQuote(multichatStateDir!)}`,
          `CLAUDE_WORKSPACE_DIR=${shellQuote(multichatWorkspaceDir!)}`,
        )
      }
      if (target === 'glm') {
        envAssignments.push(
          `ANTHROPIC_BASE_URL=${shellQuote('https://api.z.ai/api/anthropic')}`,
          `ANTHROPIC_AUTH_TOKEN=${shellQuote(glmToken!)}`,
        )
        if (entrypointUsable) envAssignments.push(`MULTICHAT_MODEL_OVERRIDE=${shellQuote(glmModel)}`)
      }
      const envPrefix = envAssignments.length > 0 ? `${envAssignments.join(' ')} ` : ''

      innerCmd = entrypointUsable
        ? `${envPrefix}bash ${shellQuote(entrypointPath!)}`
        : target === 'glm'
          ? `${envPrefix}claude --resume ${shellQuote(topic.sessionId)} --model ${shellQuote(glmModel)} --permission-mode bypassPermissions`
          : `claude --resume ${shellQuote(topic.sessionId)} --permission-mode bypassPermissions`
    } else if (target === 'glm') {
      innerCmd =
        `ANTHROPIC_BASE_URL=${shellQuote('https://api.z.ai/api/anthropic')} `
        + `ANTHROPIC_AUTH_TOKEN=${shellQuote(glmToken!)} `
        + `claude --continue --model ${shellQuote(glmModel)}${channelFlag}`
    } else {
      innerCmd = `claude --continue${channelFlag}`
    }

    const args = [...targetSocketArgs, 'respawn-pane', '-k', '-t', paneTarget, innerCmd]

    try {
      await execFileAsync('tmux', args, { timeout: 10_000 })
      log.info('model-switch respawned pane', { target, paneTarget })
      // CRITICAL: --dangerously-load-development-channels shows an
      // interactive "WARNING: Loading development channels" confirmation
      // (1. I am using this for local development / 2. Exit, Enter to
      // confirm) on every fresh process start. respawn-pane only sends the
      // argv, not keystrokes, so the new process sits silently at this
      // prompt forever — no error, no channel bridge, nothing.
      //
      // ARCHITECTURE (2026-07-29): the dismissal MUST run OUT of the pane,
      // not inside this server.ts process. server.ts is a CHILD of the
      // `claude` process (PPid == claude), so respawn-pane -k kills it
      // together with claude the instant the respawn fires — any in-process
      // poll+Enter scheduled here (the earlier `void confirmDevChannelsPrompt`
      // approach) dies before it can ever press a key. That is why every
      // live switch left the pane stuck on the warning until a human pressed
      // Enter by hand. The systemd unit's ExecStartPost avoids this because
      // it sends Enter from systemd (a child of PID 1), OUTSIDE the pane.
      // We mirror that by launching the dismissal helper DETACHED
      // (setsid + stdio:'ignore' + unref) so it is reparented to init and
      // survives the pane death. The helper itself polls capture-pane and
      // presses Enter the moment the warning renders (no blind sleeps).
      this.launchDevChannelsDismissal(paneTarget, socketName)
      return { ok: true, target }
    } catch (err) {
      // SECURITY: never surface err.message/err.cmd here — Node's execFile
      // embeds the full argv (including the quoted ANTHROPIC_AUTH_TOKEN for
      // the glm branch) in both fields on a non-zero exit. Confirmed live
      // 2026-07-27: a failed respawn-pane call returned the token in
      // cleartext via error.message. Log/report only the exit code/signal —
      // never the error text itself.
      const e = err as { code?: number; signal?: string }
      const safeDetail =
        e.signal !== undefined
          ? `killed by signal ${e.signal}`
          : `exit code ${e.code ?? 'unknown'}`
      log.warn('model-switch respawn failed', { target, paneTarget, detail: safeDetail })
      return { ok: false, target, error: safeDetail }
    }
  }

  // Launch the OUT-OF-PANE dev-channels warning dismissal as a detached,
  // unref'd subprocess that survives the respawn (which kills this
  // server.ts process — see the ARCHITECTURE note above). Fire-and-forget:
  // the helper writes diagnostics to its own log file; we never await it.
  private launchDevChannelsDismissal(paneTarget: string, socketName?: string): void {
    const helperArgs = [paneTarget]
    if (socketName) helperArgs.push(socketName)
    try {
      const child = spawn(
        'setsid',
        [DISMISS_SCRIPT_PATH, ...helperArgs],
        {
          detached: true,
          stdio: 'ignore',
        },
      )
      child.on('error', (err) => {
        this.opts.log.warn('model-switch: failed to spawn detached dismiss helper', {
          paneTarget,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      child.unref()
    } catch (err) {
      this.opts.log.warn('model-switch: spawn of dismiss helper threw', {
        paneTarget,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
