import { expect, test } from 'claude-code/testing'
import { hostLabel, hostOf } from '../hooks/host'

test('where a session runs, from its environment', () => {
  const ext = hostOf({ entrypoint: 'claude-vscode', bundleId: 'com.microsoft.VSCode' })
  expect(ext).toEqual({ app: 'VS Code', kind: 'extension' })
  expect(hostLabel(ext!)).toBe('VS Code')
  const term = hostOf({ entrypoint: 'cli', termProgram: 'vscode', bundleId: 'com.microsoft.VSCode' })
  expect(hostLabel(term!)).toBe('VS Code terminal')
  expect(hostLabel(hostOf({ termProgram: 'vscode', bundleId: 'com.todesktop.230313mmzas' })!)).toBe('Cursor terminal')
  expect(hostLabel(hostOf({ termProgram: 'iTerm.app', bundleId: 'com.googlecode.iterm2' })!)).toBe('iTerm')
  expect(hostLabel(hostOf({ termProgram: 'ghostty' })!)).toBe('Ghostty')
  expect(hostOf({})).toBeUndefined()
})
