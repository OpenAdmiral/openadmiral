import { useState } from "react";
import type { Agent } from "./types";

export type SortMode = "order" | "recent";

/**
 * When an agent last did something, not when its plugin last wrote (a heartbeat
 * every 30 s, idle or not): the turn it started, its last tool or reply, the last
 * entry of its activity, when it began waiting. A session without the plugin: when
 * its conversation was last written.
 */
export function lastActivity(a: Agent): number {
  const s = a.session;
  if (!s) return a.cli?.startedAt ?? 0;
  if (a.unplugged) return s.startedAt;
  return Math.max(s.turn?.startedAt ?? 0, s.lastTool?.at ?? 0, s.activity?.at(-1)?.at ?? 0, s.waiting?.since ?? 0, s.startedAt ?? 0);
}

/** "Recent": the ones waiting on you first, then the most recently active, ended last. */
export function recentOrder(agents: Agent[]): Agent[] {
  const rank = (a: Agent) => (a.status === "waiting" ? 0 : a.status === "ended" ? 2 : 1);
  return [...agents].sort((a, b) => rank(a) - rank(b) || lastActivity(b) - lastActivity(a) || a.name.localeCompare(b.name));
}

/** My order or Recent, remembered across launches (this webview's storage). */
const KEY = "openadmiral.sidebar.sort";
export function useSortMode(): [SortMode, (m: SortMode) => void] {
  const [mode, setMode] = useState<SortMode>(() => {
    try {
      return localStorage.getItem(KEY) === "recent" ? "recent" : "order";
    } catch {
      return "order";
    }
  });
  const set = (m: SortMode) => {
    setMode(m);
    try {
      localStorage.setItem(KEY, m);
    } catch {
      // Not remembered; the choice still applies now.
    }
  };
  return [mode, set];
}
