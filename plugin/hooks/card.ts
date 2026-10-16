// Pure helpers for the `show` tool's transcript card (the drawing itself lives in
// register.tsx: the engine follows `$` only within the hooks module's own file).

export const ICON: Record<string, string> = {
  image: '▣', html: '◧', markdown: '¶', mermaid: '⌘', pdf: '▤', diff: '±', text: '≡',
}

export const slugOf = (title: string) =>
  title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact'

/** The version and kind the tool answered ("Shown in OpenAdmiral: "X" (v2, image)."). */
export function parseAnswer(output: unknown) {
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const m = text.match(/\(v(\d+), ([a-z]+)\)/)
  return m ? { version: Number(m[1]), kind: m[2]! } : undefined
}

/** What a delegation tool call draws in the chat: one line of what happened, one of detail. */
export function delegationCard(tool: 'delegate' | 'delegation_update', input: unknown, output: unknown): { head: string; detail?: string; warn?: string } {
  const args = (input ?? {}) as { to?: string; title?: string; id?: string; status?: string; note?: string; result?: string }
  const text = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  const first = (s?: string) => s?.split('\n')[0]?.trim() || undefined
  // The plugin could not deliver it: Claude sends it itself, which the next row shows.
  const unsent = text.match(/could not (?:deliver it|notify ([^(]+?)) \(/)
  const warn = unsent ? `OpenAdmiral could not deliver it${unsent[1] ? ` to ${unsent[1].trim()}` : ''}: Claude sends it with SendMessage` : undefined
  if (tool === 'delegate') {
    const id = text.match(/\b(dlg_[a-z0-9]{8})\b/)?.[1]
    return { head: `Delegated “${args.title ?? 'work'}” to ${args.to ?? 'another session'}`, detail: id, warn }
  }
  return { head: `${args.id ?? 'Delegation'} → ${args.status ?? 'updated'}`, detail: first(args.result) ?? first(args.note), warn }
}
