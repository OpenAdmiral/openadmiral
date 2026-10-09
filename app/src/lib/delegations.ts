import { invoke } from "@tauri-apps/api/core";
import { resolveAddress } from "./agentLinks";
import type { Agent, AdmiralDelegation } from "./types";

const HOUR = 3_600_000;
/** An open delegation with no news for this long is stale, whoever is still running. */
export const STALE_AFTER = 24 * HOUR;
/** How long a delegation may point at an agent that is not running before it counts as stale. */
const GRACE = 30 * 60_000;
/** Done or cancelled ones stay on the Active board this long. */
export const RECENT_DONE = 24 * HOUR;

export const isOpen = (d: AdmiralDelegation) => d.status !== "done" && d.status !== "cancelled";

/** The agent at one end: by session id, else by the address/name/project it was sent to. */
export function findEnd(agents: Agent[], sessionId: string | undefined, label: string) {
  return agents.find((a) => a.id === sessionId) ?? resolveAddress(label, agents);
}

/**
 * Why an open delegation is no longer going anywhere, or undefined while it is
 * alive: an end that is not running (nobody can act on it) or no update for a day.
 */
export function staleReason(d: AdmiralDelegation, agents: Agent[], now: number): string | undefined {
  if (!isOpen(d)) return undefined;
  const running = (a: Agent | undefined) => !!a && a.status !== "ended";
  const from = findEnd(agents, d.from.sessionId, d.from.project);
  const to = findEnd(agents, d.to.sessionId, d.to.address);
  // A fresh one gets a grace period: its address may not match an agent name yet.
  const settled = now - d.updatedAt > GRACE;
  if (settled && !running(from) && !running(to)) return "Neither agent is running";
  if (settled && !running(to)) return `${d.to.address} isn't running`;
  if (now - d.updatedAt > STALE_AFTER) return `No update for ${Math.floor((now - d.updatedAt) / HOUR)} h`;
  return undefined;
}

/** On the Active board: open and not stale, or closed in the last day. */
export function isActive(d: AdmiralDelegation, agents: Agent[], now: number) {
  return isOpen(d) ? !staleReason(d, agents, now) : now - d.updatedAt < RECENT_DONE;
}

/** Open delegations that still need someone: what the sidebar badge counts. */
export const activeOpenCount = (ds: AdmiralDelegation[], agents: Agent[], now: number) =>
  ds.filter((d) => isOpen(d) && !staleReason(d, agents, now)).length;

export const closeDelegation = (id: string, status: "done" | "cancelled", note: string) => invoke("delegation_close", { id, status, note });
