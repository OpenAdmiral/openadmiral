import { expect, test } from 'claude-code/testing'
import { backgroundStart, JOBS_KEPT, taskNotification, upsertJob, type Job } from '../hooks/jobs'

test('a background command says where its output goes', () => {
  const text =
    'Command running in background with ID: bnf211hsl. Output is being written to: /private/tmp/claude-502/-Users-x/aee3888e/tasks/bnf211hsl.output. You will be notified when it completes.'
  expect(backgroundStart(text)).toEqual({ id: 'bnf211hsl', output: '/private/tmp/claude-502/-Users-x/aee3888e/tasks/bnf211hsl.output' })
  expect(backgroundStart('Command completed')).toBeUndefined()
})

test('a task notification says how it ended', () => {
  const note = (status: string, summary: string) =>
    `<task-notification>\n<task-id>bnf211hsl</task-id>\n<output-file>/tmp/t/bnf211hsl.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`
  expect(taskNotification(note('completed', 'Background command "Run tests" completed (exit code 0)'))).toEqual({ id: 'bnf211hsl', status: 'completed', output: '/tmp/t/bnf211hsl.output', exitCode: 0 })
  expect(taskNotification(note('completed', 'Background command "Run tests" completed (exit code 2)'))?.status).toBe('failed')
  expect(taskNotification(note('killed', 'Background command "Run tests" was stopped'))?.status).toBe('killed')
  expect(taskNotification('just text')).toBeUndefined()
})

test('jobs merge by id and keep the running ones', () => {
  let list: Job[] = []
  list = upsertJob(list, { id: 'a', label: 'cargo test' }, 1)
  list = upsertJob(list, { id: 'a', output: '/tmp/a.output', label: undefined }, 2)
  expect(list).toEqual([{ id: 'a', label: 'cargo test', output: '/tmp/a.output', startedAt: 1, status: 'running' }])
  list = upsertJob(list, { id: 'a', status: 'completed', endedAt: 9, exitCode: 0 }, 9)
  expect(list[0]).toMatchObject({ status: 'completed', endedAt: 9, startedAt: 1 })
  for (let i = 0; i < JOBS_KEPT + 3; i++) list = upsertJob(list, { id: `r${i}` }, 10 + i)
  expect(list.length).toBe(JOBS_KEPT)
  // The finished one went first.
  expect(list.some(j => j.id === 'a')).toBe(false)
})
