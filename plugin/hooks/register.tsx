import type { EngineInterface, Register } from 'claude-code'
import { ICON, parseAnswer, slugOf } from './card'
import { classifyQueueText, isDone, isDueByTime, isTimed, nextDue, queueCommandsFrom, runNowPending, type QueueCommand, type QueueCondition, type QueueItemCore, type SentEntry } from './queue'

const OPENS_IN_APP = new Set(['html', 'image', 'pdf'])

// Contract: docs/CONTRACT.md. This module is the writer side.

type Status = 'starting' | 'idle' | 'working' | 'waiting' | 'ended'
type DelegationStatus = 'draft' | 'sent' | 'accepted' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
type ActivityKind = 'prompt' | 'tool' | 'reply' | 'sent' | 'received' | 'permission'
type TaskStatus = 'pending' | 'in_progress' | 'completed'

type Task = { id: string; subject: string; status: TaskStatus; activeForm?: string }
type Subagent = { id: string; type?: string; description?: string; status: 'running' | 'done' | 'failed'; startedAt: number }

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
  turn?: { startedAt: number; prompt: string }
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

type AdmiralDelegation = {
  v: 1
  id: string
  title: string
  detail: string
  from: { sessionId: string; project: string; name?: string }
  to: { address: string; sessionId?: string; project?: string }
  status: DelegationStatus
  dependsOn?: string[]
  notes: { at: number; by: string; status?: DelegationStatus; text: string }[]
  result?: string
  createdAt: number
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
const DELEGATION_STATUSES: DelegationStatus[] = ['accepted', 'in_progress', 'blocked', 'done', 'cancelled']

const clip = (text: string, n: number) => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const newId = () => 'dlg_' + Math.random().toString(36).slice(2, 10).padEnd(8, '0')

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

async function flush($: EngineInterface) {
  if (!me) return
  me.updatedAt = await $.clock.now()
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
  const repo = await $.session.repo().catch(() => null)
  if (!repo) return touch($, { repo: undefined, branch: undefined, dirty: undefined, worktree: undefined })
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

async function readDelegation($: EngineInterface, id: string): Promise<AdmiralDelegation | undefined> {
  if (!/^dlg_[a-z0-9]+$/.test(id)) return undefined
  try {
    return JSON.parse(await $.fs.read(`${root}/delegations/${id}.json`)) as AdmiralDelegation
  } catch {
    return undefined
  }
}

async function writeDelegation($: EngineInterface, d: AdmiralDelegation) {
  d.updatedAt = await $.clock.now()
  await $.fs.write(`${root}/delegations/${d.id}.json`, JSON.stringify(d, null, 1))
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

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function conditionHolds($: EngineInterface, after: QueueCondition | undefined, now: number) {
  if (!after || after.kind === 'time' || after.kind === 'schedule') return true   // time is checked by the caller
  if (after.kind === 'delegation') {
    const d = await readDelegation($, after.id)
    return d !== undefined && (after.status as string[]).includes(d.status)
  }
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

// A plugin tool answers the model with text; `result` must be a string too.
const answer = (text: string) => ({ result: text, text })

// Sends through the engine's session.send. A send a plugin makes can come back
// undecided from auto mode's classifier ("no verdict … issue it again once"),
// so retry once; the caller falls back to asking the model to SendMessage.
// Once both tries fail that way, this session stops trying: the classifier keeps
// refusing plugin sends, and each attempt only delays the model's own send.
let pluginSendsBlocked = false
const BLOCKED = 'auto mode does not let OpenAdmiral send for this session'
async function deliver($: EngineInterface, to: Parameters<EngineInterface['session']['send']>[0]['to'], text: string): Promise<string | undefined> {
  if (pluginSendsBlocked) return BLOCKED
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = await $.session
      .send({ to, text })
      .catch((err: unknown) => ({ isDelivered: false as const, reason: String(err) }))
    const failure: string | undefined =
      'deny' in sent && sent.deny ? String(sent.deny) : sent.isDelivered === false ? String(sent.reason ?? 'not delivered') : undefined
    if (!failure) return undefined
    const undecided = /no verdict|again once/i.test(failure)
    if (undecided && attempt === 1) {
      pluginSendsBlocked = true
      return BLOCKED
    }
    if (!undecided) return failure
  }
  return 'not delivered'
}

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
    return { id: a.id, type: a.type, description: a.description || a.name || prev?.description, status, startedAt: prev?.startedAt ?? now }
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

const DELEGATE_TOOL = 'delegate'
const UPDATE_TOOL = 'delegation_update'
const STATUS_TOOL = 'status'
const SHOW_TOOL = 'show'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    root = await admiralRoot($)
    pluginSendsBlocked = false
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
      name: DELEGATE_TOOL,
      isDeferred: false,
      description:
        'Delegate a piece of work to another Claude Code session (a peer working in another project, e.g. the MCP server or auth service) and track it on the OpenAdmiral board. ' +
        'Use this instead of a bare SendMessage when you hand off work you depend on. The recipient receives the brief plus the delegation id and reports progress with delegation_update. ' +
        'Write a self-contained brief: scope, files/APIs involved, acceptance checks, and what to report back (commit hash, PR, endpoint).',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient address as SendMessage takes it (the peer session name from ListAgents).' },
          title: { type: 'string', description: 'Short imperative title, e.g. "Add scopes claim to MCP auth tokens".' },
          detail: { type: 'string', description: 'The full self-contained brief.' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of other delegations this one waits on.' },
        },
        required: ['to', 'title', 'detail'],
      },
    })
    await $.tool.register({
      name: UPDATE_TOOL,
      isDeferred: false,
      description:
        'Report progress on an OpenAdmiral delegation (an id like dlg_xxxxxxxx you received or sent). Call it when you accept the work, start, get blocked, finish (with a result: commit hash, PR, what changed) or cancel. The other side is notified.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: DELEGATION_STATUSES },
          note: { type: 'string', description: 'What changed, or what is blocking.' },
          result: { type: 'string', description: 'On done: the outcome to hand back.' },
        },
        required: ['id', 'status'],
      },
    })
    await $.tool.register({
      name: STATUS_TOOL,
      description:
        'List the Claude Code sessions on this machine (project, branch, status, current task) and the open OpenAdmiral delegations, to decide whom to delegate to or what you are waiting on.',
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

    await refreshGit($, true)
    await refreshUsage($)
    await flush($)
    // Each step on its own: one failing (git in a vanished folder) must not stop the others.
    $.clock.every(HEARTBEAT_MS, () => {
      void (async () => {
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
    const now = await $.clock.now()
    idleSince = undefined
    const label = promptLabel(e.text)
    touch($, { status: 'working', waiting: undefined, turn: { startedAt: now, prompt: label } })
    if (e.text.trim()) await log($, 'prompt', label)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      idleSince = await $.clock.now()
      touch($, { status: 'idle', waiting: undefined, turn: undefined, lastReply: e.answer ? clip(e.answer, 200) : me?.lastReply })
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
    } else if (tool === 'Agent') {
      // The engine's list has it now, with its real id and status.
      await refreshSubagents($)
    } else if (tool === 'SendMessage') {
      await log($, 'sent', `→ ${String(args.to)}: ${String(args.summary ?? args.message ?? '')}`)
      for (const id of new Set(String(args.message ?? '').match(/\bdlg_[a-z0-9]{8}\b/g) ?? [])) {
        const d = await readDelegation($, id)
        if (d?.status !== 'draft') continue
        d.status = 'sent'
        d.to = { ...d.to, address: String(args.to) }
        d.notes.push({ at: await $.clock.now(), by: me?.project ?? '', status: 'sent', text: 'delivered with SendMessage' })
        await writeDelegation($, d)
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__openadmiral__delegate' }, async ($, e) => {
    if (!me) return { deny: 'OpenAdmiral is not ready yet' }
    const args = e as unknown as { to: string; title: string; detail: string; dependsOn?: string[] }
    const now = await $.clock.now()
    const d: AdmiralDelegation = {
      v: 1,
      id: newId(),
      title: clip(args.title, 120),
      detail: args.detail,
      from: { sessionId: me.sessionId, project: me.project },
      to: { address: args.to },
      status: 'draft',
      dependsOn: args.dependsOn?.length ? args.dependsOn : undefined,
      notes: [],
      createdAt: now,
      updatedAt: now,
    }
    const brief =
      `[OpenAdmiral delegation ${d.id}] from ${me.project}${me.branch ? ` (${me.branch})` : ''}\n` +
      `Title: ${d.title}\n\n${d.detail}\n\n` +
      (d.dependsOn ? `Depends on: ${d.dependsOn.join(', ')}\n` : '') +
      `Report progress with the delegation_update tool (id ${d.id}): accepted → in_progress → done (with result) or blocked (with what is missing).`
    const failure = await deliver($, args.to, brief)
    if (failure) {
      // Kept as a draft: the model's own SendMessage (which carries the id) marks it sent.
      d.notes.push({ at: now, by: me.project, status: 'draft', text: `handed to the agent to send (${clip(failure, 120)})` })
      await writeDelegation($, d)
      return answer(
        `Delegation ${d.id} is recorded but OpenAdmiral could not deliver it (${clip(failure, 160)}). ` +
          `Send it yourself now with SendMessage to "${args.to}", using exactly this message:\n\n${brief}`,
      )
    }
    d.status = 'sent'
    await writeDelegation($, d)
    await log($, 'sent', `⇢ ${args.to}: ${d.title}`)
    return answer(`Delegated as ${d.id} to ${args.to}. You will be messaged on status changes.`)
  }).catch(() => ({ deny: 'openadmiral: this tool failed (claude --debug has the reason).' }))

  on('tool.call', { tool: 'mcp__openadmiral__delegation_update' }, async ($, e) => {
    if (!me) return { deny: 'OpenAdmiral is not ready yet' }
    const args = e as unknown as { id: string; status: DelegationStatus; note?: string; result?: string }
    const d = await readDelegation($, args.id)
    if (!d) return answer(`No delegation ${args.id}.`)
    const now = await $.clock.now()
    const isSender = d.from.sessionId === me.sessionId
    if (!isSender && !d.to.sessionId) d.to = { ...d.to, sessionId: me.sessionId, project: me.project }
    d.status = args.status
    if (args.result) d.result = args.result
    d.notes.push({ at: now, by: me.project, status: args.status, text: args.note ?? args.result ?? '' })
    await writeDelegation($, d)
    const counterpart = isSender ? d.to.sessionId ?? d.to.address : d.from.sessionId
    const text =
      `[OpenAdmiral delegation ${d.id}] "${d.title}" is now ${d.status} (by ${me.project}).` +
      (args.note ? `\nNote: ${args.note}` : '') +
      (args.result ? `\nResult: ${args.result}` : '')
    const other = isSender ? d.to.project ?? d.to.address : d.from.project
    const failure = counterpart
      ? await deliver($, counterpart === d.from.sessionId || counterpart === d.to.sessionId ? { sessionId: counterpart } : counterpart, text)
      : 'no recipient known'
    await log($, isSender ? 'sent' : 'received', `${d.id} → ${d.status}`)
    if (failure) {
      return answer(
        `${d.id} is now ${d.status} on the OpenAdmiral board, but OpenAdmiral could not notify ${other} (${clip(failure, 160)}). ` +
          `Tell them yourself with SendMessage (find the session with ListAgents), using exactly this message:\n\n${text}`,
      )
    }
    return answer(`${d.id} is now ${d.status}; ${other} was notified.`)
  }).catch(() => ({ deny: 'openadmiral: this tool failed (claude --debug has the reason).' }))

  on('tool.call', { tool: 'mcp__openadmiral__status' }, async $ => {
    const now = await $.clock.now()
    const sessions = (await listJson<AdmiralSession>($, `${root}/sessions`)).filter(
      s => s.status !== 'ended' && now - s.updatedAt < 90_000 && !s.sessionId.startsWith('fixture-'),
    )
    const delegations = (await listJson<AdmiralDelegation>($, `${root}/delegations`)).filter(
      d => d.status !== 'done' && d.status !== 'cancelled' && !d.id.startsWith('fixture-'),
    )
    const lines = [
      'Sessions:',
      ...sessions.map(
        s =>
          `- ${s.project}${s.branch ? ` @${s.branch}` : ''} [${s.status}] session ${s.sessionId}` +
          (s.turn ? ` — working on: ${s.turn.prompt}` : '') +
          (s.sessionId === me?.sessionId ? ' (you)' : ''),
      ),
      '',
      'Open delegations:',
      ...(delegations.length
        ? delegations.map(d => `- ${d.id} ${d.from.project} → ${d.to.project ?? d.to.address}: ${d.title} [${d.status}]`)
        : ['- none']),
    ]
    return answer(lines.join('\n'))
  }).catch(() => ({ deny: 'openadmiral: this tool failed (claude --debug has the reason).' }))

  on('prompt.autocomplete', { token: /^@/ }, async ($, e, next) => {
    const engine = await next(e)
    const query = e.token.slice(1).toLowerCase()
    const now = await $.clock.now()
    const mine = (await listPeers($))
      .filter(p => !query || p.name.toLowerCase().includes(query) || p.project.toLowerCase().includes(query))
      .slice(0, 8)
      .map(p => ({ text: `@${p.name}`, label: `@${p.name}`, description: describePeer(p, now) }))
    return { suggestions: [...mine, ...engine.suggestions] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const named = new Set([...e.text.matchAll(/@([\w.-]+)/g)].map(m => m[1]!))
    if (!named.size) return next(e)
    const now = await $.clock.now()
    const mentioned = (await listPeers($)).filter(p => named.has(p.name))
    if (!mentioned.length) return next(e)
    const note =
      `The user @mentioned these other Claude Code sessions (OpenAdmiral peers):\n` +
      mentioned.map(p => `- ${p.name} (session ${p.sessionId}): ${describePeer(p, now)}`).join('\n') +
      `\nIf they ask one of them to do something, hand it over with the OpenAdmiral \`delegate\` tool (to: "<name>") and a self-contained brief; ` +
      `if they ask what they are doing, answer from the line above or call \`status\`.`
    return next({ ...e, context: [...(e.context ?? []), note] })
  }).catch(($, e, next) => next(e))

  // The show tool's transcript row: a card with buttons, not the raw call.
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
    if (!e.tools.includes(`mcp__openadmiral__${SHOW_TOOL}`)) return composed
    return { sections: [...composed.sections, { id: 'openadmiral:show', text: SHOW_GUIDANCE, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

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
      // A delegation brief reached its recipient: on the board it is accepted from now on,
      // not "sent" until the recipient's model gets round to delegation_update.
      const id = e.text.match(/\[OpenAdmiral delegation (dlg_[a-z0-9]{8})\] from /)?.[1]
      const d = id && me ? await readDelegation($, id) : undefined
      if (d && me && d.from.sessionId !== me.sessionId && (d.status === 'sent' || d.status === 'draft')) {
        d.status = 'accepted'
        d.to = { ...d.to, sessionId: me.sessionId, project: me.project }
        d.notes.push({ at: await $.clock.now(), by: me.project, status: 'accepted', text: 'received' })
        await writeDelegation($, d)
      }
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
      await flush($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
