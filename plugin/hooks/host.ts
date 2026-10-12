// Where a Claude Code session runs, from its environment: the editor extension
// (CLAUDE_CODE_ENTRYPOINT), the terminal (TERM_PROGRAM) and the app that started it
// (__CFBundleIdentifier, set by macOS). Pure: register.tsx reads the variables.

export type Host = { app: string; kind: 'extension' | 'terminal' }

const APPS: [RegExp, string][] = [
  [/^com\.microsoft\.VSCode/, 'VS Code'],
  [/^com\.todesktop\./, 'Cursor'],
  [/^com\.exafunction\.windsurf/, 'Windsurf'],
  [/^dev\.zed\.Zed/, 'Zed'],
  [/^com\.jetbrains\.|^com\.google\.android\.studio/, 'JetBrains'],
  [/^com\.googlecode\.iterm2/, 'iTerm'],
  [/^com\.apple\.Terminal/, 'Terminal'],
  [/^com\.mitchellh\.ghostty/, 'Ghostty'],
  [/^dev\.warp\./, 'Warp'],
  [/^com\.github\.wez\.wezterm/, 'WezTerm'],
]

const TERMINALS: Record<string, string> = {
  vscode: 'VS Code',
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  ghostty: 'Ghostty',
  WarpTerminal: 'Warp',
  WezTerm: 'WezTerm',
}

export function hostOf(env: { entrypoint?: string; termProgram?: string; bundleId?: string }): Host | undefined {
  const fromBundle = env.bundleId ? APPS.find(([re]) => re.test(env.bundleId!))?.[1] : undefined
  // The editor extensions say so themselves (claude-vscode, claude-jetbrains…).
  if (env.entrypoint && /^claude-(vscode|jetbrains|desktop)/.test(env.entrypoint)) {
    const app = fromBundle ?? (env.entrypoint.includes('jetbrains') ? 'JetBrains' : 'VS Code')
    return { app, kind: 'extension' }
  }
  const app = fromBundle ?? (env.termProgram ? TERMINALS[env.termProgram] ?? env.termProgram : undefined)
  return app ? { app, kind: 'terminal' } : undefined
}

/** "VS Code", "VS Code terminal", "iTerm": an editor's terminal says whose it is. */
export function hostLabel(h: Host): string {
  const editor = ['VS Code', 'Cursor', 'Windsurf', 'Zed', 'JetBrains'].includes(h.app)
  return h.kind === 'terminal' && editor ? `${h.app} terminal` : h.app
}
