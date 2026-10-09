import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./types";

/**
 * The sidebar order the person chose, saved in the app data dir.
 * Projects are keyed by repo root (else cwd), agents by session name (else id),
 * so an agent resumed under the same name comes back to its place.
 */
export type SidebarOrder = { projects: string[]; agents: Record<string, string[]> };

export type Group = { key: string; label: string; agents: Agent[] };

export const projectKeyOf = (a: Agent) => a.session?.repo?.root ?? a.cwd;
// A remembered name (the agent left `claude agents`) still keys it, so it keeps its place.
export const agentKeyOf = (a: Agent) => a.cli?.name ?? a.session?.name ?? (a.name !== a.project ? a.name : a.id);

/**
 * `full` with the entries it shares with `visible` rearranged into `visible`'s
 * order: keys not on screen keep their slots, so an agent that comes back
 * returns to where it was.
 */
export function reorderVisible(full: string[], visible: string[]) {
  const shown = new Set(visible);
  const queue = [...visible];
  const merged = full.map((k) => (shown.has(k) ? queue.shift()! : k));
  return [...merged, ...queue];
}

/** `list` with `from` replaced by `to` in place (any older `to` entry dropped); unchanged if `from` is absent. */
export function renameEntry(list: string[], from: string, to: string) {
  if (!list.includes(from)) return list;
  return list.filter((k) => k !== to).map((k) => (k === from ? to : k));
}

const appendMissing = (list: string[], keys: string[]) => [...list, ...keys.filter((k) => !list.includes(k))];

export function useSidebarOrder(agents: Agent[], cliReady: boolean) {
  const [order, setOrder] = useState<SidebarOrder | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    invoke<SidebarOrder | null>("order_load")
      .then((o) => setOrder({ projects: o?.projects ?? [], agents: o?.agents ?? {} }))
      .catch(() => setOrder({ projects: [], agents: {} }))
      .finally(() => (loaded.current = true));
  }, []);

  const save = useCallback((next: SidebarOrder) => {
    setOrder(next);
    invoke("order_save", { order: next }).catch(() => {});
  }, []);

  // Grouped by project, unknown keys placed by name until they are appended below.
  const groups = useMemo<Group[]>(() => {
    const byKey = new Map<string, Group>();
    for (const a of agents) {
      const key = projectKeyOf(a);
      const g = byKey.get(key) ?? { key, label: a.project, agents: [] };
      g.agents.push(a);
      byKey.set(key, g);
    }
    const rank = (list: string[] | undefined, k: string) => {
      const i = list?.indexOf(k) ?? -1;
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const list = [...byKey.values()];
    for (const g of list) {
      const agentOrder = order?.agents[g.key];
      g.agents.sort((a, b) => rank(agentOrder, agentKeyOf(a)) - rank(agentOrder, agentKeyOf(b)) || agentKeyOf(a).localeCompare(agentKeyOf(b)));
    }
    return list.sort((a, b) => rank(order?.projects, a.key) - rank(order?.projects, b.key) || a.label.localeCompare(b.label));
  }, [agents, order]);

  // New projects and agents go to the end, and stay there once seen. Not before the
  // CLI has answered: until then agents lack their names and would be keyed by id.
  useEffect(() => {
    if (!order || !loaded.current || !cliReady || groups.length === 0) return;
    let changed = false;
    const projects = appendMissing(order.projects, groups.map((g) => g.key));
    if (projects.length !== order.projects.length) changed = true;
    const agentsOrder = { ...order.agents };
    for (const g of groups) {
      const before = agentsOrder[g.key] ?? [];
      // An agent first seen by id and now known by name keeps its place under the name.
      const renamed = before.map((k) => {
        const a = g.agents.find((x) => x.id === k && agentKeyOf(x) !== k);
        return a && !before.includes(agentKeyOf(a)) ? agentKeyOf(a) : k;
      });
      const after = appendMissing(renamed, g.agents.map(agentKeyOf));
      if (after.length !== before.length || after.some((k, i) => k !== before[i])) {
        agentsOrder[g.key] = after;
        changed = true;
      }
    }
    if (changed) save({ projects, agents: agentsOrder });
  }, [groups, order, save, cliReady]);

  const moveProject = useCallback(
    (from: number, to: number) => {
      if (!order || from === to) return;
      const visible = groups.map((g) => g.key);
      const [moved] = visible.splice(from, 1);
      visible.splice(to, 0, moved);
      save({ ...order, projects: reorderVisible(order.projects, visible) });
    },
    [groups, order, save],
  );

  const moveAgent = useCallback(
    (projectKey: string, from: number, to: number) => {
      const g = groups.find((x) => x.key === projectKey);
      if (!order || !g || from === to) return;
      const visible = g.agents.map(agentKeyOf);
      const [moved] = visible.splice(from, 1);
      visible.splice(to, 0, moved);
      save({ ...order, agents: { ...order.agents, [projectKey]: reorderVisible(order.agents[projectKey] ?? [], visible) } });
    },
    [groups, order, save],
  );

  // A renamed agent keeps its place (and its ⌘N): its entry moves to the new name.
  const renameKey = useCallback(
    (a: Agent, from: string, to: string) => {
      if (!order || from === to) return;
      const key = projectKeyOf(a);
      save({ ...order, agents: { ...order.agents, [key]: renameEntry(order.agents[key] ?? [], from, to) } });
    },
    [order, save],
  );

  const reset = useCallback(() => save({ projects: [], agents: {} }), [save]);

  const flat = useMemo(() => groups.flatMap((g) => g.agents), [groups]);
  return { groups, flat, moveProject, moveAgent, renameKey, reset, ready: order !== null };
}
