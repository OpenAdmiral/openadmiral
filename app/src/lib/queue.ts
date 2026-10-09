import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { isDone, isDueByTime, isTimed, runNowPending, timeLabel, type QueueCondition, type QueueItemCore, type SentEntry } from "./schedule";
import type { Agent, AdmiralDelegation } from "./types";

/** docs/CONTRACT.md "queue/": the app owns the queue file, the mod writes `.sent.json`. */
export type { QueueCondition, SentEntry };

export type QueueItem = QueueItemCore & { [k: string]: unknown };
export type AdmiralQueue = { v: 1; paused: boolean; items: QueueItem[]; updatedAt?: number; [k: string]: unknown };
export type QueueEntry = { queue?: AdmiralQueue; sent?: { v: 1; sent: SentEntry[] } };

export const emptyQueue = (): AdmiralQueue => ({ v: 1, paused: false, items: [] });

export const newItemId = () => `q_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;

export const sentIds = (e?: QueueEntry) => new Set((e?.sent?.sent ?? []).map((s) => s.id));
export const sentList = (e?: QueueEntry): SentEntry[] => e?.sent?.sent ?? [];

/** Items the mod has not finished with, in order: schedules stay, a one-shot leaves once sent. */
export const pending = (e?: QueueEntry) => {
  const sent = sentList(e);
  return (e?.queue?.items ?? []).filter((i) => !isDone(i, sent));
};

/** One-shot items already sent: the app drops them from its file. */
export const finished = (e?: QueueEntry) => {
  const sent = sentList(e);
  return (e?.queue?.items ?? []).filter((i) => isDone(i, sent));
};

/** Writes the whole queue; unknown fields ride along untouched. */
export const saveQueue = (sessionId: string, queue: AdmiralQueue) => invoke("queue_save", { sessionId, queue });

/** Moves a queue to the id its session continues under (after /clear or a resumed copy), merging. */
export const moveQueue = (from: string, to: string) => invoke("queue_move", { from, to });

export type ItemState =
  | { kind: "next"; label: string }
  | { kind: "waiting"; label: string }
  | { kind: "queued"; label: string };

/** What the mod would do with each pending item now, mirroring its rules. */
export function itemStates(items: QueueItem[], paused: boolean, agent: Agent, agents: Agent[], delegations: AdmiralDelegation[], sent: readonly SentEntry[] = [], now = Date.now()): Map<string, ItemState> {
  const out = new Map<string, ItemState>();
  let nextTaken = false;
  const ordered = [...items.filter((i) => runNowPending(i, sent)), ...items.filter((i) => !runNowPending(i, sent))];
  for (const item of ordered) {
    if (item.paused) {
      out.set(item.id, { kind: "queued", label: "paused" });
      continue;
    }
    const forced = runNowPending(item, sent);
    if (!forced && isTimed(item) && !isDueByTime(item, sent, now)) {
      out.set(item.id, { kind: "waiting", label: "" });
      continue;
    }
    const unmet = forced ? null : conditionUnmet(item.after, agents, delegations);
    if (unmet) {
      out.set(item.id, { kind: "waiting", label: `waiting for ${unmet}` });
      continue;
    }
    if (!nextTaken) {
      nextTaken = true;
      out.set(
        item.id,
        paused
          ? { kind: "queued", label: "paused" }
          : agent.status === "working"
            ? { kind: "next", label: "waiting for turn to finish" }
            : agent.status === "ended"
              ? { kind: "queued", label: isTimed(item) || forced ? "OpenAdmiral resumes the session to run it" : "session not running" }
              : { kind: "next", label: forced ? "running now" : "next" },
      );
    } else out.set(item.id, { kind: "queued", label: "" });
  }
  return out;
}

/** A short phrase for what the condition still waits on, or null when it holds (time is shown apart). */
export function conditionUnmet(after: QueueCondition | undefined, agents: Agent[], delegations: AdmiralDelegation[]): string | null {
  if (!after || after.kind === "time" || after.kind === "schedule") return null;
  if (after.kind === "delegation") {
    const d = delegations.find((x) => x.id === after.id);
    if (d && after.status.includes(d.status as never)) return null;
    return `“${d?.title ?? after.id}” ${after.status.join("/")}`;
  }
  const a = agents.find((x) => x.id === after.sessionId);
  if (a && a.status === "idle") return null;
  return `${a?.name ?? after.sessionId.slice(0, 8)} to finish`;
}

export function conditionLabel(after: QueueCondition, agents: Agent[], delegations: AdmiralDelegation[], item?: QueueItemCore, sent: readonly SentEntry[] = [], now = Date.now()) {
  if (after.kind === "time" || after.kind === "schedule") {
    return timeLabel(after, item ?? { id: "", text: "", createdAt: now, after }, sent, now) ?? "";
  }
  if (after.kind === "delegation") {
    const d = delegations.find((x) => x.id === after.id);
    return `after “${d?.title ?? after.id}” is ${after.status.join(" or ")}`;
  }
  const a = agents.find((x) => x.id === after.sessionId);
  return `after ${a?.name ?? after.sessionId.slice(0, 8)} finishes`;
}

/**
 * Housekeeping for every queue, whatever is on screen: one-shot items the mod has
 * sent leave the file (after a moment, so the list can animate them out), and a
 * queue left under an id its session no longer has (/clear, a resumed copy) moves
 * to the id it continues under.
 */
export function useQueueJanitor(queues: Record<string, QueueEntry>, superseded: Map<string, string>) {
  useEffect(() => {
    const t = setTimeout(() => {
      for (const [id, entry] of Object.entries(queues)) {
        const to = superseded.get(id);
        if (to && to !== id) {
          moveQueue(id, to).catch(() => {});
          continue;
        }
        const done = finished(entry);
        if (entry.queue && done.length) saveQueue(id, { ...entry.queue, items: entry.queue.items.filter((i) => !done.includes(i)) }).catch(() => {});
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [queues, superseded]);
}

/** The app's scheduler resuming closed sessions for their due items (src-tauri/src/scheduler.rs). */
export type SchedulerEvent = { sessionId: string; state: "resuming" | "resumed" | "error"; name?: string; to?: string; error?: string };
