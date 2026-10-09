import type { Agent, DelegationStatus, AdmiralDelegation } from "./types";
import type { QueueEntry } from "./queue";
import { isDone } from "./schedule";

/**
 * The relationships the Agents map draws between sessions, derived from data the app
 * already has: delegation files, the mod's activity log (SendMessage traffic), and the
 * Up next queues (session-idle conditions). Pure, so it can be tested without a UI.
 */
export type AgentLink =
  | {
      kind: "delegation";
      id: string;
      from: string;
      to: string;
      delegationId: string;
      title: string;
      status: DelegationStatus;
      at: number;
      /** Done or cancelled: drawn quieter. */
      settled: boolean;
      /** Queued prompts waiting on this delegation ("then tell …"). */
      conditions: { agentId: string; text: string; statuses: string[] }[];
    }
  | { kind: "message"; id: string; from: string; to: string; text: string; at: number; count: number }
  | { kind: "wait"; id: string; from: string; to: string; text: string; at: number; count: number };

export const DAY = 24 * 60 * 60_000;
/** SendMessage traffic older than this is not a live relationship any more. */
export const MESSAGE_WINDOW = 3 * 60 * 60_000;

/**
 * The agent an address names, as SendMessage `to` or a delegation's `to.address` would:
 * session id (or its 8-char prefix), CLI name, session name, display name, then project.
 * Live agents win over ended ones that share the name.
 */
export function resolveAddress(address: string | undefined, agents: Agent[]): Agent | undefined {
  const a = address?.trim().replace(/^@/, "");
  if (!a) return undefined;
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

/** The session that owns a subagent with this id (SendMessage can address a teammate by id). */
function subagentOwner(address: string, agents: Agent[]) {
  return agents.find((x) => x.session?.subagents?.some((s) => s.id === address));
}

export function delegationLinks(delegations: AdmiralDelegation[], agents: Agent[], now: number, queues: Record<string, QueueEntry> = {}): AgentLink[] {
  const conditions = new Map<string, { agentId: string; text: string; statuses: string[] }[]>();
  for (const [agentId, entry] of Object.entries(queues)) {
    for (const item of pendingItems(entry)) {
      if (item.after?.kind !== "delegation") continue;
      const list = conditions.get(item.after.id) ?? [];
      list.push({ agentId, text: item.text, statuses: item.after.status });
      conditions.set(item.after.id, list);
    }
  }
  const out: AgentLink[] = [];
  for (const d of delegations) {
    const settled = d.status === "done" || d.status === "cancelled";
    // Finished work stays on the map for a day, then leaves it.
    if (settled && now - d.updatedAt > DAY) continue;
    const from = agents.find((x) => x.id === d.from.sessionId);
    const to = (d.to.sessionId && agents.find((x) => x.id === d.to.sessionId)) || resolveAddress(d.to.address, agents) || subagentOwner(d.to.address, agents);
    if (!from || !to || from.id === to.id) continue;
    out.push({
      kind: "delegation",
      id: `dlg:${d.id}`,
      from: from.id,
      to: to.id,
      delegationId: d.id,
      title: d.title,
      status: d.status,
      at: d.updatedAt,
      settled,
      conditions: conditions.get(d.id) ?? [],
    });
  }
  return out;
}

/**
 * A `sent` activity entry as the mod writes it for SendMessage: `→ <to>: <summary>`.
 * The delegate tool's own line (`⇢ <to>: <title>`) and status lines (`dlg_… → done`)
 * are not messages: delegations are drawn from their files.
 */
export function parseSent(text: string): { to: string; text: string } | null {
  const m = text.match(/^→\s*([^\s:][^:]*?)\s*:\s?([\s\S]*)$/);
  if (!m) return null;
  return { to: m[1].trim(), text: m[2].trim() };
}

/**
 * Recent SendMessage traffic between sessions, one link per direction and pair (the
 * latest text, and how many). `received` entries carry no sender, so only the sender's
 * `sent` side draws a link; messages to one's own subagents stay inside the node.
 */
export function messageLinks(agents: Agent[], now: number, windowMs = MESSAGE_WINDOW): AgentLink[] {
  const pairs = new Map<string, Extract<AgentLink, { kind: "message" }>>();
  for (const a of agents) {
    const own = new Set(a.session?.subagents?.map((s) => s.id) ?? []);
    for (const e of a.session?.activity ?? []) {
      if (e.kind !== "sent" || now - e.at > windowMs) continue;
      const msg = parseSent(e.text);
      if (!msg || own.has(msg.to)) continue;
      const to = resolveAddress(msg.to, agents.filter((x) => x.id !== a.id)) ?? subagentOwner(msg.to, agents);
      if (!to || to.id === a.id) continue;
      const key = `${a.id}>${to.id}`;
      const prev = pairs.get(key);
      if (!prev) pairs.set(key, { kind: "message", id: `msg:${key}`, from: a.id, to: to.id, text: msg.text, at: e.at, count: 1 });
      else {
        prev.count++;
        if (e.at >= prev.at) {
          prev.at = e.at;
          prev.text = msg.text;
        }
      }
    }
  }
  return [...pairs.values()];
}

type PendingItem = NonNullable<NonNullable<QueueEntry["queue"]>["items"]>[number];

/** Queue items the mod has not submitted yet (mirrors queue.ts `pending`, without its Tauri import). */
function pendingItems(entry: QueueEntry | undefined): PendingItem[] {
  const sent = entry?.sent?.sent ?? [];
  return (entry?.queue?.items ?? []).filter((i) => !isDone(i, sent));
}

/** "Waits for": a queued prompt that runs once another session finishes its turn. */
export function waitLinks(queues: Record<string, QueueEntry>, agents: Agent[]): AgentLink[] {
  const pairs = new Map<string, Extract<AgentLink, { kind: "wait" }>>();
  for (const [agentId, entry] of Object.entries(queues)) {
    if (!agents.some((x) => x.id === agentId)) continue;
    for (const item of pendingItems(entry)) {
      if (item.after?.kind !== "session-idle") continue;
      const target = item.after.sessionId;
      if (target === agentId || !agents.some((x) => x.id === target)) continue;
      const key = `${agentId}>${target}`;
      const prev = pairs.get(key);
      if (prev) prev.count++;
      else pairs.set(key, { kind: "wait", id: `wait:${key}`, from: agentId, to: target, text: item.text, at: item.createdAt, count: 1 });
    }
  }
  return [...pairs.values()];
}

/** Every link among `agents` (those on the map); links to agents not shown are dropped. */
export function agentLinks(input: { agents: Agent[]; shown: Agent[]; delegations: AdmiralDelegation[]; queues: Record<string, QueueEntry>; now: number }): AgentLink[] {
  const { agents, shown, delegations, queues, now } = input;
  const visible = new Set(shown.map((a) => a.id));
  return [...delegationLinks(delegations, agents, now, queues), ...messageLinks(agents, now), ...waitLinks(queues, agents)].filter(
    (l) => visible.has(l.from) && visible.has(l.to),
  );
}

/**
 * Agents of one repo working in different checkouts (linked worktrees or other
 * branches): a note for the project's cluster, or null when they all share one.
 */
export function sharedCheckout(agents: Agent[]): { agents: number; worktrees: number; branches: string[] } | null {
  const withRepo = agents.filter((a) => a.status !== "ended" && a.session?.repo?.root);
  if (withRepo.length < 2) return null;
  const checkouts = new Set(withRepo.map((a) => `${a.cwd}\u0000${a.session?.branch ?? ""}`));
  const branches = [...new Set(withRepo.map((a) => a.session?.branch).filter((b): b is string => !!b))];
  if (checkouts.size < 2 && branches.length < 2) return null;
  return { agents: withRepo.length, worktrees: withRepo.filter((a) => a.session?.worktree).length, branches };
}
