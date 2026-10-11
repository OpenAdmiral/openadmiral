import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Stands in for the machine: an in-memory ~/.claude/openadmiral and a recorded peer inbox.
function engine(
  on: On,
  sessionId: string | (() => string),
  files: Map<string, string>,
  sent: { to: unknown; text: string }[],
  deliveries: ('ok' | 'no-verdict')[] = [],
  agents: unknown[] = [],
  contextPercent = 0,
  shell?: (argv: readonly string[]) => void,
) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: typeof sessionId === 'function' ? sessionId() : sessionId }))
  on('session.repo', () => ({ value: null }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: contextPercent * 10_000, percent: contextPercent }, rateLimits: [] } }))
  on('process.run', (_$, e) =>
    (shell?.(e.argv), e.argv[0] === 'claude')
      ? { value: { exitCode: 0, stdout: JSON.stringify(agents), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__openadmiral__${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    return { value: [...files.keys()]
      .filter(p => p.startsWith(prefix))
      .map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.send', (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    if (deliveries.shift() === 'no-verdict')
      return { isDelivered: false as const, reason: 'The server-side auto mode classifier gave no verdict for SendMessage. Issue the action again once, as-is' }
    return { isDelivered: true as const }
  })
  const prompts: string[] = []
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text, context: e.context } as never
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { clock, prompts }
}

test('delegate writes a tracked delegation and briefs the peer', async ($, on) => {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  engine(on, 'sess-intel', files, sent)
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })

  const answer = await $.tool.call({
    tool: 'mcp__openadmiral__delegate',
    tool_use_id: 'tu1',
    to: 'acme-mcp-auth',
    title: 'Add scopes claim',
    detail: 'Tokens need a scopes claim.',
  })

  expect(typeof answer.result).toBe('string')   // plugin tools must answer the model with text
  const id = String(answer.result).match(/dlg_[a-z0-9]{8}/)![0]
  const stored = JSON.parse(files.get(`/home/t/.claude/openadmiral/delegations/${id}.json`)!)
  expect(stored.status).toBe('sent')
  expect(stored.from.project).toBe('acme-intelligence')
  expect(sent[0]!.to).toBe('acme-mcp-auth')
  expect(sent[0]!.text).toContain(id)
  expect(files.has('/home/t/.claude/openadmiral/sessions/sess-intel.json')).toBe(true)
})

test('delegation_update from the recipient claims it and notifies the sender', async ($, on) => {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  files.set(
    '/home/t/.claude/openadmiral/delegations/dlg_abc12345.json',
    JSON.stringify({
      v: 1, id: 'dlg_abc12345', title: 'Add scopes claim', detail: '', status: 'sent', notes: [],
      from: { sessionId: 'sess-intel', project: 'acme-intelligence' }, to: { address: 'acme-mcp-auth' },
      createdAt: 0, updatedAt: 0,
    }),
  )
  engine(on, 'sess-auth', files, sent)
  await $.session.start({ cwd: '/work/acme-mcp-auth', surface: null, isInteractive: true })

  await $.tool.call({ tool: 'mcp__openadmiral__delegation_update', tool_use_id: 'tu2', id: 'dlg_abc12345', status: 'done', result: 'abc123f' })

  const stored = JSON.parse(files.get('/home/t/.claude/openadmiral/delegations/dlg_abc12345.json')!)
  expect(stored.status).toBe('done')
  expect(stored.result).toBe('abc123f')
  expect(stored.to.sessionId).toBe('sess-auth')
  expect(sent[0]!.to).toBe('sess-intel')
})

test('Up next submits the first ready prompt once idle, honouring conditions', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, prompts } = engine(on, 'sess-intel', files, [])
  const q = '/home/t/.claude/openadmiral/queue/sess-intel'
  files.set('/home/t/.claude/openadmiral/delegations/dlg_wait0001.json', JSON.stringify({ id: 'dlg_wait0001', status: 'in_progress' }))
  files.set(`${q}.json`, JSON.stringify({
    v: 1, paused: false, updatedAt: 0,
    items: [
      { id: 'q_gated', text: 'Integrate the scope', createdAt: 0, after: { kind: 'delegation', id: 'dlg_wait0001', status: ['done'] } },
      { id: 'q_free', text: 'Run the linter', createdAt: 0 },
    ],
  }))
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })

  await clock.advance(1_000)
  expect(prompts).toEqual([])            // still inside the idle grace period

  await clock.advance(4_000)
  expect(prompts).toEqual(['Run the linter'])   // the gated one waits; the free one goes
  expect(JSON.parse(files.get(`${q}.sent.json`)!).sent.map((s: { id: string }) => s.id)).toEqual(['q_free'])

  files.set('/home/t/.claude/openadmiral/delegations/dlg_wait0001.json', JSON.stringify({ id: 'dlg_wait0001', status: 'done' }))
  await clock.advance(10_000)
  expect(prompts).toEqual(['Run the linter'])   // no turn finished since: one item per idle period

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(6_000)
  expect(prompts).toEqual(['Run the linter', 'Integrate the scope'])
})

test('show stores versioned artifacts and the prompt tells the model to use it', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 'sess-ai', files, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })

  await $.tool.call({ tool: 'mcp__openadmiral__show', tool_use_id: 's1', title: 'Icon comparison', content: '<svg/>', kind: 'image' })
  await $.tool.call({ tool: 'mcp__openadmiral__show', tool_use_id: 's2', title: 'Icon comparison', content: '<svg id="b"/>', kind: 'image', note: 'lighter stars' })

  const dir = '/home/t/.claude/openadmiral/artifacts/sess-ai/icon-comparison'
  const manifest = JSON.parse(files.get(`${dir}/manifest.json`)!)
  expect(manifest.versions.map((v: { file: string }) => v.file)).toEqual(['v1.svg', 'v2.svg'])
  expect(manifest.versions[1].note).toBe('lighter stars')
  expect(files.get(`${dir}/v2.svg`)).toBe('<svg id="b"/>')

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['mcp__openadmiral__show'], outputStyle: null, traits: [] })
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'openadmiral:show'])
  const without = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(without.sections.map(s => s.id)).toEqual(['intro'])
})

test('an undelivered delegation stays a draft until the model sends it itself', async ($, on) => {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  engine(on, 'sess-intel', files, sent, ['no-verdict', 'no-verdict'])
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: { success: true } as never }))
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })

  const answer = await $.tool.call({ tool: 'mcp__openadmiral__delegate', tool_use_id: 'tu1', to: 'mcp-b3', title: 'T', detail: 'D' })
  expect(sent.length).toBe(2)                       // retried once after "no verdict"
  const text = String(answer.result)
  const id = text.match(/dlg_[a-z0-9]{8}/)![0]
  expect(text).toContain('SendMessage')
  const path = `/home/t/.claude/openadmiral/delegations/${id}.json`
  expect(JSON.parse(files.get(path)!).status).toBe('draft')

  await $.tool.call({ tool: 'SendMessage', tool_use_id: 'tu2', to: 'mcp-b3', message: `[OpenAdmiral delegation ${id}] …` })
  expect(JSON.parse(files.get(path)!).status).toBe('sent')
})

test('after a send auto mode kept undecided, the next delegation goes straight to the model', async ($, on) => {
  const files = new Map<string, string>()
  const sent: { to: unknown; text: string }[] = []
  engine(on, 'sess-intel', files, sent, ['no-verdict', 'no-verdict'])
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })
  await $.tool.call({ tool: 'mcp__openadmiral__delegate', tool_use_id: 'tu1', to: 'mcp-b3', title: 'T1', detail: 'D' })
  const second = await $.tool.call({ tool: 'mcp__openadmiral__delegate', tool_use_id: 'tu2', to: 'mcp-b3', title: 'T2', detail: 'D' })
  expect(sent.length).toBe(2)                       // no new attempts for the second one
  expect(String(second.result)).toContain('SendMessage')
})

test('a delegation brief reaching its recipient marks it accepted', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 'sess-mcp', files, [])
  on('session.receive', (_$, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/work/acme-mcp-server', surface: null, isInteractive: true })
  const path = '/home/t/.claude/openadmiral/delegations/dlg_abcd1234.json'
  files.set(path, JSON.stringify({
    v: 1, id: 'dlg_abcd1234', title: 'T', detail: 'D', from: { sessionId: 'sess-intel', project: 'acme-intelligence' },
    to: { address: 'acme-mcp-server' }, status: 'sent', notes: [], createdAt: 0, updatedAt: 0,
  }))
  await $.session.receive({ text: '[OpenAdmiral delegation dlg_abcd1234] from acme-intelligence\nTitle: T', origin: { kind: 'peer' } } as never)
  const d = JSON.parse(files.get(path)!)
  expect(d.status).toBe('accepted')
  expect(d.to.sessionId).toBe('sess-mcp')
})

test('the recipient writing about an accepted delegation moves it to in progress', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 'sess-mcp', files, [])
  on('tool.call', { tool: 'SendMessage' }, () => ({ result: { success: true } as never }))
  await $.session.start({ cwd: '/work/acme-mcp-server', surface: null, isInteractive: true })
  const path = '/home/t/.claude/openadmiral/delegations/dlg_abcd1234.json'
  files.set(path, JSON.stringify({
    v: 1, id: 'dlg_abcd1234', title: 'T', detail: 'D', from: { sessionId: 'sess-intel', project: 'acme-intelligence' },
    to: { address: 'acme-mcp-server', sessionId: 'sess-mcp', project: 'acme-mcp-server' }, status: 'accepted', notes: [], createdAt: 0, updatedAt: 0,
  }))
  await $.tool.call({ tool: 'SendMessage', tool_use_id: 'tu1', to: 'acme-intelligence', summary: 'Building it', message: 'dlg_abcd1234: building the endpoint now' })
  expect(JSON.parse(files.get(path)!).status).toBe('in_progress')
})

test('a retried send that gets through marks the delegation sent', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 'sess-intel', files, [], ['no-verdict', 'ok'])
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })
  const answer = await $.tool.call({ tool: 'mcp__openadmiral__delegate', tool_use_id: 'tu1', to: 'mcp-b3', title: 'T', detail: 'D' })
  const id = String(answer.result).match(/dlg_[a-z0-9]{8}/)![0]
  expect(JSON.parse(files.get(`/home/t/.claude/openadmiral/delegations/${id}.json`)!).status).toBe('sent')
})

test('@ lists live peers with what they are doing, and a mention briefs the model', async ($, on) => {
  const files = new Map<string, string>()
  const agents = [
    { sessionId: 'sess-intel', name: 'acme-intelligence-f3', cwd: '/work/acme-intelligence', status: 'busy' },
    { sessionId: 'sess-mcp', name: 'acme-mcp-server-b3', cwd: '/work/acme-mcp-server', status: 'busy' },
    { sessionId: 'sess-auth', name: 'acme-auth-61', cwd: '/work/acme-auth', status: 'idle' },
  ]
  engine(on, 'sess-intel', files, [], [], agents)
  on('prompt.autocomplete', () => ({ suggestions: [{ text: '@README.md' }] }))
  files.set('/home/t/.claude/openadmiral/sessions/sess-mcp.json', JSON.stringify({
    sessionId: 'sess-mcp', project: 'acme-mcp-server', branch: 'sandbox', status: 'working',
    turn: { startedAt: 0, prompt: 'Implement delete_script tool' }, updatedAt: 0,
  }))
  await $.session.start({ cwd: '/work/acme-intelligence', surface: null, isInteractive: true })

  const rows = await $.prompt.autocomplete({ text: 'pregunta a @mcp', cursor: 15, token: '@mcp', start: 11 })
  expect(rows.suggestions.map(r => r.text)).toEqual(['@acme-mcp-server-b3', '@README.md'])
  expect(rows.suggestions[0]!.description).toContain('Implement delete_script tool')

  const all = await $.prompt.autocomplete({ text: '@', cursor: 1, token: '@', start: 0 })
  expect(all.suggestions.map(r => r.text)).not.toContain('@acme-intelligence-f3')   // never yourself

  const submitted = (await $.prompt.submit({ text: '@acme-auth-61 add the scope', wait: false } as never)) as unknown as { context?: string[] }
  expect(submitted.context?.join('\n')).toContain('delegate')
  expect(submitted.context?.join('\n')).toContain('acme-auth-61')
})

test('follows the session out of a removed worktree and keeps the heartbeat alive', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-intel', files, [])
  let cwd = '/work/acme-intelligence/.claude/worktrees/df92bbb3'
  on('session.root', () => ({ value: cwd }))
  await $.session.start({ cwd, surface: null, isInteractive: true })
  const read = () => JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-intel.json')!)
  expect(read().cwd).toBe(cwd)

  cwd = '/work/acme-intelligence'            // back in the main checkout; the worktree is gone
  const before = read().updatedAt
  await clock.advance(25_000)
  expect(read().cwd).toBe('/work/acme-intelligence')
  expect(read().updatedAt).toBeGreaterThan(before)   // the heartbeat still wrote
})

test('a hand-off waits while background agents run, then exits', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  let agents: { id: string; status: string }[] = [{ id: 'a1', status: 'running' }]
  on('agent.list', () => ({ value: agents as never }))
  const commands: string[] = []
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  const req = '/home/t/.claude/openadmiral/requests/sess-ai.json'
  files.set(req, JSON.stringify({ action: 'handoff', at: clock.now() }))

  await clock.advance(5_000)
  expect(commands).toEqual([])
  expect(JSON.parse(files.get(req)!).waiting).toBe('1 background agent still running')

  agents = [{ id: 'a1', status: 'completed' }]
  await clock.advance(5_000)
  expect(commands).toEqual(['exit'])
  expect(JSON.parse(files.get(req)!).servedAt).toBeGreaterThan(0)
})

test('a background-task notification is labelled, not shown as raw tags', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  on('turn.start', (_$, e) => ({ ...e }) as never)
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await $.turn.start({ text: '<task-notification>\n<task-id>a158</task-id>\n<summary>Agent "Build OpenAdmiral Tauri app" finished</summary>\n</task-notification>', turnId: 't1' })
  await clock.advance(500)
  const s = JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json') ?? '{}')
  expect(s.turn?.prompt).toBe('Background task: Agent "Build OpenAdmiral Tauri app" finished')
})

test('subagents come from the engine list, forks and resumed agents included', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  let agents = [{ id: 'fork1', description: 'Build OpenAdmiral Tauri app', type: 'fork', status: 'running' }]
  on('agent.list', () => ({ value: agents as never }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  const read = () => JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!).subagents
  await clock.advance(3_000)
  expect(read()).toEqual([expect.objectContaining({ id: 'fork1', status: 'running', type: 'fork' })])
  agents = []                                       // the engine dropped it once it finished
  await clock.advance(3_000)
  expect(read()[0].status).toBe('done')
})

test('a show call draws as a card whose button opens it in OpenAdmiral', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, 'sess-ai', files, [])
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    files.delete('/home/t/.claude/openadmiral/focus.json')
    const mounted = await $.ui.mount({
      plugin: 'openadmiral',
      surface,
      component: 'ToolUse',
      requestId: `tu-${surface}`,
      props: {
        tool_use_id: `tu-${surface}`,
        tool: 'mcp__openadmiral__show',
        input: { title: 'Light mode before / after', note: 'After: warm surfaces' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        output: 'Shown in OpenAdmiral: "Light mode before / after" (v2, image).',
      },
    })
    expect(JSON.stringify(await mounted.drawn())).toContain('Light mode before / after')
    await $.ui.press({ plugin: 'openadmiral', key: 'openadmiral', surface })
    const focus = JSON.parse(files.get('/home/t/.claude/openadmiral/focus.json')!)
    expect(focus).toEqual(expect.objectContaining({ kind: 'artifact', sessionId: 'sess-ai', artifactId: 'light-mode-before-after', version: 2 }))
  }
})

test('context is also reported as a share of the usable window, like the statusline', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [], [], [], 63)
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(1_000)
  const ctx = JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!).context
  expect(ctx.percent).toBe(63)
  expect(ctx.usablePercent).toBe(75)   // 63 / (100 - 16.5)
})

test('a chip pressed in OpenAdmiral fills the prompt box, once, and never submits', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, prompts } = engine(on, 'sess-ai', files, [])
  const fills: string[] = []
  on('prompt.fill', (_$, e) => {
    fills.push(e.text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  files.set('/home/t/.claude/openadmiral/fill/sess-ai.json', JSON.stringify({ text: '/model', at: clock.now() + 1 }))
  await clock.advance(1_000)
  await clock.advance(1_000)
  expect(fills).toEqual(['/model'])     // served once, not on every poll
  expect(prompts).toEqual([])           // only drafted
})

test('remote control state is published from /config and the attached surfaces', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  on('session.surfaces', () => ({ value: ['terminal', 'mobile'] as never }))
  on('config.list', () => ({ value: [{ key: 'remoteControlAtStartup', label: 'Enable Remote Control for all sessions', kind: 'boolean', value: true, provider: { kind: 'engine' }, isLocked: false }] as never }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(1_000)
  const remote = JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!).remote
  expect(remote).toEqual({ enabled: true, clients: 1 })
})

test('/remote-control in this session marks Remote Control on, even with the /config default off', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  on('config.list', () => ({ value: [{ key: 'remoteControlAtStartup', label: 'Enable Remote Control for all sessions', kind: 'boolean', value: false, provider: { kind: 'engine' }, isLocked: false }] as never }))
  on('command.run', () => ({ text: '/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_x' }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await $.command.run({ command: 'remote-control', args: '' } as never)
  await clock.advance(1_000)
  expect(JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!).remote).toEqual({ enabled: true, clients: 0, session: true })
})

test('the bridge_status notice turns the RC chip on', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await $.session.append({
    message: { type: 'system', name: 'bridge_status', content: [{ type: 'text', text: '/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_x' }] },
  } as never)
  await clock.advance(1_000)
  expect(JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!).remote.enabled).toBe(true)
})

test('the app can run /rename outright, but nothing outside the allow-list', async ($, on) => {
  const files = new Map<string, string>()
  const { clock } = engine(on, 'sess-ai', files, [])
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  files.set('/home/t/.claude/openadmiral/fill/sess-ai.json', JSON.stringify({ command: 'rename', args: 'auth-scopes', at: clock.now() + 1 }))
  await clock.advance(1_000)
  files.set('/home/t/.claude/openadmiral/fill/sess-ai.json', JSON.stringify({ command: 'clear', at: clock.now() + 1 }))
  await clock.advance(1_000)
  expect(ran).toEqual(['rename auth-scopes'])
})

const LIST = [
  { name: 'clear', description: 'Start a new session', source: 'builtin' },
  { name: 'compact', description: 'Free up context', source: 'builtin' },
  { name: 'model', description: 'Set the AI model', source: 'builtin' },
  { name: 'simplify', description: 'Review the changed code', source: 'builtin' },
  { name: 'qprobe:qping', description: 'A plugin command', source: 'plugin' },
]

test('Up next runs slash commands through command.run and refuses interactive ones', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, prompts } = engine(on, 'sess-ai', files, [])
  on('command.list', () => ({ value: LIST as never }))
  const ran: string[] = []
  on('command.run', (_$, e) => {
    ran.push(`${e.command}|${e.args}`)
    return { text: '' }
  })
  const q = '/home/t/.claude/openadmiral/queue/sess-ai'
  files.set(`${q}.json`, JSON.stringify({
    v: 1, paused: false, updatedAt: 0,
    items: [
      { id: 'q_model', text: '/model', createdAt: 0 },
      { id: 'q_compact', text: '/compact keep the API notes', createdAt: 0 },
      { id: 'q_skill', text: '/qprobe:qping hello', createdAt: 0 },
      { id: 'q_text', text: 'Run the linter', createdAt: 0 },
    ],
  }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(500)
  const published = JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-ai.json')!)
  expect(published.queueCommands.map((c: { name: string; kind: string }) => `${c.name}:${c.kind}`)).toEqual(['clear:command', 'compact:command', 'simplify:skill', 'qprobe:qping:skill'])

  await clock.advance(4_000)                                     // /model: refused, recorded, not run
  const sent = () => JSON.parse(files.get(`${q}.sent.json`)!).sent
  expect(sent()[0]).toEqual(expect.objectContaining({ id: 'q_model', via: 'command' }))
  expect(sent()[0].error).toContain('needs you')
  expect(ran).toEqual([])

  await clock.advance(4_000)                                     // /compact: a local command, idle again after it
  expect(ran).toEqual(['compact|keep the API notes'])
  await clock.advance(4_000)                                     // the skill goes through command.run too
  expect(ran).toEqual(['compact|keep the API notes', 'qprobe:qping|hello'])
  expect(prompts).toEqual([])                                    // never a "/" prompt
  await $.turn.complete({ answer: 'qpong', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(4_000)
  expect(prompts).toEqual(['Run the linter'])
})

test('a timed item waits for its time; a schedule runs once per occurrence and re-arms', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, prompts } = engine(on, 'sess-ai', files, [])
  const start = clock.now()
  const q = '/home/t/.claude/openadmiral/queue/sess-ai'
  const at = start + 60_000
  // Every day at the local minute two minutes from now.
  const d = new Date(start + 120_000)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  files.set(`${q}.json`, JSON.stringify({
    v: 1, paused: false, updatedAt: 0,
    items: [
      { id: 'q_time', text: 'Morning check', createdAt: start, after: { kind: 'time', at } },
      { id: 'q_daily', text: 'Daily report', createdAt: start, after: { kind: 'schedule', time: hhmm, days: [0, 1, 2, 3, 4, 5, 6] } },
    ],
  }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(30_000)
  expect(prompts).toEqual([])                                   // nothing due yet
  await clock.advance(32_000)
  expect(prompts).toEqual(['Morning check'])
  const sent = () => JSON.parse(files.get(`${q}.sent.json`)!).sent
  expect(sent()[0].due).toBe(at)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(70_000)
  expect(prompts).toEqual(['Morning check', 'Daily report'])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(60_000)
  expect(prompts.length).toBe(2)                                // re-armed for tomorrow, not repeated
})

test('Run now sends an item at once, even a gated one', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, prompts } = engine(on, 'sess-ai', files, [])
  const q = '/home/t/.claude/openadmiral/queue/sess-ai'
  files.set(`${q}.json`, JSON.stringify({
    v: 1, paused: false, updatedAt: 0,
    items: [
      { id: 'q_a', text: 'First', createdAt: 0 },
      { id: 'q_later', text: 'Next week', createdAt: 0, runNowAt: 1, after: { kind: 'time', at: clock.now() + 7 * 86_400_000 } },
    ],
  }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(4_000)
  expect(prompts).toEqual(['Next week'])
})

test('a queued /clear keeps the rest of the queue: the files follow the new session id', async ($, on) => {
  const files = new Map<string, string>()
  let id = 'sess-old'
  // The shell `mv` the mod runs on /clear, played on the in-memory files.
  const shell = (argv: readonly string[]) => {
    if (argv[0] !== '/bin/sh' || !String(argv[2]).includes('mv')) return
    const [dir, to, from] = argv.slice(4) as string[]
    for (const x of ['json', 'sent.json']) {
      const src = files.get(`${dir}/${from}.${x}`)
      if (src !== undefined && !files.has(`${dir}/${to}.${x}`)) {
        files.set(`${dir}/${to}.${x}`, src)
        files.delete(`${dir}/${from}.${x}`)
      }
    }
  }
  const { clock, prompts } = engine(on, () => id, files, [], [], [], 0, shell)
  on('command.list', () => ({ value: LIST as never }))
  on('command.run', (_$, e) => {
    if (e.command === 'clear') id = 'sess-new'
    return { text: '' }
  })
  const dir = '/home/t/.claude/openadmiral/queue'
  files.set(`${dir}/sess-old.json`, JSON.stringify({
    v: 1, paused: false, updatedAt: 0,
    items: [{ id: 'q_clear', text: '/clear', createdAt: 0 }, { id: 'q_next', text: 'Start the next task', createdAt: 0 }],
  }))
  await $.session.start({ cwd: '/work/ai-tooling', surface: null, isInteractive: true })
  await clock.advance(4_000)
  await clock.advance(6_000)
  expect(files.has(`${dir}/sess-new.json`)).toBe(true)
  expect(JSON.parse(files.get('/home/t/.claude/openadmiral/sessions/sess-old.json')!).supersededBy).toBe('sess-new')
  expect(prompts).toEqual(['Start the next task'])
})
