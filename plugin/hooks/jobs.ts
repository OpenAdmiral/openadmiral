// Shell commands Claude runs in the background (Bash with run_in_background): when they start,
// where their output goes and how they end. The app reads that output to measure their own
// progress (docs/CONTRACT.md, jobs). Pure: register.tsx feeds it the engine's rows.

export type JobStatus = 'running' | 'completed' | 'failed' | 'killed'
export type Job = { id: string; label?: string; output?: string; startedAt: number; endedAt?: number; status: JobStatus; exitCode?: number }

/** Jobs kept per session: the running ones and the latest finished. */
export const JOBS_KEPT = 10

/** "Command running in background with ID: bnf211hsl. Output is being written to: /…/bnf211hsl.output" */
export function backgroundStart(text: string): { id: string; output: string } | undefined {
  const m = text.match(/running in background with ID: ([\w-]+)\. Output is being written to: (\S+?\.output)\b/)
  return m ? { id: m[1], output: m[2] } : undefined
}

/** A `<task-notification>`: which background task ended, and how. */
export function taskNotification(text: string): { id: string; status: JobStatus; output?: string; exitCode?: number } | undefined {
  if (!text.includes('<task-notification>')) return undefined
  const tag = (name: string) => text.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim()
  const id = tag('task-id')
  const raw = tag('status')
  if (!id || !raw) return undefined
  const status: JobStatus = raw === 'completed' ? 'completed' : raw === 'killed' || raw === 'stopped' ? 'killed' : raw === 'failed' ? 'failed' : 'running'
  const code = tag('summary')?.match(/exit code (-?\d+)/)?.[1]
  const exitCode = code === undefined ? undefined : Number(code)
  return { id, status: status === 'completed' && exitCode ? 'failed' : status, output: tag('output-file'), exitCode }
}

/** Merges what is known about one job into the list: newest last, finished ones dropped first. */
export function upsertJob(list: Job[], patch: Partial<Job> & { id: string }, now: number): Job[] {
  const old = list.find(j => j.id === patch.id)
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Job>
  const job: Job = { status: 'running', startedAt: now, ...old, ...defined, id: patch.id }
  const rest = list.filter(j => j.id !== patch.id)
  const next = old ? list.map(j => (j.id === patch.id ? job : j)) : [...rest, job]
  while (next.length > JOBS_KEPT) {
    const finished = next.findIndex(j => j.status !== 'running')
    next.splice(finished === -1 ? 0 : finished, 1)
  }
  return next
}
