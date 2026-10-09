// Pure "Up next" rules shared by the mod (register.tsx) and the OpenAdmiral app
// (app/src/lib/queue.ts imports this file). No `$`, no I/O. Contract: docs/CONTRACT.md "queue/".

export type DelegationWait = 'done' | 'blocked' | 'cancelled' | 'in_progress' | 'accepted'

/** Every day, weekdays, or chosen days, at a local HH:MM. `days`: 0 = Sunday … 6 = Saturday. */
export type ScheduleCondition = { kind: 'schedule'; time: string; days: number[] }

export type QueueCondition =
  | { kind: 'delegation'; id: string; status: DelegationWait[] }
  | { kind: 'session-idle'; sessionId: string }
  | { kind: 'time'; at: number }
  | ScheduleCondition

export type QueueItemCore = {
  id: string
  text: string
  createdAt: number
  after?: QueueCondition
  /** This item is skipped (the rest of the queue is not). */
  paused?: boolean
  /** "Run now": due regardless of its condition until a run newer than this is recorded. */
  runNowAt?: number
  /** When a schedule was set or changed: runs before this never count, so an edit does not fire at once. */
  armedAt?: number
}

export type SentEntry = {
  id: string
  at: number
  /** What was submitted (clipped), so "Recently sent" outlives the queue item. */
  text?: string
  /** The occurrence it ran for (time / schedule items); `at - due` large = a late catch-up run. */
  due?: number
  /** How it went in: as a prompt, or as a slash command through $.command.run. */
  via?: 'prompt' | 'command'
  /** It could not be submitted (an unknown or interactive slash command); recorded so it is not retried. */
  error?: string
}

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
export const WEEKDAYS = [1, 2, 3, 4, 5]

export function parseTime(hhmm: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return undefined
  const h = Number(m[1]), min = Number(m[2])
  return h < 24 && min < 60 ? { h, m: min } : undefined
}

/** The first occurrence strictly after `after` (local time), or undefined for a bad schedule. */
export function nextOccurrence(s: ScheduleCondition, after: number): number | undefined {
  const t = parseTime(s.time)
  const days = new Set(s.days.length ? s.days : ALL_DAYS)
  if (!t) return undefined
  const base = new Date(after)
  for (let i = 0; i < 8; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, t.h, t.m, 0, 0)
    if (d.getTime() > after && days.has(d.getDay())) return d.getTime()
  }
  return undefined
}

export const isRecurring = (item: { after?: QueueCondition }) => item.after?.kind === 'schedule'
export const isTimed = (item: { after?: QueueCondition }) => item.after?.kind === 'schedule' || item.after?.kind === 'time'

/** The latest recorded run of an item. */
export function lastRun(sent: readonly SentEntry[], id: string): number | undefined {
  let at: number | undefined
  for (const s of sent) if (s.id === id && (at === undefined || s.at > at)) at = s.at
  return at
}

/** A one-shot item that ran (and was not asked to run again since) is done; a schedule never is. */
export function isDone(item: QueueItemCore, sent: readonly SentEntry[]): boolean {
  if (isRecurring(item)) return false
  const last = lastRun(sent, item.id)
  if (last === undefined) return false
  return !(item.runNowAt !== undefined && item.runNowAt > last)
}

/** Run now was pressed and has not been served yet. */
export function runNowPending(item: QueueItemCore, sent: readonly SentEntry[]): boolean {
  if (item.runNowAt === undefined) return false
  const last = lastRun(sent, item.id)
  return last === undefined || item.runNowAt > last
}

/**
 * When a time or schedule item is (or was) due next; undefined for other items.
 * A schedule counts from its last run, or from when it was armed: so after any
 * number of missed occurrences it is due once (one catch-up), then re-arms.
 */
export function nextDue(item: QueueItemCore, sent: readonly SentEntry[]): number | undefined {
  const after = item.after
  if (!after) return undefined
  if (after.kind === 'time') return isDone(item, sent) ? undefined : after.at
  if (after.kind !== 'schedule') return undefined
  const base = Math.max(lastRun(sent, item.id) ?? 0, item.armedAt ?? item.createdAt)
  return nextOccurrence(after, base)
}

/** A timed item whose time has come (or one with Run now pending). Conditions of other kinds are the caller's. */
export function isDueByTime(item: QueueItemCore, sent: readonly SentEntry[], now: number): boolean {
  if (runNowPending(item, sent)) return true
  const due = nextDue(item, sent)
  return due !== undefined && due <= now
}

/** Does anything in this queue need its session now (Run now, or a due time) — what the app resumes a closed session for. */
export function needsSessionNow(queue: { paused?: boolean; items?: QueueItemCore[] } | undefined, sent: readonly SentEntry[], now: number): boolean {
  if (!queue || queue.paused) return false
  return (queue.items ?? []).some(i => !i.paused && i.text.trim() !== '' && (runNowPending(i, sent) || (isTimed(i) && isDueByTime(i, sent, now))))
}

// ── Slash commands ──────────────────────────────────────────────────────────

/** How a slash command in the queue runs: both go through $.command.run (a "/" prompt is refused by the host). */
export type QueueCommandKind = 'command' | 'skill'
export type QueueCommand = { name: string; kind: QueueCommandKind; description?: string }

/** Built-ins verified to run unattended from the queue (no screen to answer). */
export const RUNNABLE_BUILTINS = new Set(['clear', 'compact', 'rename', 'reload-plugins', 'context'])
/** Built-in skills / prompt commands: they expand into a model turn. */
export const PROMPT_BUILTINS = new Set(['simplify', 'code-review', 'security-review', 'review', 'init', 'verify', 'batch', 'insights'])
/** Built-ins that open a picker or a screen, or end the session: never from the queue. */
export const INTERACTIVE_BUILTINS = new Set([
  'model', 'config', 'usage', 'cost', 'status', 'resume', 'exit', 'stop', 'help', 'permissions', 'mcp', 'plugin', 'agents',
  'memory', 'theme', 'login', 'logout', 'hooks', 'tasks', 'skills', 'rewind', 'export', 'ide', 'keybindings', 'statusline',
  'tui', 'effort', 'output-style', 'remote-control', 'add-dir', 'doctor', 'fast', 'focus', 'background', 'desktop', 'teleport',
  'branch', 'fork', 'btw', 'cd', 'privacy-settings', 'sandbox', 'plan', 'workflows', 'artifacts', 'upgrade', 'feedback', 'bug',
])

/** From `$.command.list()`: the commands Up next may run, and how. */
export function queueCommandsFrom(list: readonly { name: string; description?: string; source: string }[]): QueueCommand[] {
  const out: QueueCommand[] = []
  for (const c of list) {
    const name = c.name.replace(/^\//, '')
    const description = c.description ? c.description.slice(0, 80) : undefined
    if (c.source === 'builtin') {
      if (RUNNABLE_BUILTINS.has(name)) out.push({ name, kind: 'command', description })
      else if (PROMPT_BUILTINS.has(name)) out.push({ name, kind: 'skill', description })
    } else out.push({ name, kind: 'skill', description })
  }
  return out
}

export function parseSlash(text: string): { name: string; args: string } | undefined {
  const m = /^\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!, args: (m[2] ?? '').trim() } : undefined
}

export type Classified =
  | { kind: 'prompt' }
  | { kind: 'command' | 'skill'; name: string; args: string }
  | { kind: 'rejected'; name: string; reason: string }

/**
 * What a queued text is. `commands` is the session's `queueCommands`; absent
 * (a mod that predates it), every slash command is refused.
 */
export function classifyQueueText(text: string, commands: readonly QueueCommand[] | undefined): Classified {
  if (!text.trim().startsWith('/')) return { kind: 'prompt' }
  const slash = parseSlash(text)
  if (!slash) return { kind: 'rejected', name: '', reason: 'A prompt cannot start with “/” unless it is a slash command.' }
  const { name, args } = slash
  if (!commands) return { kind: 'rejected', name, reason: 'This session’s OpenAdmiral mod is too old for slash commands: run /reload-plugins in it first.' }
  const found = commands.find(c => c.name === name)
  if (found) return { kind: found.kind, name, args }
  if (INTERACTIVE_BUILTINS.has(name)) return { kind: 'rejected', name, reason: `/${name} opens a screen that needs you there, so it cannot run from Up next.` }
  return { kind: 'rejected', name, reason: `/${name} is not a command Up next can run in this session.` }
}
