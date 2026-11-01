import type { EngineInterface, Register } from 'claude-code'
import { ICON, parseAnswer, repoHolds, slugOf } from './card'
import { classifyQueueText, isDone, isDueByTime, isTimed, nextDue, queueCommandsFrom, runNowPending, type QueueCommand, type QueueCondition, type QueueItemCore, type SentEntry } from './queue'
import { hostOf, type Host } from './host'
import { backgroundStart, taskNotification, upsertJob, type Job } from './jobs'

const OPENS_IN_APP = new Set(['html', 'image', 'pdf'])

// Contract: docs/CONTRACT.md. This module is the writer side.

type Status = 'starting' | 'idle' | 'working' | 'waiting' | 'ended'
type ActivityKind = 'prompt' | 'tool' | 'reply' | 'sent' | 'received' | 'permission'
type TaskStatus = 'pending' | 'in_progress' | 'completed'

type ProgressReport = { percent: number; step?: string; at: number }
type Task = { id: string; subject: string; status: TaskStatus; activeForm?: string }
type Subagent = { id: string; type?: string; description?: string; status: 'running' | 'done' | 'failed'; startedAt: number; progress?: ProgressReport[] }

type AdmiralSession = {
  v: 1
  sessionId: string
  cwd: string
  project: string
  repo?: { root: string; remote: string | null }
  branch?: string
  worktree?: boolean
  dirty?: number
  model?: string
  status: Status
  waiting?: { reason: 'permission' | 'question' | 'idle_prompt'; detail?: string; since: number }
  turn?: { startedAt: number; prompt: string; progress?: ProgressReport[] }
  // The last turn that ran long or reported progress: done, or stopped short of 100.
  lastTurn?: { startedAt: number; endedAt: number; percent?: number; step?: string }
  // Shell commands run in the background: the app measures their progress from their output.
  jobs?: Job[]
  lastTool?: { name: string; summary: string; at: number }
  lastReply?: string
  context?: { tokens?: number; window: number; percent?: number; usablePercent?: number }
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
  tasks?: Task[]
  subagents?: Subagent[]
  activity?: { at: number; kind: ActivityKind; text: string }[]
  remote?: { enabled?: boolean; clients: number; session?: boolean }
  supersededBy?: string
  commands?: string[]
  queueCommands?: QueueCommand[]
  host?: Host                  // where it runs: { app: 'VS Code', kind: 'extension' | 'terminal' }
  plugin?: { loadedAt: number }  // when this code was loaded: the app compares it with the plugin's files to spot a session needing /reload-plugins
  startedAt: number
  updatedAt: number
}

type AdmiralQueue = { v: 1; paused: boolean; items: QueueItemCore[]; updatedAt: number }
type AdmiralQueueSent = { v: 1; sent: SentEntry[] }

type ArtifactKind = 'html' | 'markdown' | 'mermaid' | 'image' | 'pdf' | 'diff' | 'text'
type AdmiralArtifact = {
  v: 1
  id: string
  sessionId: string
  project: string
  title: string
  kind: ArtifactKind
  versions: { n: number; file: string; createdAt: number; note?: string; sourcePath?: string }[]
  updatedAt: number
}

const HEARTBEAT_MS = 20_000
const REQUEST_POLL_MS = 2_000
const FILL_POLL_MS = 400
const CHIP_COMMANDS = new Set(['model', 'usage', 'cost', 'status', 'compact', 'context', 'clear', 'remote-control', 'rename'])
// Commands the app may run outright (no Enter from the user): harmless, explicit choices.
const RUNNABLE = new Set(['rename'])
const REQUEST_MAX_AGE_MS = 10 * 60_000
const QUEUE_IDLE_GRACE_MS = 3_000
const STALE_MS = 90_000
const GIT_EVERY_MS = 10_000
const MAX_ACTIVITY = 40

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

// One session per process; module variables reset on reload, so session.start rebuilds them.
let me: AdmiralSession | undefined
let root = ''
let flushTimer: { cancel: () => void } | undefined
let lastGitAt = 0
let exiting = false
// When the main loop last went idle; undefined while a turn runs or a queued prompt is in flight.
let idleSince: number | undefined
const todoIds = new Map<string, Task>()

async function admiralRoot($: EngineInterface) {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const root = `${configDir}/openadmiral`
  // Data from when this was called Fleet moves over once; if the new folder already
  // exists, the app merges what is left on its next start.
  await $.process
    .run(['/bin/sh', '-c', '[ -d "$1" ] && [ ! -e "$2" ] && mv "$1" "$2"; true', 'sh', `${configDir}/fleet`, root], { timeoutMs: 3000 })
    .catch(() => undefined)
  return root
}

function touch($: EngineInterface, patch: Partial<AdmiralSession> = {}) {
  if (!me) return
  Object.assign(me, patch)
  // Coalesce bursts of tool calls into one write.
  flushTimer?.cancel()
  flushTimer = $.clock.after(250, () => void flush($))
}

// When this module was loaded (session start or the last /reload-plugins), stamped on
// the first write after it.
let loadedAt: number | undefined

// Where this session runs, read once per load (its environment does not change).
let hostRead = false

async function flush($: EngineInterface) {
  if (!me) return
  me.updatedAt = await $.clock.now()
  loadedAt ??= me.updatedAt
  me.plugin = { loadedAt }
  if (!hostRead) {
    hostRead = true
    const entrypoint = (await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)) ?? undefined
    const termProgram = (await $.env.get('TERM_PROGRAM').catch(() => undefined)) ?? undefined
    const bundleId = (await $.env.get('__CFBundleIdentifier').catch(() => undefined)) ?? undefined
    me.host = hostOf({ entrypoint, termProgram, bundleId })
  }
  await $.fs.write(`${root}/sessions/${me.sessionId}.json`, JSON.stringify(me, null, 1))
}

/**
 * /clear starts a new conversation inside the same process: the session id
 * changes and session.start does not fire again. Follow it: close the old file
 * (pointing at the new id, so the app moves its row and selection) and carry on
 * under the new id with a fresh conversation state.
 */
async function followSessionId($: EngineInterface) {
  if (!me) return
  const id = await $.session.id().catch(() => undefined)
  if (!id || id === me.sessionId) return
  const now = await $.clock.now()
  const old = me
  await $.fs.write(`${root}/sessions/${old.sessionId}.json`, JSON.stringify({ ...old, status: 'ended', supersededBy: id, updatedAt: now }, null, 1))
  me = { ...old, sessionId: id, status: 'idle', startedAt: now, updatedAt: now, turn: undefined, waiting: undefined, context: undefined, tasks: undefined, subagents: undefined, activity: [], lastReply: undefined, lastTool: undefined }
  todoIds.clear()
  // A queued /clear must not strand the rest of Up next under the old id: move the
  // queue files along (only when the new id has none; the app merges any stragglers).
  await $.process
    .run(
      ['/bin/sh', '-c', 'cd "$1" 2>/dev/null || exit 0; for x in json sent.json; do [ -e "$3.$x" ] && [ ! -e "$2.$x" ] && mv "$3.$x" "$2.$x"; done; exit 0', 'sh', `${root}/queue`, id, old.sessionId],
      { timeoutMs: 3_000 },
    )
    .catch(() => undefined)
  idleSince = now
  await flush($)
  await refreshUsage($).catch(() => undefined)
}

async function log($: EngineInterface, kind: ActivityKind, text: string) {
  if (!me) return
  const activity = [...(me.activity ?? []), { at: await $.clock.now(), kind, text: clip(text, 160) }]
  touch($, { activity: activity.slice(-MAX_ACTIVITY) })
}

async function git($: EngineInterface, args: string[]) {
  // A cwd that no longer exists (a removed worktree) rejects: treat it as "no answer".
  const ran = await $.process.run(['git', ...args], { cwd: me?.cwd, timeoutMs: 3000 }).catch(() => undefined)
  return ran && ran.exitCode === 0 ? ran.stdout.trim() : undefined
}

async function refreshGit($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!me || (!force && now - lastGitAt < GIT_EVERY_MS)) return
  lastGitAt = now
  // The session moves (/cd, entering or leaving a worktree): follow its root, which a
  // shell `cd` does not move (cwd() would, and a subfolder is not where the session is).
  const cwd = await $.session.root().catch(() => undefined)
  if (cwd && cwd !== me.cwd) touch($, { cwd, project: basename(cwd) })
  const found = await $.session.repo().catch(() => null)
  // session.repo() follows a shell `cd`: a repo in a subfolder is not where the session is.
  const repo = found && repoHolds(found.root, me.cwd) ? found : null
  if (!repo) return touch($, { repo: undefined, project: basename(me.cwd), branch: undefined, dirty: undefined, worktree: undefined })
  const [branch, gitDir, commonDir, porcelain] = await Promise.all([
    git($, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, ['rev-parse', '--path-format=absolute', '--git-dir']),
    git($, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git($, ['status', '--porcelain']),
  ])
  touch($, {
    repo: { root: repo.root, remote: repo.remote },
    project: basename(repo.root),
    branch,
    worktree: gitDir !== undefined && commonDir !== undefined && gitDir !== commonDir,
    dirty: porcelain === undefined ? undefined : porcelain.split('\n').filter(Boolean).length,
  })
}

async function refreshUsage($: EngineInterface) {
  if (!me) return
  const usage = await $.session.usage().catch(() => undefined)
  const model = await $.session.model().catch(() => undefined)
  if (!usage) return touch($, { model })
  touch($, {
    model,
    context: {
      tokens: usage.context.tokens,
      window: usage.context.window,
      percent: usage.context.percent,
      usablePercent: await usablePercent($, usage.context.percent, usage.context.window),
    },
    rateLimits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
    costUsd: usage.cost?.usd,
  })
}

async function listJson<T>($: EngineInterface, dir: string): Promise<T[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const out: T[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as T)
    } catch {}
  }
  return out
}

function toolSummary(tool: string, e: Record<string, unknown>): string {
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  switch (tool) {
    case 'Bash': return s('description') || s('command')
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return basename(s('file_path') || s('notebook_path'))
    case 'Grep': case 'Glob': return s('pattern')
    case 'WebFetch': return s('url')
    case 'WebSearch': return s('query')
    case 'Agent': return s('description')
    case 'Skill': return s('skill')
    case 'SendMessage': return `→ ${String(e.to ?? '')}`
    default: return ''
  }
}

// The OpenAdmiral app asks a session to end (requests/<sessionId>.json, { action, at }):
// `handoff` exits so the app can resume it with `claude --bg --resume`; `exit`
// just closes it. Either waits until the session is idle. The mod has no
// delete, so it marks the request served.
async function serveRequest($: EngineInterface) {
  if (!me || exiting || me.status !== 'idle') return
  // An editor's Claude Code panel does not close on /exit: the session would stay, and
  // `exiting` would stop its Up next. The app neither asks it; a leftover request waits out.
  if (me.host?.kind === 'extension') return
  const path = `${root}/requests/${me.sessionId}.json`
  let request: { action?: string; at?: number; servedAt?: number; waiting?: string }
  try {
    request = JSON.parse(await $.fs.read(path))
  } catch {
    return
  }
  if ((request.action !== 'handoff' && request.action !== 'exit') || request.servedAt) return
  const now = await $.clock.now()
  if (now - (request.at ?? 0) > REQUEST_MAX_AGE_MS) return
  // /exit asks for confirmation while background agents run, and nobody can answer
  // that dialog from here: wait for them, and say so where the app can show it.
  const busy = (await $.agent.list().catch(() => [])).filter(x => x.status === 'running' || x.status === 'pending')
  if (busy.length) {
    const waiting = `${busy.length} background agent${busy.length > 1 ? 's' : ''} still running`
    if (request.waiting !== waiting) await $.fs.write(path, JSON.stringify({ ...request, waiting }))
    return
  }
  exiting = true
  await $.fs.write(path, JSON.stringify({ ...request, servedAt: now }))
  await log($, 'tool', request.action === 'handoff' ? 'Handing over to OpenAdmiral' : 'Closed from OpenAdmiral')
  await flush($)
  await $.command.run({ command: 'exit' }).catch(() => {
    exiting = false
  })
}

// Background commands: where their output goes (from the Bash result) and how they end
// (from the <task-notification> the session receives).
async function noteJobs($: EngineInterface, message: { type?: string; content?: unknown }) {
  if (!me || message.type !== 'user') return
  const texts = typeof message.content === 'string' ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap(b => {
        const block = b as { type?: string; text?: unknown; content?: unknown }
        const c = block.type === 'tool_result' ? block.content : block.text
        return typeof c === 'string' ? [c] : Array.isArray(c) ? c.map(x => String((x as { text?: unknown }).text ?? '')) : []
      })
    : []
  let jobs = me.jobs ?? []
  const now = await $.clock.now()
  for (const text of texts) {
    const started = backgroundStart(text)
    if (started) jobs = upsertJob(jobs, started, now)
    const ended = taskNotification(text)
    // Only jobs this session started: a notification about a subagent is not a shell job.
    if (ended && jobs.some(j => j.id === ended.id)) jobs = upsertJob(jobs, { ...ended, endedAt: ended.status === 'running' ? undefined : now }, now)
  }
  if (jobs !== (me.jobs ?? [])) touch($, { jobs })
}

async function refreshSettings($: EngineInterface) {
  const settings = await readJson<{ showProgressCalls?: boolean }>($, `${root}/settings.json`)
  const show = settings?.showProgressCalls === true
  if (show !== showProgressCalls) {
    showProgressCalls = show
    // Already drawn rows follow the new choice.
    $.ui.invalidate('ui.render')
  }
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function conditionHolds($: EngineInterface, after: QueueCondition | undefined, now: number) {
  // Time is checked by the caller. Any other kind counts as no condition, so an old item
  // queued to run after a delegation (a feature since removed) runs instead of staying stuck.
  if (after?.kind !== 'session-idle') return true
  const other = await readJson<AdmiralSession>($, `${root}/sessions/${after.sessionId}.json`)
  return other !== undefined && other.status === 'idle' && now - other.updatedAt < STALE_MS
}

// "Up next": prompts the person queued in the OpenAdmiral app (queue/<sessionId>.json,
// the app's to write). Once this session has been idle a moment, submit the
// first one that is due (Run now first, then in order: its time has come and its
// condition holds), and record it in .sent.json. Slash commands go through
// $.command.run (the host refuses a "/" prompt); unknown or interactive ones are
// recorded with an error instead of being retried.
async function serveQueue($: EngineInterface) {
  if (!me || exiting || me.status !== 'idle' || idleSince === undefined) return
  const now = await $.clock.now()
  if (now - idleSince < QUEUE_IDLE_GRACE_MS) return
  const base = `${root}/queue/${me.sessionId}`
  const queue = await readJson<AdmiralQueue>($, `${base}.json`)
  if (!queue || queue.paused || !queue.items?.length) return
  const sent = (await readJson<AdmiralQueueSent>($, `${base}.sent.json`)) ?? { v: 1, sent: [] }
  const live = queue.items.filter(i => !i.paused && i.text.trim() && !isDone(i, sent.sent))
  let item = live.find(i => runNowPending(i, sent.sent))
  for (const i of item ? [] : live) {
    if (isTimed(i) && !isDueByTime(i, sent.sent, now)) continue
    if (!(await conditionHolds($, i.after, now))) continue
    item = i
    break
  }
  if (!item) return
  const what = classifyQueueText(item.text, me.queueCommands)
  // Right after start the command list may not be in yet: wait for it rather than refuse.
  if (what.kind === 'rejected' && !me.queueCommands) return
  idleSince = undefined
  const entry: SentEntry = { id: item.id, at: now, text: clip(item.text, 300), via: what.kind === 'prompt' ? 'prompt' : 'command' }
  if (isTimed(item) && !runNowPending(item, sent.sent)) entry.due = nextDue(item, sent.sent)
  if (what.kind === 'rejected') entry.error = what.reason
  sent.sent = [...sent.sent.slice(-199), entry]
  await $.fs.write(`${base}.sent.json`, JSON.stringify(sent))
  if (what.kind === 'rejected') {
    idleSince = now
    return
  }
  if (what.kind === 'prompt') {
    await $.prompt.submit({ text: item.text, asUser: true })
    return
  }
  const ran = await $.command.run({ command: what.name, args: what.args }).then(
    () => undefined,
    (err: unknown) => String(err),
  )
  if (ran) {
    entry.error = clip(ran, 200)
    await $.fs.write(`${base}.sent.json`, JSON.stringify(sent))
  }
  // A local command (/compact, /clear, /rename) starts no turn: the session is idle
  // again once it returns. A skill queues a turn, whose end sets idleSince.
  if (ran || what.kind === 'command') idleSince = await $.clock.now()
}

const ARTIFACT_KINDS: ArtifactKind[] = ['html', 'markdown', 'mermaid', 'image', 'pdf', 'diff', 'text']
const KIND_BY_EXT: Record<string, ArtifactKind> = {
  html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', mmd: 'mermaid', mermaid: 'mermaid',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf', diff: 'diff', patch: 'diff', txt: 'text', log: 'text', json: 'text',
}
const EXT_BY_KIND: Record<ArtifactKind, string> = {
  html: 'html', markdown: 'md', mermaid: 'mmd', image: 'svg', pdf: 'pdf', diff: 'diff', text: 'txt',
}
const extOf = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
const slug = (title: string) =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact'

const SHOW_GUIDANCE = `# Showing things to the user (OpenAdmiral)
The user watches this session in the OpenAdmiral app, which can display artifacts beside the terminal. Whenever you produce something meant to be looked at rather than read in the chat — a report, plan, comparison, diagram, chart, image, mockup, rendered page, or a long document — call the openadmiral \`show\` tool with it instead of (or in addition to) describing it, and do not open it with \`open\`/Preview. Pass a file you wrote (\`path\`) or inline \`content\`. Re-show with the same \`title\` to publish a new version (say what changed in \`note\`). HTML must be self-contained (inline CSS/JS/images; CDN scripts are fine). Keep the chat reply to a short summary.`

// Percent weighted by effort, and a report before long output: a trial showed counting phases
// runs far ahead of the real work (docs/CONTRACT.md, turn.progress).
const PROGRESS_GUIDANCE = `# Progress of long work (OpenAdmiral)
The user follows this session in OpenAdmiral, which shows a progress bar and how long is left for long turns, measured from your reports; they often step away and rely on it to know how far along you are. Whenever a request takes more than about 30 seconds of work (several tool calls, a change across files, an investigation, a batch of items), report with the openadmiral \`progress\` tool: once you have sized up the work, before the first change (say 5), then after each real milestone (a file finished, a step done, a test run; not after every tool call), and 100 only when everything is finished and verified, as your last action before the final answer. A subagent reports the share of its own task.
\`percent\` is the share of the total time the work will take, not the share of phases done. Weigh each part by how long it takes: reading and planning are usually quick, while writing a long file or a long answer, editing many files, and running builds or tests are slow and deserve most of the share. So after reading the code you are often only at 15–30 %, not halfway. Right before you start writing a long file or your final long answer, report (that is the longest stretch with no tool calls), and if you find more work than you thought, lower the percent rather than leave a number you no longer believe. When unsure, report lower. \`step\` says what you are doing now in a few words, in the user's language. Never estimate time: OpenAdmiral measures the pace. Skip it for quick answers, and don't mention it in your reply.
Run a shell command you expect to take more than about two minutes (a full build, a test suite, a long script) with the Bash tool's \`run_in_background\` and a short \`description\`, then wait for its completion notice instead of polling it: OpenAdmiral measures its progress from its own output (a foreground command shows nothing until it ends), so prefer flags that print counts or percentages.`

// A plugin tool answers the model with text; `result` must be a string too.
const answer = (text: string) => ({ result: text, text })

// Other live Claude Code sessions, for the @ typeahead and @mentions: names from
// `claude agents --json` (the address SendMessage takes), state from their OpenAdmiral
// files. Cached briefly, since the typeahead asks on every keystroke.
type Peer = { name: string; sessionId: string; project: string; branch?: string; status: string; doing?: string; since?: number }
let peerCache: { at: number; peers: Peer[] } | undefined

async function listPeers($: EngineInterface): Promise<Peer[]> {
  const now = await $.clock.now()
  if (peerCache && now - peerCache.at < 5_000) return peerCache.peers
  const ran = await $.process.run(['claude', 'agents', '--json'], { timeoutMs: 4_000 }).catch(() => undefined)
  let agents: { sessionId: string; name?: string; cwd: string; status?: string }[] = []
  try {
    agents = ran && ran.exitCode === 0 ? JSON.parse(ran.stdout) : []
  } catch {}
  const peers: Peer[] = []
  for (const a of agents) {
    if (!a.name || a.sessionId === me?.sessionId) continue
    const s = await readJson<AdmiralSession>($, `${root}/sessions/${a.sessionId}.json`)
    peers.push({
      name: a.name,
      sessionId: a.sessionId,
      project: s?.project ?? basename(a.cwd),
      branch: s?.branch,
      status: s?.status ?? (a.status === 'busy' ? 'working' : a.status ?? 'idle'),
      doing: s?.turn?.prompt,
      since: s?.turn?.startedAt,
    })
  }
  peerCache = { at: now, peers }
  return peers
}

// How an @mention spells a session: Claude Code quotes names with spaces.
const mentionOf = (name: string) => (/^[\w.-]+$/.test(name) ? `@${name}` : `@"${name}"`)
const nameOfMention = (text: string) => text.match(/^@"([^"]+)"$/)?.[1] ?? text.match(/^@([\w.-]+)$/)?.[1]

function describePeer(p: Peer, now: number) {
  const where = `${p.project}${p.branch ? `@${p.branch}` : ''}`
  if (p.status === 'working' && p.doing) {
    const mins = p.since ? Math.max(1, Math.round((now - p.since) / 60_000)) : undefined
    return `● working${mins ? ` ${mins}m` : ''} · "${clip(p.doing, 60)}" · ${where}`
  }
  if (p.status === 'waiting') return `⚠ waiting for permission · ${where}`
  return `○ ${p.status} · ${where}`
}

// What a turn is "on", for people: the engine's own deliveries arrive as tagged
// text (a finished background task, a peer's message), not as anything typed.
function promptLabel(text: string) {
  const t = text.trim()
  if (t.startsWith('<task-notification>')) {
    const summary = t.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
    return clip(summary ? `Background task: ${summary}` : 'A background task reported back', 200)
  }
  const tag = t.match(/^<([a-z][\w-]*)[\s>]/i)?.[1]
  if (tag) {
    const body = t.replace(/<[^>]+>/g, ' ').trim()
    return clip(body || `(${tag})`, 200)
  }
  return clip(t, 200)
}

// The engine's own list of this session's agents is the truth about what runs:
// a fork or a resumed agent never shows up as a backgrounded Agent call.
async function refreshSubagents($: EngineInterface) {
  if (!me) return
  const listed = await $.agent.list().catch(() => undefined)
  if (!listed) return
  const now = await $.clock.now()
  const before = new Map((me.subagents ?? []).map(s => [s.id, s]))
  const seen = new Set<string>()
  const merged: Subagent[] = listed.map(a => {
    seen.add(a.id)
    const status: Subagent['status'] =
      a.status === 'running' || a.status === 'pending' || a.status === 'waiting' ? 'running'
      : a.status === 'failed' || a.status === 'killed' ? 'failed'
      : 'done'
    const prev = before.get(a.id)
    return { id: a.id, type: a.type, description: a.description || a.name || prev?.description, status, startedAt: prev?.startedAt ?? now, progress: prev?.progress }
  })
  // Agents the engine has dropped stay in the history, no longer running.
  for (const prev of before.values()) {
    if (!seen.has(prev.id)) merged.push(prev.status === 'running' ? { ...prev, status: 'done' } : prev)
  }
  merged.sort((x, y) => x.startedAt - y.startedAt)
  const next = merged.slice(-20)
  if (JSON.stringify(next) !== JSON.stringify(me.subagents ?? [])) touch($, { subagents: next })
}

// Claude Code keeps part of the window free for auto-compaction (16.5% by default,
// or CLAUDE_CODE_AUTO_COMPACT_WINDOW tokens): "used" that matters is of the rest,
// so 100% is where it compacts. The same number the GSD statusline shows.
async function usablePercent($: EngineInterface, percent: number | undefined, window: number) {
  if (percent === undefined) return undefined
  const acw = Number((await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) ?? 0)
  const buffer = acw > 0 && window > 0 ? Math.min(100, (acw / window) * 100) : 16.5
  if (buffer >= 100) return 100
  return Math.max(0, Math.min(100, Math.round((percent / (100 - buffer)) * 100)))
}

// Remote Control: whether it is switched on (the /config row, found by name since
// its key is the engine's) and how many remote clients (phone, claude.ai) are attached.
async function refreshRemote($: EngineInterface) {
  if (!me) return
  const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
  const clients = surfaces.filter(s => s === 'mobile' || s === 'desktop').length
  const rows = await $.config.list().catch(() => [])
  const row = rows.find(r => /remote.?control/i.test(r.key) || /remote control/i.test(r.label))
  const enabled = row === undefined ? undefined : row.value === true || row.value === 'true' || row.value === 'on'
  // Turning Remote Control on lands in the transcript as a bridge_status notice that no
  // hook sees; its last word there (active / disconnected) is the session's state.
  const fromTranscript = await remoteFromTranscript($)
  if (fromTranscript !== undefined) sessionRemote = fromTranscript
  // A session turned on with /remote-control counts even if the /config default is off.
  const next = { enabled: sessionRemote ?? enabled ?? (clients > 0 ? true : undefined), clients, session: sessionRemote }
  if (JSON.stringify(next) !== JSON.stringify(me.remote)) touch($, { remote: next })
}

// The app asks to put a command in this session's prompt box (fill/<sessionId>.json,
// { text, at }): a chip pressed in OpenAdmiral. The draft is filled, never submitted.
let lastFillAt = 0
// Set by /remote-control in this session (its answer says active or not); undefined until then.
let sessionRemote: boolean | undefined
async function serveFill($: EngineInterface) {
  if (!me) return
  const fill = await readJson<{ text?: string; command?: string; args?: string; at?: number }>($, `${root}/fill/${me.sessionId}.json`)
  if (!fill?.at || fill.at <= lastFillAt) return
  lastFillAt = fill.at
  if ((await $.clock.now()) - fill.at > 30_000) return
  if (fill.command && RUNNABLE.has(fill.command)) {
    // e.g. { command: 'rename', args: 'auth-scopes' }: run it as if typed and entered.
    await $.command.run({ command: fill.command, args: fill.args ?? '' } as never)
    peerCache = undefined
    return
  }
  if (fill.text) await $.prompt.fill({ text: fill.text, mode: 'replace' })
}

async function remoteFromTranscript($: EngineInterface): Promise<boolean | undefined> {
  if (!me) return undefined
  const projects = `${root.replace(/\/openadmiral$/, '')}/projects`
  // Unescaped "subtype":"…" only appears on the row itself, never inside quoted content.
  const ran = await $.process
    .run(
      ['/bin/sh', '-c', 'grep -hE \'"subtype":"(bridge_status|local_command)"\' "$1"/*/"$2".jsonl 2>/dev/null | tail -n 40', 'sh', projects, me.sessionId],
      { timeoutMs: 3_000 },
    )
    .catch(() => undefined)
  let state: boolean | undefined
  for (const line of ran?.stdout.split('\n') ?? []) {
    let row: { type?: string; subtype?: string; content?: unknown }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.type !== 'system') continue
    const text = typeof row.content === 'string' ? row.content : ''
    if (row.subtype === 'bridge_status' && /is active/i.test(text)) state = true
    else if (row.subtype === 'local_command' && /Remote Control disconnected/i.test(text)) state = false
  }
  return state
}

const STATUS_TOOL = 'status'
const SHOW_TOOL = 'show'
const PROGRESS_TOOL = 'progress'
let progressOn = false
// The app's settings.json (docs/CONTRACT.md): progress calls stay out of the chat unless asked for.
let showProgressCalls = false
let lastNudgeAt = 0
// A long turn with no recent report gets a reminder beside the next tool result.
const NUDGE_AFTER_MS = 30_000
const NUDGE_GAP_MS = 45_000
const NUDGE_TAG = 'OpenAdmiral progress'
// A turn this long is remembered once it ends (lastTurn), even without reports.
const LAST_TURN_MIN_MS = 30_000

function progressNudgeText(now: number): string | undefined {
  const turn = me?.turn
  if (!progressOn || !turn || now - turn.startedAt < NUDGE_AFTER_MS || now - lastNudgeAt < NUDGE_GAP_MS) return undefined
  const last = turn.progress?.at(-1)
  if (last && (last.percent >= 100 || now - last.at < NUDGE_GAP_MS)) return undefined
  const secs = Math.round((now - turn.startedAt) / 1000)
  return last
    ? `<system-reminder>${NUDGE_TAG}: this turn has run ${secs} s and your last progress report (${last.percent}%) is ${Math.round((now - last.at) / 1000)} s old. If the work goes on, call mcp__openadmiral__progress with the updated percent and step. Don't mention this reminder.</system-reminder>`
    : `<system-reminder>${NUDGE_TAG}: this turn has run ${secs} s with no progress report. If the work goes on, call mcp__openadmiral__progress now with percent and step, and keep reporting at each milestone. Don't mention this reminder.</system-reminder>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = await admiralRoot($)
    const sessionId = await $.session.id()
    const now = await $.clock.now()
    let previous: Partial<AdmiralSession> = {}
    try {
      previous = JSON.parse(await $.fs.read(`${root}/sessions/${sessionId}.json`))
    } catch {}
    me = {
      v: 1,
      sessionId,
      cwd: e.cwd,
      project: basename(e.cwd),
      status: 'idle',
      startedAt: previous.startedAt ?? now,
      updatedAt: now,
      tasks: previous.tasks,
      subagents: previous.subagents,
      activity: previous.activity,
      lastReply: previous.lastReply,
    }
    todoIds.clear()
    for (const t of me.tasks ?? []) todoIds.set(t.id, t)

    await $.tool.register({
      name: STATUS_TOOL,
      description:
        'List the Claude Code sessions on this machine (project, branch, status, current task), to decide whom to message with SendMessage or what you are waiting on.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: SHOW_TOOL,
      isDeferred: false,
      description:
        'Show the user an artifact in the OpenAdmiral app (report, plan, diagram, comparison image, chart, page, document). ' +
        'Pass a file path or inline content; showing the same title again adds a new version. Prefer this over opening files with `open` or describing visuals in the chat.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human title; the same title adds a version.' },
          path: { type: 'string', description: 'A file to show (absolute or relative to the working directory). Copied into OpenAdmiral.' },
          content: { type: 'string', description: 'Inline content instead of a path (HTML, Markdown, Mermaid, SVG, diff, text).' },
          kind: { type: 'string', enum: ARTIFACT_KINDS, description: 'Defaults from the file extension, else markdown.' },
          note: { type: 'string', description: 'What this version shows or changed.' },
        },
        required: ['title'],
      },
    })

    // OPENADMIRAL_PROGRESS=0 turns progress reports off for a session.
    progressOn = (await $.env.get('OPENADMIRAL_PROGRESS').catch(() => undefined)) !== '0'
    lastNudgeAt = 0
    if (progressOn) await $.tool.register({
      name: PROGRESS_TOOL,
      isDeferred: false,
      description:
        'Report how far along a long piece of work is, so the user sees a progress bar and an ETA in OpenAdmiral. ' +
        'Use it whenever the work takes more than about 30 seconds: once the scope is clear, at each milestone, and with 100 as the last action when everything is finished and verified.',
      inputSchema: {
        type: 'object',
        properties: {
          percent: { type: 'number', minimum: 0, maximum: 100, description: 'Share of the whole task done, weighted by effort and counting work still ahead (tests, verification), 0–100.' },
          step: { type: 'string', description: 'What you are doing now, in a few words.' },
        },
        required: ['percent'],
      },
    })

    await refreshGit($, true)
    await refreshUsage($)
    await flush($)
    // Each step on its own: one failing (git in a vanished folder) must not stop the others.
    await refreshSettings($).catch(() => undefined)
    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
        await refreshSettings($).catch(() => undefined)
        await refreshGit($).catch(() => undefined)
        await refreshUsage($).catch(() => undefined)
        await refreshSubagents($).catch(() => undefined)
        await refreshRemote($).catch(() => undefined)
        await flush($).catch(() => undefined)
      })()
    })
    idleSince = now
    // Fills already on disk at start belong to an earlier load: only newer ones count.
    lastFillAt = now
    // A reload keeps what /remote-control set for this session.
    sessionRemote = previous.remote?.session
    $.clock.every(FILL_POLL_MS, () => void serveFill($).catch(() => undefined))
    void refreshRemote($).catch(() => undefined)
    // Which of the commands OpenAdmiral's chips type exist in this build, so the app offers only those.
    // And which slash commands Up next may queue (docs/CONTRACT.md "queueCommands").
    void $.command
      .list()
      .then(list =>
        touch($, {
          commands: list.map(c => c.name.replace(/^\//, '')).filter(n => CHIP_COMMANDS.has(n)),
          queueCommands: queueCommandsFrom(list),
        }),
      )
      .catch(() => undefined)
    $.clock.every(REQUEST_POLL_MS, () => {
      void followSessionId($)
        .then(() => serveRequest($))
        .then(() => serveQueue($))
        .then(() => refreshSubagents($))
        .catch(() => undefined)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    // A subagent's turn is not the person's: it must not restart the main turn (its prompt,
    // clock and progress) nor log its brief as a prompt.
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    const now = await $.clock.now()
    idleSince = undefined
    const label = promptLabel(e.text)
    touch($, { status: 'working', waiting: undefined, turn: { startedAt: now, prompt: label }, lastTurn: undefined })
    if (e.text.trim()) await log($, 'prompt', label)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      idleSince = await $.clock.now()
      const turn = me?.turn
      const last = turn?.progress?.at(-1)
      // Kept until the next prompt: the app shows "done in 9m" or where it stopped short.
      const lastTurn = turn && (last || idleSince - turn.startedAt >= LAST_TURN_MIN_MS) ? { startedAt: turn.startedAt, endedAt: idleSince, percent: last?.percent, step: last?.step } : undefined
      touch($, { status: 'idle', waiting: undefined, turn: undefined, lastTurn, lastReply: e.answer ? clip(e.answer, 200) : me?.lastReply })
      if (e.answer) await log($, 'reply', e.answer)
      await refreshGit($, true)
      await refreshUsage($)
    } else if (me?.subagents) {
      touch($, { subagents: me.subagents.map(s => (s.id === e.agentId ? { ...s, status: e.isAborted ? 'failed' : 'done' } : s)) })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const mine = tool.startsWith(`mcp__${$.plugin.name}__`)
    if (!mine && e.agentId === undefined) {
      touch($, { status: 'working', lastTool: { name: tool, summary: clip(toolSummary(tool, args), 120), at: await $.clock.now() } })
    }

    const ran = await next(e)
    if ('deny' in ran && ran.deny !== undefined) return ran
    if (me?.status === 'waiting') touch($, { status: 'working', waiting: undefined })

    if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
      const todos = args.todos as { content: string; status: TaskStatus; activeForm: string }[]
      touch($, { tasks: todos.map((t, i) => ({ id: `todo-${i}`, subject: t.content, status: t.status, activeForm: t.activeForm })) })
    } else if (tool === 'TaskCreate') {
      const created = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
      if (created) {
        todoIds.set(created.id, { id: created.id, subject: created.subject, status: 'pending', activeForm: args.activeForm as string | undefined })
        touch($, { tasks: [...todoIds.values()] })
      }
    } else if (tool === 'TaskUpdate') {
      const task = todoIds.get(String(args.taskId))
      if (task) {
        if (args.status === 'deleted') todoIds.delete(task.id)
        else {
          if (typeof args.status === 'string') task.status = args.status as TaskStatus
          if (typeof args.subject === 'string') task.subject = args.subject
        }
        touch($, { tasks: [...todoIds.values()] })
      }
    } else if (tool === 'Bash' && args.run_in_background === true) {
      const id = (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId
      const label = clip(String(args.description || args.command || ''), 80) || undefined
      if (id && me) touch($, { jobs: upsertJob(me.jobs ?? [], { id, label }, await $.clock.now()) })
    } else if (tool === 'Agent') {
      // The engine's list has it now, with its real id and status.
      await refreshSubagents($)
    } else if (tool === 'SendMessage') {
      await log($, 'sent', `→ ${String(args.to)}: ${String(args.summary ?? args.message ?? '')}`)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__openadmiral__status' }, async $ => {
    const now = await $.clock.now()
    const sessions = (await listJson<AdmiralSession>($, `${root}/sessions`)).filter(
      s => s.status !== 'ended' && now - s.updatedAt < 90_000 && !s.sessionId.startsWith('fixture-'),
    )
    const lines = [
      'Sessions:',
      ...sessions.map(
        s =>
          `- ${s.project}${s.branch ? ` @${s.branch}` : ''} [${s.status}] session ${s.sessionId}` +
          (s.turn ? ` — working on: ${s.turn.prompt}` : '') +
          (s.sessionId === me?.sessionId ? ' (you)' : ''),
      ),
    ]
    return answer(lines.join('\n'))
  }).catch(() => ({ deny: 'openadmiral: this tool failed (claude --debug has the reason).' }))

  // Claude Code offers its own row for other sessions ("message session"): keep that one
  // row per session, with what the session is doing as its description, peers first.
  // A peer the engine did not offer gets a row in the same (quoted) form.
  on('prompt.autocomplete', { token: /^@/ }, async ($, e, next) => {
    const engine = await next(e)
    const query = e.token.slice(1).replace(/^"/, '').toLowerCase()
    const now = await $.clock.now()
    const peers = await listPeers($)
    const byName = new Map(peers.map(p => [p.name, p]))
    const peerOf = (text: string) => byName.get(nameOfMention(text) ?? '')
    const enrich = <T extends { text: string; description?: string }>(row: T): T => {
      const p = peerOf(row.text)
      return p ? { ...row, description: describePeer(p, now) } : row
    }
    const wanted = peers.filter(p => !query || p.name.toLowerCase().includes(query) || p.project.toLowerCase().includes(query)).slice(0, 8)
    const native = new Map(engine.suggestions.flatMap(r => (peerOf(r.text) ? [[peerOf(r.text)!.name, r] as const] : [])))
    const top = wanted.map(p => enrich(native.get(p.name) ?? { text: mentionOf(p.name), label: mentionOf(p.name) }))
    const shown = new Set(wanted.map(p => p.name))
    const rest = engine.suggestions.filter(r => !shown.has(peerOf(r.text)?.name ?? '')).map(enrich)
    return { suggestions: [...top, ...rest] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const named = new Set([...e.text.matchAll(/@"([^"]+)"|@([\w.-]+)/g)].map(m => (m[1] ?? m[2])!))
    if (!named.size) return next(e)
    const now = await $.clock.now()
    const mentioned = (await listPeers($)).filter(p => named.has(p.name))
    if (!mentioned.length) return next(e)
    const note =
      `The user @mentioned these other Claude Code sessions (OpenAdmiral peers):\n` +
      mentioned.map(p => `- ${p.name} (session ${p.sessionId}): ${describePeer(p, now)}`).join('\n') +
      `\nIf they ask one of them to do something, hand it over with SendMessage (to: "<name>") and a self-contained brief; ` +
      `if they ask what they are doing, answer from the line above or call \`status\`.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  // The show tool's transcript row: a card with buttons, not the raw call.
  // Rows of the chat the plugin itself put there: keep them out of the person's way.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const text = String((e.props as { text?: unknown }).text ?? '')
    const expanded = !!(e.props as { isExpanded?: boolean }).isExpanded
    // A progress reminder an older plugin added as a row of its own.
    if (text.startsWith(`<system-reminder>${NUDGE_TAG}`)) {
      if (expanded) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box paddingX={1}>
          <Text dimColor>◦ OpenAdmiral asked for a progress update</Text>
        </Box>
      )
    }
    return next(e)
  })

  // Progress reports are for the app's bar, not for reading: hidden in the chat unless the
  // person turns them on (OpenAdmiral menu → Show Progress Reports in Chat).
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__openadmiral__progress' } }, ($, e, next) => {
    if (showProgressCalls || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__openadmiral__show' } }, ($, e, next) => {
    if (!me) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const sessionId = me.sessionId
    const input = (e.props.input ?? {}) as { title?: string; kind?: string; note?: string }
    const title = input.title ?? 'Artifact'
    const answered = parseAnswer(e.props.output)
    const kind = answered?.kind ?? input.kind ?? 'markdown'
    const icon = ICON[kind] ?? '◇'
    const id = slugOf(title)
    const dir = `${root}/artifacts/${sessionId}/${id}`

    if (e.props.isRunning) {
      return (
        <Box paddingX={1}>
          <Text dimColor>{icon} Showing “{title}” in OpenAdmiral…</Text>
        </Box>
      )
    }
    if (e.props.isErrored || !answered) return next(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#5c8bff" paddingX={1}>
        <Box gap={1}>
          <Text color="#a9c1ff">{icon}</Text>
          <Text bold>{title}</Text>
          <Text dimColor>· v{answered.version} · {kind}</Text>
        </Box>
        {input.note ? <Text dimColor>{input.note}</Text> : null}
        <Box gap={2}>
          <Button
            key="openadmiral"
            label="Open in OpenAdmiral"
            onPress={async () => {
              // The app watches ~/.claude/openadmiral: focus.json asks it to show this artifact.
              const at = await $.clock.now()
              await $.fs.write(`${root}/focus.json`, JSON.stringify({ kind: 'artifact', sessionId, artifactId: id, version: answered.version, at }))
              await $.process.run(['open', '-b', 'com.openadmiral.desktop'])
            }}
          />
          <Button
            key="file"
            // Pages and pictures have a good default app (browser, Preview); text kinds
            // would land in whatever editor owns .md, so those are revealed instead.
            label={OPENS_IN_APP.has(kind) ? 'Open file' : 'Reveal in Finder'}
            onPress={async () => {
              const manifest = await readJson<AdmiralArtifact>($, `${dir}/manifest.json`)
              const v = manifest?.versions.find(x => x.n === answered.version) ?? manifest?.versions.at(-1)
              if (!v) return $.ui.toast('OpenAdmiral: that artifact is no longer on disk.')
              await $.process.run(OPENS_IN_APP.has(kind) ? ['open', `${dir}/${v.file}`] : ['open', '-R', `${dir}/${v.file}`])
            }}
          />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections]
    if (e.tools.includes(`mcp__openadmiral__${SHOW_TOOL}`)) sections.push({ id: 'openadmiral:show', text: SHOW_GUIDANCE, scope: 'session' as const })
    if (e.tools.includes(`mcp__openadmiral__${PROGRESS_TOOL}`)) sections.push({ id: 'openadmiral:progress', text: PROGRESS_GUIDANCE, scope: 'session' as const })
    return sections.length === composed.sections.length ? composed : { ...composed, sections }
  }).catch(($, e, next) => next(e))

  // Kept per turn: the app measures the pace from these reports (docs/CONTRACT.md).
  on('tool.call', { tool: `mcp__openadmiral__${PROGRESS_TOOL}` }, async ($, e) => {
    const args = e as unknown as { percent?: unknown; step?: unknown }
    const percent = Number(args.percent)
    if (!Number.isFinite(percent)) return answer('`percent` must be a number from 0 to 100.')
    const report: ProgressReport = { percent: Math.max(0, Math.min(100, Math.round(percent))), at: await $.clock.now() }
    if (typeof args.step === 'string' && args.step.trim()) report.step = clip(args.step.trim(), 80)
    const agentId = (e as { agentId?: string }).agentId
    if (agentId !== undefined) {
      // A subagent's own task: the app shows it while agents work on after the main turn.
      if (!me) return answer('ok')
      const list = me.subagents ?? []
      const known = list.some(x => x.id === agentId)
      const next = (known ? list : [...list, { id: agentId, status: 'running' as const, startedAt: report.at }]).map(x =>
        x.id === agentId ? { ...x, progress: [...(x.progress ?? []), report].slice(-20) } : x,
      )
      touch($, { subagents: next })
    } else if (me?.turn) {
      touch($, { turn: { ...me.turn, progress: [...(me.turn.progress ?? []), report].slice(-40) } })
    }
    return answer('ok')
  })

  on('tool.call', { tool: 'mcp__openadmiral__show' }, async ($, e) => {
    if (!me) return { deny: 'OpenAdmiral is not ready yet' }
    const args = e as unknown as { title: string; path?: string; content?: string; kind?: ArtifactKind; note?: string }
    if (!args.path === !args.content) return answer('Pass exactly one of `path` or `content`.')
    const source = args.path ? (args.path.startsWith('/') ? args.path : `${me.cwd}/${args.path}`) : undefined
    const kind: ArtifactKind =
      args.kind && ARTIFACT_KINDS.includes(args.kind) ? args.kind : (source && KIND_BY_EXT[extOf(source)]) || 'markdown'
    const id = slug(args.title)
    const dir = `${root}/artifacts/${me.sessionId}/${id}`
    const now = await $.clock.now()
    const manifest = (await readJson<AdmiralArtifact>($, `${dir}/manifest.json`)) ?? {
      v: 1, id, sessionId: me.sessionId, project: me.project, title: args.title, kind, versions: [], updatedAt: now,
    }
    const n = (manifest.versions.at(-1)?.n ?? 0) + 1
    const ext = source ? extOf(source) || EXT_BY_KIND[kind] : EXT_BY_KIND[kind]
    const file = `v${n}.${ext}`
    if (source) {
      await $.process.run(['mkdir', '-p', dir])
      const copied = await $.process.run(['cp', source, `${dir}/${file}`], { timeoutMs: 15_000 })
      if (copied.exitCode !== 0) return answer(`Could not read ${source}: ${copied.stderr.trim()}`)
    } else {
      await $.fs.write(`${dir}/${file}`, args.content!)
    }
    manifest.title = args.title
    manifest.kind = kind
    manifest.versions.push({ n, file, createdAt: now, note: args.note, sourcePath: source })
    manifest.updatedAt = now
    await $.fs.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 1))
    await log($, 'tool', `Showed "${args.title}" v${n}`)
    return answer(`Shown in OpenAdmiral: "${args.title}" (v${n}, ${kind}).`)
  }).catch(() => ({ deny: 'openadmiral: show failed (claude --debug has the reason).' }))

  on('classic.Notification', async ($, e, next) => {
    const reason =
      e.notification_type === 'permission_prompt' ? 'permission'
      : e.notification_type === 'elicitation_dialog' ? 'question'
      : undefined
    if (reason) {
      touch($, { status: 'waiting', waiting: { reason, detail: clip(e.message, 160), since: await $.clock.now() } })
      await log($, 'permission', e.message)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const tool = String((e as { tool_name?: string }).tool_name ?? 'a tool')
    touch($, { status: 'waiting', waiting: { reason: 'permission', detail: `Approve ${tool}`, since: await $.clock.now() } })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message' || e.origin.kind === 'coordinator') {
      await log($, 'received', e.text)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await refreshRemote($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('session.detach', async ($, e, next) => {
    const r = await next(e)
    await refreshRemote($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // /remote-control toggles it for this session only: read its answer to know which way.
  on('command.run', { command: 'remote-control' }, async ($, e, next) => {
    const r = await next(e)
    const text = 'text' in r && typeof r.text === 'string' ? r.text : ''
    if (/\b(disabled|stopped|turned off|disconnected|not active)\b/i.test(text)) sessionRemote = false
    else if (/\b(active|enabled|connected|started)\b/i.test(text)) sessionRemote = true
    await refreshRemote($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // Turning it on arrives as a notice of its own (bridge_status: "/remote-control is
  // active · …"), not as the command's answer: watch the rows the session keeps.
  on('session.append', async ($, e, next) => {
    await noteJobs($, e.message as { type?: string; content?: unknown }).catch(() => undefined)
    // Inside the last tool result, the way Claude Code adds its own reminders: a block of
    // its own would show in the chat as if the person had typed it.
    const content = (e.message as { type?: string; content?: unknown }).content
    // Only a result of plain text takes it: the API refuses text beside a ToolSearch result's
    // tool_reference blocks (400 "Tool definitions … cannot be mixed with other content"),
    // and that row, once stored, broke every later request of the session.
    const textOnly = (b: unknown) => {
      const r = b as { type?: string; content?: unknown }
      return r?.type === 'tool_result' && (typeof r.content === 'string' || (Array.isArray(r.content) && r.content.every(x => (x as { type?: string })?.type === 'text')))
    }
    const last = Array.isArray(content) ? content.map(textOnly).lastIndexOf(true) : -1
    if (progressOn && e.message.type === 'user' && last !== -1) {
      const now = await $.clock.now()
      const text = progressNudgeText(now)
      if (text) {
        lastNudgeAt = now
        const blocks = content as { type: string; content?: unknown }[]
        const result = blocks[last]
        const inner = typeof result.content === 'string' ? `${result.content}\n\n${text}` : [...(result.content as unknown[]), { type: 'text', text }]
        const nextContent = blocks.map((b, i) => (i === last ? { ...b, content: inner } : b))
        return next({ ...e, message: { ...e.message, content: nextContent } } as typeof e)
      }
    }
    const stored = await next(e)
    if (e.message.type === 'system' && e.message.name === 'bridge_status') {
      const text = JSON.stringify(e.message.content ?? '')
      if (/\b(disconnected|disabled|stopped|inactive|not active)\b/i.test(text)) sessionRemote = false
      else if (/is active|connected|enabled/i.test(text)) sessionRemote = true
      await refreshRemote($).catch(() => undefined)
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    flushTimer?.cancel()
    if (me) {
      me.status = 'ended'
      me.turn = undefined
      me.waiting = undefined
      // Its background commands go with it; no notification will say so.
      const now = await $.clock.now()
      if (me.jobs?.some(j => j.status === 'running')) me.jobs = me.jobs.map(j => (j.status === 'running' ? { ...j, status: 'killed' as const, endedAt: now } : j))
      await flush($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
