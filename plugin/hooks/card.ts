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
