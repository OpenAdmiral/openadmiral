# OpenAdmiral data contract (v1)

The `openadmiral` plugin (inside every Claude Code session) writes; the OpenAdmiral app reads.
Everything lives under `~/.claude/openadmiral/` (respect `CLAUDE_CONFIG_DIR` if set).
All files are whole-file JSON writes (the mod has no append), UTF-8, timestamps
in epoch milliseconds.

```
~/.claude/openadmiral/
  sessions/<sessionId>.json      one per Claude Code session, rewritten on every change
  delegations/<delegationId>.json one per delegated piece of work
  requests/<sessionId>.json      app → mod: { action: 'handoff' | 'exit', at } ; the mod adds servedAt and runs /exit
  attached.json                  app → statusline: { updatedAt, sessions: [sessionId] }
  queue/<sessionId>.json         app → mod: prompts queued for a session ("Up next"); only the app writes it
  queue/<sessionId>.sent.json    mod → app: which queued prompts were submitted; only the mod writes it
  artifacts/<sessionId>/<artifactId>/manifest.json + v<N>.<ext>   mod → app: things an agent shows (the `show` tool)
  focus.json                     mod → app: "show this now" (the transcript card's Open in OpenAdmiral button)
  fill/<sessionId>.json          app → mod: { text, at } — put this command in the session's prompt box (not submitted)
```

## sessions/<sessionId>.json

```ts
type AdmiralSession = {
  v: 1
  sessionId: string            // Claude session id (transcript name); joins `claude agents --json`.sessionId
  name?: string                // display name if known (from `claude agents --json`, the app fills it)
  cwd: string                  // absolute
  project: string              // basename of the repo root, else of cwd
  repo?: { root: string; remote: string | null }
  branch?: string              // `git rev-parse --abbrev-ref HEAD`
  worktree?: boolean           // cwd is a linked git worktree
  dirty?: number               // count of changed files (`git status --porcelain`)
  model?: string
  status: 'starting' | 'idle' | 'working' | 'waiting' | 'ended'
  waiting?: { reason: 'permission' | 'question' | 'idle_prompt'; detail?: string; since: number }
  turn?: { startedAt: number; prompt: string;  // present while status === 'working'
    progress?: { percent: number; step?: string; at: number }[] }  // the model's reports this turn, oldest first (≤ 40)
  lastTurn?: { startedAt: number; endedAt: number; percent?: number; step?: string }  // the last turn that ran ≥ 30 s or reported; cleared at the next prompt
  jobs?: { id: string; label?: string; output?: string; startedAt: number; endedAt?: number;  // Bash run_in_background (≤ 10)
    status: 'running' | 'completed' | 'failed' | 'killed'; exitCode?: number }[]
  lastTool?: { name: string; summary: string; at: number }
  lastReply?: string           // first ~200 chars of the last assistant text
  context?: { tokens?: number; window: number; percent?: number; usablePercent?: number }  // usablePercent: share of the window left before auto-compaction (100% = compacts), as the GSD statusline shows
  rateLimits?: { kind: string; percentUsed: number; resetsAt?: string }[]  // five_hour, seven_day…
  costUsd?: number
  tasks?: { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }[]
  subagents?: { id: string; type?: string; description?: string; status: 'running' | 'done' | 'failed'; startedAt: number; progress?: { percent: number; step?: string; at: number }[] }[]
  activity?: { at: number; kind: 'prompt' | 'tool' | 'reply' | 'sent' | 'received' | 'permission'; text: string }[]  // newest last, max 40
  remote?: { enabled?: boolean; clients: number }  // Remote Control: switched on (from /config) and remote clients attached (phone, claude.ai)
  commands?: string[]          // which of model/usage/cost/status/compact/context/clear/remote-control/rename this build has
  queueCommands?: { name: string; kind: 'command' | 'skill'; description?: string }[]  // slash commands Up next may queue here (see queue/); absent from older mods
  supersededBy?: string        // set on the old file when /clear gave the same process a new session id (status 'ended'); the app follows it
  plugin?: { loadedAt: number } // when this session loaded the plugin (start or last /reload-plugins); absent from older mods
  host?: { app: string; kind: 'extension' | 'terminal' }  // where it runs, from CLAUDE_CODE_ENTRYPOINT, TERM_PROGRAM and __CFBundleIdentifier (plugin/hooks/host.ts): VS Code extension, "VS Code terminal", iTerm…
  startedAt: number
  updatedAt: number            // heartbeat: refreshed at least every 30 s while the session is alive
}
```

**Outdated plugin (app).** A session keeps the plugin it loaded until
`/reload-plugins`. The app compares `plugin.loadedAt` (missing counts as old) with
the newest file under the plugin's `hooks/` and `.claude-plugin/` (this repo's
`./plugin` for a directory marketplace, else the installed copy); a running session
that loaded before them shows "Plugin outdated · Reload", and Reload puts
`/reload-plugins` first in its queue as Run now (`src-tauri/src/plugin_files.rs`).
`plugin.json` sets no `version`, so a GitHub install's version is the commit; the app
runs `claude plugin marketplace update openadmiral` and `claude plugin update
openadmiral@openadmiral` at launch and every six hours (Claude Code auto-updates only
its own marketplaces), which is what makes those sessions outdated.

**Hand-off and exit requests** are never served in an editor's Claude Code panel
(`host.kind` "extension"): /exit does not close it. While its process runs (its
`~/.claude/sessions/<pid>.json`; `claude agents` lists only background jobs) the app
refuses to start one and drops any left from older versions; once the tab or editor is
closed it resumes like any ended session.

**Progress (`turn.progress`).** The mod registers the `progress` tool (`{ percent, step? }`,
always loaded) with a system-prompt section asking for reports during work longer than
about 30 s, the percent weighted by effort (writing and testing count most). Once a turn
has run 30 s with no report, or its last one is over 45 s old, the mod adds a reminder
inside the next tool result (never a block of its own, which the chat would show as typed) (at most every 45 s). A subagent's reports go to its own
`subagents[i].progress` (≤ 20): once the main turn is over, cards and the menu bar show the
subagents still running, their time and the slowest one's report. While the session waits
for the person the ETA pauses. A turn of 2 min or more notifies when it ends ("done", or
"stopped at 43%" from `lastTurn`).
`OPENADMIRAL_PROGRESS=0` in a session's environment turns it off. The app draws
the bar and measures the ETA from the pace (`app/src/lib/progress.ts`); without reports a
task list (`tasks`) gives done/total. The model never estimates time.

**Measured progress (app).** Two signals need no report from Claude
(`src-tauri/src/measure.rs`). A background command's `output` file (only Claude Code's
`…/tasks/*.output` under the temp folder can be read) is polled every 2 s while it runs: its
last "118/240" or "45%" gives the bar and, from the pace, the time left; once it has written a few times, no output for
5× its usual gap (2 min at least) shows it stalled (a command that prints nothing never is) (`app/src/lib/jobs.ts`). The mod fills
`jobs` from the Bash result ("Output is being written to: …") and the
`<task-notification>` that ends it; the system-prompt section asks Claude to run commands
longer than about two minutes that way. And the `turn_duration` rows of the project's
transcripts (last 90 days) give how long its turns usually run on from the current
elapsed time: "usually ≈ 4 min left" before any report, "longer than usual" past nearly all.

A session file whose `updatedAt` is older than 90 s and whose `sessionId` is
not in `claude agents --json` is stale (the app shows it as ended / greys it).

## delegations/<delegationId>.json

Created by the mod's `delegate` tool in the *sender*; status changed by the
`delegation_update` tool in the *recipient* (or the sender, to cancel). The
recipient's mod also marks a `sent`/`draft` delegation `accepted` (note
"received", `to.sessionId` filled) the moment its brief arrives, so the board
does not wait for the recipient's model. Likewise an `accepted` delegation
turns `in_progress` when the recipient's model sends a SendMessage that names
its id (its summary becomes the note), or once the recipient uses a tool in a
turn that started after the delegation was accepted (note "working on it";
checked at most every 20 s), so quiet work still shows as under way. Delivery: the sender's mod sends the
brief itself; when auto mode leaves both tries undecided it keeps it `draft`,
asks its model to SendMessage it (that send marks it `sent`), and makes no
further attempts of its own for the rest of the session.

```ts
type AdmiralDelegation = {
  v: 1
  id: string                   // "dlg_" + 8 base36 chars
  title: string                // short, imperative
  detail: string               // full brief as sent
  from: { sessionId: string; project: string; name?: string }
  to: { address: string; sessionId?: string; project?: string }  // address = SendMessage `to`; sessionId filled when the recipient accepts
  status: 'draft' | 'sent' | 'accepted' | 'in_progress' | 'blocked' | 'done' | 'cancelled'  // draft = recorded, not delivered yet (the model's SendMessage carrying the id marks it sent)
  dependsOn?: string[]         // other delegation ids
  notes: { at: number; by: string; status?: AdmiralDelegation['status']; text: string }[]
  result?: string              // summary on done (commit hash, PR, files)
  createdAt: number
  updatedAt: number
}
```

## Liveness from the CLI

The app also polls `claude agents --json` (≈2 s):
`[{ pid, cwd, kind: 'interactive' | 'bg', startedAt, sessionId, name, status: 'idle' | 'busy' | … }]`.
Only `kind: 'bg'` sessions can be opened with `claude attach <name|id>`; the app
creates new agents with `claude --bg -n <name>` in the chosen folder.

## requests/<sessionId>.json (app → mod)

`{ action: 'handoff' | 'exit', at: number, servedAt?: number, waiting?: string }`. The mod polls every 2 s;
when the session is idle and the request is under 10 min old it writes back
`servedAt` and runs `/exit` — unless background agents are still running (`/exit`
would stop at a confirmation nobody can answer): then it writes `waiting`
("2 background agents still running") and retries until they finish. The app then resumes the session with
`claude --bg --resume <sessionId> -n <name>` once `claude agents --json` no
longer lists it (`handoff` only; `exit` just closes the session). A session that had no
message yet has no transcript to resume (`--resume` fails with "source session … not
found"): the app starts `claude --bg -n <name>` in its folder instead, and that new id replaces it.

## settings.json (app → mod)

`{ showProgressCalls?: boolean }`: what the person chose for every session, from the
app's OpenAdmiral menu. `showProgressCalls` (default false) shows the `progress` tool
calls in the chat; hidden, the mod draws them as nothing. The mod reads it at start and
every heartbeat. The app writes it whole (tmp + rename), keeping keys it does not know.

## attached.json (app → statusline)

`{ updatedAt: number, sessions: string[] }`: the sessions shown in the app's
embedded terminal, rewritten every ~10 s while the app runs. A custom statusline
can print nothing for those sessions while the file is under 30 s old, so the
embedded terminal is not cluttered twice.

## Spawning `claude`

Strip every `CLAUDE*` environment variable before spawning: a child that
inherits `CLAUDE_CODE_CHILD_SESSION` is not registered and does not save its
transcript.

## queue/<sessionId>.json (app → mod) and queue/<sessionId>.sent.json (mod → app)

Prompts and slash commands the user queues for a session ("Up next"), optionally
scheduled. The app owns the queue file (add, edit, reorder, delete, pause, Run
now); the mod never writes its content and records what it submitted in the
`.sent.json` file instead, so the two never overwrite each other. The pure
rules (due times, classification) live in `plugin/hooks/queue.ts`, imported by
both the mod and the app; `app/src-tauri/src/scheduler.rs` mirrors the due rules.

```ts
type AdmiralQueue = {
  v: 1
  paused: boolean              // the whole queue
  items: {
    id: string                 // "q_" + 8 base36 chars
    text: string               // a prompt, submitted as if typed, or a slash command ("/compact keep the API notes")
    createdAt: number
    after?:                    // optional condition, besides the session being idle
      | { kind: 'delegation'; id: string; status: ('done' | 'blocked' | 'cancelled' | 'in_progress' | 'accepted')[] }
      | { kind: 'session-idle'; sessionId: string }   // another session finished its turn
      | { kind: 'time'; at: number }                  // one-shot, at an epoch ms
      | { kind: 'schedule'; time: string; days: number[] }  // recurring: local "HH:MM" on these weekdays (0 = Sunday; [] = every day)
    paused?: boolean           // this item is skipped; the rest of the queue is not
    runNowAt?: number          // "Run now": due regardless of its condition until a run newer than this is recorded
    armedAt?: number           // set when a schedule is created or edited: occurrences before it never count
  }[]
  updatedAt: number
}
type AdmiralQueueSent = {
  v: 1
  sent: {
    id: string
    at: number                 // when it was submitted
    text?: string              // what went in (clipped to 300), so "Recently sent" outlives the item
    due?: number               // the occurrence a time/schedule item ran for; at − due > 5 min = a late catch-up run
    via?: 'prompt' | 'command' // prompt.submit, or $.command.run
    error?: string             // refused (unknown/interactive command) or command.run failed; recorded so it is not retried
  }[]                          // last 200 entries
}
```

**Serving (mod).** The mod polls every 2 s. When its session has been idle for
at least 3 s, the queue is not paused and no hand-off/exit is pending, it takes
one item: first any item with Run now pending (`runNowAt` newer than its last
run), else the first item in order that is not paused, not done, whose time
has come (time/schedule) and whose `after` holds; it appends a sent entry, then
submits it. One item per idle period: the next waits for the turn it started to
finish. Items whose condition does not hold yet are skipped, so a later item
may go first. A delegation condition holds when `delegations/<id>.json` has one
of the listed statuses; a session-idle condition when that session's file is
`idle` (not stale, < 90 s).

**Done / recurring.** A one-shot item (no `after`, or delegation, session-idle,
time) is done once a sent entry has its id (and no newer `runNowAt`); the app
removes done items from its file. A `schedule` item is never done: its next
occurrence is computed from `max(last run, armedAt ?? createdAt)`, so it
re-arms after every run. **Missed runs:** however many occurrences were missed
(session or OpenAdmiral closed, queue paused), the item runs **once** as soon as
possible (a catch-up, recognisable by `at − due`), then continues from the next
occurrence after that run. Older missed occurrences are skipped.

**Slash commands.** A text starting with "/" never goes through
`$.prompt.submit` (the host refuses it). The mod publishes `queueCommands` in
its session file: built-ins verified to run unattended (`clear`, `compact`,
`rename`, `reload-plugins`, `context`) as `kind: 'command'`; built-in prompt
skills (`simplify`, `code-review`, `security-review`, `review`, `init`,
`verify`, `batch`, `insights`) and every user/plugin/MCP command or skill as
`kind: 'skill'`. Both kinds run with `$.command.run({ command, args })` (a
skill then starts a model turn). Anything else (interactive pickers such as
`/model`, `/config`, `/usage`, `/resume`, `/exit`) is rejected by the app's
input and, if it gets into a file anyway, recorded by the mod with `error` and
not run. A mod without `queueCommands` accepts no slash commands.

**/clear.** `/clear` keeps the process and the job but gives a new session id
(`followSessionId`, `supersededBy`). The mod then moves `queue/<old>.json` and
`queue/<old>.sent.json` to the new id (a file move, only when the new id has
none: the one exception to "the mod never writes the queue file"), so the rest
of the queue carries on. The app also merges any queue still under a
superseded id into the live id (`queue_move`), e.g. one it saved meanwhile.
Once such a job is stopped, `claude agents --all` lists it under its FIRST
session id again, so the app maps any id to its job by walking the
`supersededBy` links back (`src-tauri/src/jobs.rs`) and resumes, stops or
removes it by that: `claude --bg --resume <first id>` without flags wakes the
same job on its post-/clear conversation (the short job id, or the post-/clear
id, would start a copy / a second job). Keep the superseded files: they are
those links.

**Scheduler (app).** The app checks every 15 s, for sessions that are **not**
running (`claude agents --json` does not list them, or lists them without a
`pid`: a parked background job, which serves nothing until woken), whether their queue needs
them now: an item with Run now pending, or a time/schedule item that is due
(not paused, queue not paused). A parked job is woken with `claude respawn <job id>` (same job, same
conversation). A session whose file was written in the last 90 s runs somewhere
the CLI does not list (an editor, a terminal window) and is never resumed. Otherwise
it resumes the session as a hand-off does
(`claude --bg --resume <id>`, without flags when `claude agents --all` still has
its job) and the mod drains the queue once it is up. A failed resume is retried
after 10 min. A resume that starts a copy under a new id moves the queue to it.
Sessions removed from OpenAdmiral (no `sessions/<id>.json`) are not resumed; their
queue stays visible in the Up next view until deleted.

**Auto-resume (app).** When a session's turn ended on a dropped connection
(its transcript's last main-conversation entry is an `isApiErrorMessage`
assistant line whose `error` is `server_error`, or whose text says the
connection was lost, timed out or the computer slept; never `rate_limit`,
billing or auth errors), the session is alive and idle, and the Mac has been
back online for 15 s, the app inserts one item at the top of that session's
queue: the fixed text "The connection dropped before you finished. Continue
where you left off." with `runNowAt` = now. The mod serves it like any Run now
item. At most once per error and three times per session per hour; errors
older than 6 h and paused queues are left alone. Switch: Underway panel →
"Resume after a network drop" (`src-tauri/src/resume.rs`).

## artifacts/<sessionId>/<artifactId>/ (mod → app)

Written by the mod's `show` tool: what an agent wants the user to look at (report,
plan, diagram, comparison image, page). `artifactId` is the slug of the title,
so showing the same title again adds a version instead of a new artifact.

```ts
type AdmiralArtifact = {
  v: 1
  id: string                   // slug of the title
  sessionId: string
  project: string
  title: string
  kind: 'html' | 'markdown' | 'mermaid' | 'image' | 'pdf' | 'diff' | 'text'
  versions: {
    n: number                  // 1, 2, …
    file: string               // file name beside manifest.json, e.g. "v2.png"
    createdAt: number
    note?: string              // what changed in this version
    sourcePath?: string        // where the agent's original file was
  }[]
  updatedAt: number
}
```

Files are copied in (never referenced in place), so they survive scratchpad
cleanup. HTML must be self-contained (inline CSS/JS/images, CDN scripts OK);
the app renders it in a sandboxed frame with no access to the app.

## focus.json (mod → app)

`{ kind: 'artifact', sessionId, artifactId, version?: number, at }`, written when
the user presses **Open in OpenAdmiral** on a `show` card in a session's transcript; the
mod then runs `open -b com.openadmiral.desktop` to bring the app forward. The app
reacts to a new `at`: select that agent, switch to its Artifacts tab on that
artifact and version, and focus the window. Ignore entries older than ~10 s
(e.g. at app start).

## fill/<sessionId>.json (app → mod)

`{ text?: string, command?: string, args?: string, at: number }`. With `command`
(only `rename` is allowed) the mod runs it outright via `$.command.run`, e.g.
`{ command: 'rename', args: 'auth-scopes' }`. Otherwise, the mod polls every 0.4 s and, for an `at` newer
than the last it served (and under 30 s old), replaces the session's prompt-box
draft with `text` via `$.prompt.fill` — never submitted; the user presses Enter.
Used by the header chips (`/model`, `/usage`, `/compact`, `/context`, `/clear`,
`/remote-control`). Offer only commands listed in the session's `commands`.
