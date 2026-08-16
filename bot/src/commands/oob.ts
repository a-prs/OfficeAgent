// Out-of-band (OOB) commands handled by the plugin BEFORE a channel
// notification is sent to Claude. Mirrors gateway.py:_OOB_COMMANDS +
// _handle_oob_command + handle_command (status/help/reset/new branches).
//
// Scope A commands: /help, /status, /stop, /reset, /new.
// Explicitly NOT included: /compact, /halt (Scope B per PLAN.md T10).
//
// Parsing rules (gateway.py:3037-3046 + 3366-3370):
//   - Must start with `/`.
//   - Optional `@botname` suffix is stripped when it matches our bot's
//     username (case-insensitive).
//   - Command word is lowercased.
//   - Trailing `force` token in args sets hasForceFlag (for /reset force,
//     /new force).
//
// Handling notes:
//   - /help and /status reply directly to Telegram and DO NOT wake Claude
//     (no channel notification). Status is a snapshot of plugin-side state
//     only — Claude session lives in the host process and we don't poke it.
//   - /stop, /reset force, /new force ack the user AND emit a channel
//     notification with meta.command=<name>. The plugin can't truly
//     interrupt Claude (no public API for that yet); /help documents this
//     limitation.
//   - /reset and /new without `force` return a short reply asking for the
//     flag, no channel notification.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { InlineKeyboardLike, TelegramApi } from '../channel/tools.js'
import { sendChannelNotification, type ChannelEvent } from '../channel/notify.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { resolveTopicSessionId, type ModelTarget, type TopicSwitchOverride } from '../channel/model-switch.js'
import { setModelState } from '../channel/model-state.js'
import { isTopicChatId } from '../router/topic-lifecycle.js'

const execFileAsync = promisify(execFile)

// Topic panes always live on the literal `default` tmux socket (see
// model-switch.ts's matching comment on `targetSocketArgs`) — hardcode it
// here too since this helper only ever checks TOPIC panes.
async function topicPaneIsAlive(paneTarget: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-L', 'default', 'has-session', '-t', paneTarget], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export type OobCommandName = 'help' | 'status' | 'stop' | 'reset' | 'new' | 'model'

const KNOWN_COMMANDS = new Set<OobCommandName>([
  'help',
  'status',
  'stop',
  'reset',
  'new',
  'model',
])

export interface ParsedOobCommand {
  name: OobCommandName
  rawText: string
  args: string
  hasForceFlag: boolean
}

// Parse a leading `/cmd[@botname] args...` token. Returns null if the text
// is not an OOB command (plain text, unknown command, no leading slash).
export function parseOobCommand(
  text: string,
  botUsername?: string,
): ParsedOobCommand | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.replace(/^\s+/, '')
  if (!trimmed.startsWith('/')) return null

  // Split on first whitespace run. parts[0] = "/word[@bot]", rest = args.
  const wsIdx = trimmed.search(/\s/)
  const head = wsIdx === -1 ? trimmed : trimmed.slice(0, wsIdx)
  const args = wsIdx === -1 ? '' : trimmed.slice(wsIdx + 1).trim()

  // Strip leading slash, optional @botname suffix.
  let word = head.slice(1)
  const atIdx = word.indexOf('@')
  if (atIdx !== -1) {
    const suffix = word.slice(atIdx + 1)
    word = word.slice(0, atIdx)
    // gateway.py strips ANY @suffix without verifying the bot identity, so we
    // mirror that here. botUsername is accepted for future tightening, but
    // not enforced — stripping any suffix matches gateway.py:3044-3045.
    void suffix
    void botUsername
  }

  const lower = word.toLowerCase() as OobCommandName
  if (!KNOWN_COMMANDS.has(lower)) return null

  const hasForceFlag = /^\s*force\s*$/i.test(args)

  return {
    name: lower,
    rawText: text,
    args,
    hasForceFlag,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Handler context and result shape.
// ─────────────────────────────────────────────────────────────────────

// Minimal surface of ModelSwitch that the OOB layer needs — decoupled from
// the concrete tmux-respawn implementation so tests don't need real tmux.
// `topic` is optional (source-compatible widening, 2026-07-30) — existing
// master-pane call sites and test stubs that only pass `target` keep
// compiling unchanged; the new in-topic `/model` branch below is the only
// caller that ever supplies it.
export interface ModelSwitchControl {
  switchTo(target: ModelTarget, topic?: TopicSwitchOverride): Promise<{ ok: boolean; error?: string }>
}

export interface OobContext {
  chatId: string
  senderId: string
  config: AppConfig
  telegramApi: TelegramApi
  log: Logger
  // For /status, pulled lazily so handler stays decoupled from the
  // status manager (T11) and poller/webhook plumbing (T13).
  pollerStatus?: () => { offset: number | undefined; lastError?: string }
  statusManager?: {
    isActive: (chatId: string) => boolean
    cancel: (chatId: string, reason: string) => Promise<void>
  }
  webhookStatus?: () => { enabled: boolean; port: number }
  // Shared model-switch-state.json path (dashboard/Telegram sync) — the
  // SAME constant server.ts computes for itself, threaded through rather
  // than re-derived from stateDir + a literal filename (2026-07-30
  // adversarial review finding: a second independent derivation risks
  // silent drift from server.ts's if the filename there ever changes).
  // Undefined only in tests/wiring that predate model-switch or don't
  // configure it — the in-topic /model branch skips state persistence
  // (logs a warning) rather than failing the switch itself when absent.
  modelSwitchStateFilePath?: string
  // /model control (2026-07-27) — kill+respawn the session's tmux pane on a
  // different model/backend while preserving context via `claude --continue`.
  // Undefined when alt_provider is not configured; handler then replies
  // «not configured» rather than silently no-op-ing.
  modelSwitch?: ModelSwitchControl
  // Identity bits surfaced by /status.
  botId?: number
  stateDir?: string
}

export interface OobResult {
  handled: true
  command: OobCommandName
  notifyChannel?: { content: string; meta: Record<string, string> }
  replyToTelegram?: { text: string; parseMode?: 'HTML'; replyMarkup?: InlineKeyboardLike }
  // /model only. `tmux respawn-pane -k` kills the process occupying the
  // pane — which, for the master DM session, IS the process handling this
  // very command. So the actual switch must not run until AFTER
  // replyToTelegram has been sent (executeOobResult does this ordering);
  // running it inline in the case body risks killing the process before
  // the confirmation reply goes out.
  pendingModelSwitch?: ModelTarget
}

// ─────────────────────────────────────────────────────────────────────
// /help text. Lists ONLY Scope A commands. Do not add /compact, /halt
// here — they belong to Scope B and grep checks enforce their absence.
// ─────────────────────────────────────────────────────────────────────

function helpText(): string {
  return (
    '<b>команды</b>\n\n'
    + '<code>/help</code> — эта справка\n'
    + '<code>/status</code> — снимок плагина и сессии\n'
    + '<code>/stop</code> — попросить Claude остановить текущую задачу\n'
    + '<code>/reset force</code> — сбросить состояние сессии (подтверди флагом <code>force</code>)\n'
    + '<code>/new force</code> — начать новую сессию (подтверди флагом <code>force</code>)\n'
    + '<code>/model alt|primary</code> — переключить модель сессии (контекст сохраняется через --continue)\n\n'
    + '<i>примечание: /stop — best-effort: плагин передаёт сигнал остановки через '
    + 'канал, но не может гарантировать прерывание посреди вызова инструмента.</i>'
  )
}

// Public so server.ts can feed the SAME list to bot.api.setMyCommands and
// Telegram autocomplete stays in sync with what the parser actually accepts.
export interface BotCommandSpec {
  command: string
  description: string
}
export const BOT_COMMANDS: ReadonlyArray<BotCommandSpec> = [
  { command: 'help', description: 'справка по командам' },
  { command: 'status', description: 'снимок плагина и сессии' },
  { command: 'stop', description: 'попросить Claude остановиться' },
  { command: 'reset', description: 'сбросить сессию (нужен force)' },
  { command: 'new', description: 'начать новую сессию (нужен force)' },
  { command: 'model', description: 'переключить модель сессии: alt | primary' },
]

function statusText(ctx: OobContext): string {
  const lines: string[] = ['<b>статус</b>']
  if (ctx.botId !== undefined) {
    lines.push(`bot_id: <code>${escapeHtml(String(ctx.botId))}</code>`)
  }
  if (ctx.stateDir) {
    lines.push(`state_dir: <code>${escapeHtml(ctx.stateDir)}</code>`)
  }
  lines.push(`allowed_user: <code>${escapeHtml(ctx.senderId)}</code>`)

  if (ctx.pollerStatus) {
    const ps = ctx.pollerStatus()
    const off = ps.offset === undefined ? '—' : String(ps.offset)
    lines.push(`update_offset: <code>${escapeHtml(off)}</code>`)
    if (ps.lastError) {
      lines.push(`poller_error: <code>${escapeHtml(ps.lastError)}</code>`)
    }
  }

  if (ctx.statusManager) {
    const active = ctx.statusManager.isActive(ctx.chatId) ? 'active' : 'idle'
    lines.push(`status_manager: <code>${active}</code>`)
  }

  if (ctx.webhookStatus) {
    const ws = ctx.webhookStatus()
    const w = ws.enabled ? `on:${ws.port}` : 'off'
    lines.push(`webhook: <code>${w}</code>`)
  }

  return lines.join('\n')
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// ─────────────────────────────────────────────────────────────────────
// Main dispatcher. Pure data — caller actually issues sendMessage and
// channel notification calls based on the OobResult. This keeps the
// function trivially testable.
// ─────────────────────────────────────────────────────────────────────

export async function handleOobCommand(
  parsed: ParsedOobCommand,
  ctx: OobContext,
): Promise<OobResult> {
  const baseMeta: Record<string, string> = {
    source: 'telegram',
    chat_id: ctx.chatId,
    user_id: ctx.senderId,
    ts: new Date().toISOString(),
    command: parsed.name,
  }

  switch (parsed.name) {
    case 'help': {
      ctx.log.info('oob /help', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'help',
        replyToTelegram: { text: helpText(), parseMode: 'HTML' },
      }
    }

    case 'status': {
      ctx.log.info('oob /status', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'status',
        replyToTelegram: { text: statusText(ctx), parseMode: 'HTML' },
      }
    }

    case 'stop': {
      ctx.log.info('oob /stop', { chat_id: ctx.chatId })
      // Cancel any active status — the user explicitly asked to halt, so
      // leaving "Печатает..." pulsing while we wait for Claude to notice
      // the channel event would be confusing. Best-effort: errors in cancel
      // are swallowed inside the manager.
      if (ctx.statusManager && ctx.statusManager.isActive(ctx.chatId)) {
        try {
          await ctx.statusManager.cancel(ctx.chatId, 'user stop')
        } catch (err) {
          ctx.log.warn('oob /stop status cancel failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return {
        handled: true,
        command: 'stop',
        replyToTelegram: {
          text: '<b>stop</b> — запрос принят. Claude увидит сигнал остановки при следующем чтении канала.',
          parseMode: 'HTML',
        },
        notifyChannel: {
          content: '/stop',
          meta: baseMeta,
        },
      }
    }

    case 'reset': {
      if (!parsed.hasForceFlag) {
        return {
          handled: true,
          command: 'reset',
          replyToTelegram: {
            text: 'Для подтверждения добавь <code>force</code>: <code>/reset force</code>',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /reset force', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'reset',
        replyToTelegram: {
          text: '<b>сессия сброшена (force)</b>\n\nследующее сообщение начнёт новую сессию',
          parseMode: 'HTML',
        },
        notifyChannel: { content: '/reset force', meta: baseMeta },
      }
    }

    case 'new': {
      if (!parsed.hasForceFlag) {
        return {
          handled: true,
          command: 'new',
          replyToTelegram: {
            text: 'Для подтверждения добавь <code>force</code>: <code>/new force</code>',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /new force', { chat_id: ctx.chatId })
      return {
        handled: true,
        command: 'new',
        replyToTelegram: {
          text: '<b>новая сессия</b>\n\nследующее сообщение начнёт новую сессию',
          parseMode: 'HTML',
        },
        notifyChannel: { content: '/new force', meta: baseMeta },
      }
    }


    case 'model': {
      const action = parsed.args.trim().toLowerCase()
      const isTopic = isTopicChatId(ctx.chatId)
      const altLabel = ctx.config.alt_provider.label || 'Alternative model'
      if (action !== 'alt' && action !== 'primary') {
        if (!ctx.modelSwitch) {
          return {
            handled: true,
            command: 'model',
            replyToTelegram: {
              text: '<b>/model</b> — не настроено (alt_provider отсутствует в конфиге плагина)',
              parseMode: 'HTML',
            },
          }
        }
        // No target given — show buttons instead of making the operator
        // type it out. Implicit target: whichever pane this reply lands in
        // — executeOobResult sends replyToTelegram to ctx.chatId, which for
        // a topic is the composite `<chatId>_t<threadId>` TelegramApi
        // already knows how to address (tools.ts's splitThreadKey) — so
        // this reaches the SAME topic the command was typed in, no extra
        // wiring needed. Tapping either button is handled by the
        // already-deployed `model:` callback_query handler in server.ts,
        // which already branches on the tapped message's own thread id.
        return {
          handled: true,
          command: 'model',
          replyToTelegram: {
            text: '<b>/model</b> — выбери модель:',
            parseMode: 'HTML',
            replyMarkup: {
              inline_keyboard: [[
                { text: altLabel, callback_data: 'model:alt' },
                { text: 'Primary', callback_data: 'model:primary' },
              ]],
            },
          },
        }
      }
      if (!ctx.modelSwitch) {
        return {
          handled: true,
          command: 'model',
          replyToTelegram: {
            text: '<b>/model</b> — не настроено (alt_provider отсутствует в конфиге плагина)',
            parseMode: 'HTML',
          },
        }
      }
      ctx.log.info('oob /model', { chat_id: ctx.chatId, target: action, topic: isTopic })
      const label = action === 'alt' ? altLabel : 'Primary'

      if (isTopic) {
        // Topic pane != master pane — respawn-pane -k here does NOT kill
        // the process handling this command, so no defer-past-the-reply
        // trick is needed; switch synchronously and reply with the real
        // outcome (2026-07-30 adversarial review finding: the master-only
        // deferred path silently swallowed failures, this one must not).
        const paneTarget = `multichat-${ctx.chatId}`
        const alive = await topicPaneIsAlive(paneTarget)
        if (!alive) {
          return {
            handled: true,
            command: 'model',
            replyToTelegram: {
              text: '<b>/model</b> — топик сейчас не запущен. Напиши сюда любое сообщение, чтобы поднять сессию, потом переключай.',
              parseMode: 'HTML',
            },
          }
        }
        let sessionId: string
        try {
          sessionId = await resolveTopicSessionId(ctx.chatId)
        } catch (err) {
          ctx.log.warn('oob /model: topic session-id resolution failed', {
            chat_id: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          })
          return {
            handled: true,
            command: 'model',
            replyToTelegram: {
              text: '<b>/model</b> — не удалось определить сессию топика, переключение отменено.',
              parseMode: 'HTML',
            },
          }
        }
        const result = await ctx.modelSwitch.switchTo(action, { paneTarget, sessionId })
        if (!result.ok) {
          return {
            handled: true,
            command: 'model',
            replyToTelegram: {
              text: `<b>/model</b> — переключение не удалось: ${result.error ?? 'неизвестная ошибка'}`,
              parseMode: 'HTML',
            },
          }
        }
        if (ctx.modelSwitchStateFilePath) {
          try {
            await setModelState(ctx.modelSwitchStateFilePath, paneTarget, action, ctx.log)
          } catch (err) {
            ctx.log.warn('oob /model: setModelState failed (switch itself succeeded)', {
              paneTarget,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        } else {
          ctx.log.warn('oob /model: modelSwitchStateFilePath not wired — dashboard sync will be stale', {
            paneTarget,
          })
        }
        return {
          handled: true,
          command: 'model',
          replyToTelegram: {
            text: `<b>переключил на ${label}</b>\n\nконтекст сохранился (--resume).`,
            parseMode: 'HTML',
          },
        }
      }

      // Master pane. IMPORTANT: do NOT call ctx.modelSwitch.switchTo() here.
      // It kills the process occupying this pane — for the master DM
      // session, that IS this very process. The reply below must reach
      // Telegram BEFORE the kill, so the actual switch is deferred to
      // executeOobResult, which performs it only after replyToTelegram has
      // been sent.
      return {
        handled: true,
        command: 'model',
        replyToTelegram: {
          text: `<b>переключаю на ${label}</b>\n\nконтекст сохранится (--continue). пиши следующее сообщение после того, как отвечу с новой модели.`,
          parseMode: 'HTML',
        },
        pendingModelSwitch: action,
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience side-effect runner used by handlers.ts. Keeps the wiring
// in one place: send the Telegram reply (if any) and emit the channel
// notification (if any). Errors during the Telegram send are logged but
// never thrown — a /help send-failure must not crash the update loop.
// ─────────────────────────────────────────────────────────────────────

export async function executeOobResult(
  result: OobResult,
  ctx: OobContext,
  server: Server,
): Promise<void> {
  if (result.replyToTelegram) {
    try {
      await ctx.telegramApi.sendMessage(ctx.chatId, result.replyToTelegram.text, {
        ...(result.replyToTelegram.parseMode !== undefined
          ? { parse_mode: result.replyToTelegram.parseMode }
          : {}),
        ...(result.replyToTelegram.replyMarkup !== undefined
          ? { reply_markup: result.replyToTelegram.replyMarkup }
          : {}),
      })
    } catch (err) {
      ctx.log.warn('oob reply send failed', {
        command: result.command,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (result.notifyChannel) {
    const event: ChannelEvent = {
      content: result.notifyChannel.content,
      meta: result.notifyChannel.meta,
    }
    await sendChannelNotification(server, event, ctx.log)
  }
  // MUST run last. tmux respawn-pane -k kills the process occupying the
  // pane — for the master DM session that is THIS process — so nothing
  // after this call is guaranteed to execute. The confirmation reply above
  // has already been sent, which is the only ordering guarantee we need.
  if (result.pendingModelSwitch && ctx.modelSwitch) {
    const target = result.pendingModelSwitch
    try {
      const switched = await ctx.modelSwitch.switchTo(target)
      if (!switched.ok) {
        // Only reachable if the process survives (e.g. respawn itself
        // failed before the kill went through) — report the failure back.
        await ctx.telegramApi.sendMessage(
          ctx.chatId,
          `<b>/model ${target}</b> — переключение не удалось: <code>${escapeHtml(switched.error ?? 'unknown error')}</code>`,
          { parse_mode: 'HTML' },
        )
      }
    } catch (err) {
      ctx.log.warn('model switch threw', {
        target,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
