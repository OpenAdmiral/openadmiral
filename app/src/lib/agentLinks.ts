import type { Agent } from "./types";
import type { QueueEntry } from "./queue";
import { isDone } from "./schedule";

/** "Waits for", as the Agents map draws it: from the Up next queues (session-idle conditions). Pure. */
export type WaitLink = { id: string; from: string; to: string; text: string; at: number; count: number };

/**
 * The agent an address names, as SendMessage `to` would:
 * session id (or its 8-char prefix), CLI name, session name, display name, then project.
 * Live agents win over ended ones that share the name.
 */
export function resolveAddress(address: string | undefined, agents: Agent[]): Agent | undefined {
  const a = address?.trim().replace(/^@/, "");
  if (!a) return undefined;
  const pid = /^uds:.*\/(\d+)\.sock$/.exec(a)?.[1];
  if (pid) return agents.find((x) => String(x.cli?.pid) === pid);
  const lower = a.toLowerCase();
  const tests: ((x: Agent) => boolean)[] = [
    (x) => x.id === a,
    (x) => a.length >= 8 && x.id.startsWith(a),
    (x) => x.cli?.name === a || x.session?.name === a || x.name === a,
    (x) => x.name.toLowerCase() === lower,
    (x) => x.project === a,
  ];
  for (const test of tests) {
    const hits = agents.filter(test);
    if (hits.length) return hits.find((x) => x.status !== "ended") ?? hits[0];
  }
  return undefined;
}

/** Text with a session's socket address (`uds:/tmp/cc-socks/1881.sock`) in it, as a person reads it. */
export const withAgentNames = (text: string, agents: Agent[]) => text.replace(/uds:\S*\.sock/g, (address) => resolveAddress(address, agents)?.name ?? "another session");

type PendingItem = NonNullable<NonNullable<QueueEntry["queue"]>["items"]>[number];

/** Queue items the mod has not submitted yet (mirrors queue.ts `pending`, without its Tauri import). */
function pendingItems(entry: QueueEntry | undefined): PendingItem[] {
  const sent = entry?.sent?.sent ?? [];
  return (entry?.queue?.items ?? []).filter((i) => !isDone(i, sent));
}

/** "Waits for": a queued prompt that runs once another session finishes its turn. */
export function waitLinks(queues: Record<string, QueueEntry>, agents: Agent[]): WaitLink[] {
  const pairs = new Map<string, WaitLink>();
  for (const [agentId, entry] of Object.entries(queues)) {
    if (!agents.some((x) => x.id === agentId)) continue;
    for (const item of pendingItems(entry)) {
      if (item.after?.kind !== "session-idle") continue;
      const target = item.after.sessionId;
      if (target === agentId || !agents.some((x) => x.id === target)) continue;
      const key = `${agentId}>${target}`;
      const prev = pairs.get(key);
      if (prev) prev.count++;
      else pairs.set(key, { id: `wait:${key}`, from: agentId, to: target, text: item.text, at: item.createdAt, count: 1 });
    }
  }
  return [...pairs.values()];
}
