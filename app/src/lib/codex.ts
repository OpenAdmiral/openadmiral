import type { Agent, AdmiralSession } from "./types";
import { basename } from "./utils";

/** A Codex agent as src-tauri/src/codex.rs lists it. */
export type CodexRow = {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  prompt?: string | null;
  status: "working" | "waiting" | "idle" | "ended";
  running: boolean;
  updatedAt: number | null;
  lastReply: string | null;
  waiting: string | null;
  argv: string[];
};

/**
 * A Codex agent drawn like the others: its terminal runs `argv` in the app (Codex has no
 * background jobs), so it is attachable whenever it has not been removed.
 */
export function codexAgent(r: CodexRow, now = Date.now()): Agent {
  const at = r.updatedAt ?? r.createdAt;
  const session = {
    v: 1,
    sessionId: r.id,
    cwd: r.cwd,
    project: basename(r.cwd),
    status: r.status,
    startedAt: r.createdAt,
    updatedAt: Math.min(at, now),
    lastReply: r.lastReply ?? undefined,
    waiting: r.status === "waiting" ? { reason: "permission", detail: r.waiting ?? undefined, since: Math.min(at, now) } : undefined,
  } as AdmiralSession;
  return {
    id: r.id,
    name: r.name,
    project: basename(r.cwd),
    cwd: r.cwd,
    // Its terminal (re)starts Codex when it opens: it is always one click away.
    attachable: true,
    live: true,
    status: r.status === "ended" ? "idle" : r.status,
    session,
    codex: { argv: r.argv, running: r.running },
  };
}
