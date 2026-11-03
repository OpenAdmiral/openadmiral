import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./types";

/**
 * The sidebar order the person chose, saved in the app data dir.
 * Projects are keyed by repo root (else cwd), agents by session name (else id),
 * so an agent resumed under the same name comes back to its place.
 * `projects` is the top level: group keys (a folder's agents) and `space:<id>` for the
 * projects the person made (`spaces`). A project holds whole groups (`members`, new agents
 * of the folder join too) and single agents (`placed`: "<folder>\0<agent key>" → the
 * project's id, or "" for the top level, overriding where its group is).
 * `dismissed`: suggested projects turned down.
 */
export type SidebarOrder = { projects: string[]; agents: Record<string, string[]>; spaces?: Space[]; placed?: Record<string, string>; dismissed?: string[] };

/**
 * A folder's agents as drawn in one place. `key` is the folder; `slot` tells apart the
 * pieces of one folder when some of its agents sit in another project.
 */
export type Group = { key: string; label: string; agents: Agent[]; slot?: string; space?: string };

export const slotOf = (g: Group) => g.slot ?? g.key;

/** A project the person made: a name, a color and the groups it holds, in order. */
export type Space = {
  id: string;
  name: string;
  color: string;
  members: string[];
  /** A logo, as a data URL (a website's icon). */
  icon?: string;
  /** The order its groups are drawn in, as arranged by hand (whole groups and ones with only some agents here). */
  order?: string[];
};

export const placedKey = (folder: string, agent: string) => `${folder}\u0000${agent}`;

/** The sidebar as drawn: folders on their own, and projects with their folders. */
export type Node = { kind: "group"; group: Group } | { kind: "space"; space: Space; groups: Group[] };

export const spaceKey = (id: string) => `space:${id}`;

/** Project colors, in the order new projects take them. */
export const SPACE_COLORS = [
  "#6366f1", "#0ea5e9", "#14b8a6", "#f59e0b", "#f43f5e", "#a855f7", "#22c55e", "#f97316", "#3b82f6",
  "#06b6d4", "#10b981", "#84cc16", "#eab308", "#ef4444", "#ec4899", "#8b5cf6", "#64748b",
];

const rankIn = (list: string[] | undefined, k: string) => {
  const i = list?.indexOf(k) ?? -1;
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

/** The project a whole group belongs to ("" for the top level). */
export function groupHome(order: SidebarOrder | null, folder: string) {
  return (order?.spaces ?? []).find((s) => s.members.includes(folder))?.id ?? "";
}

/** Where an agent is drawn: its own placement, else its group's. */
export function agentHome(order: SidebarOrder | null, folder: string, agent: string) {
  const p = order?.placed?.[placedKey(folder, agent)];
  if (p !== undefined && (p === "" || order?.spaces?.some((s) => s.id === p))) return p;
  return groupHome(order, folder);
}

/** `groups` (sorted, whole folders) placed into the person's projects; a project shows even when empty. */
export function layout(groups: Group[], order: SidebarOrder | null): Node[] {
  const spaces = order?.spaces ?? [];
  // Each folder split by where its agents are drawn.
  const pieces = new Map<string, Group[]>();
  for (const g of groups) {
    const by = new Map<string, Agent[]>();
    for (const a of g.agents) {
      const at = agentHome(order, g.key, agentKeyOf(a));
      by.set(at, [...(by.get(at) ?? []), a]);
    }
    for (const [at, agents] of by) pieces.set(at, [...(pieces.get(at) ?? []), { ...g, agents, slot: at ? `${at}\u0001${g.key}` : g.key, space: at || undefined }]);
  }
  const top: { key: string; node: Node }[] = [
    ...(pieces.get("") ?? []).map((g) => ({ key: g.key, node: { kind: "group", group: g } as Node })),
    ...spaces.map((s) => {
      const inside = pieces.get(s.id) ?? [];
      // Its whole groups in its order, then groups with only some agents here.
      const ordered = [...inside].sort(
        (a, b) => rankIn(s.order, a.key) - rankIn(s.order, b.key) || rankIn(s.members, a.key) - rankIn(s.members, b.key) || a.label.localeCompare(b.label),
      );
      return { key: spaceKey(s.id), node: { kind: "space", space: s, groups: ordered } as Node };
    }),
  ];
  // Stable: folders not yet placed keep their sorted order, after the placed ones.
  return top.map((t, i) => ({ ...t, i })).sort((a, b) => rankIn(order?.projects, a.key) - rankIn(order?.projects, b.key) || a.i - b.i).map((t) => t.node);
}

/** Groups on screen, in the order drawn. */
export const flatten = (tree: Node[]) => tree.flatMap((n) => (n.kind === "group" ? [n.group] : n.groups));

/** A name for folders that share a prefix: "acme-" → "Acme". */
export const prefixName = (prefix: string) => {
  const word = prefix.replace(/[-_.]+$/, "");
  return word.charAt(0).toUpperCase() + word.slice(1);
};

/** Folders on their own that share a `name-` prefix (two or more), as project suggestions. */
export function suggestSpaces(tree: Node[], order: SidebarOrder | null): { name: string; keys: string[]; labels: string[] }[] {
  const byPrefix = new Map<string, Group[]>();
  for (const n of tree) {
    if (n.kind !== "group") continue;
    const prefix = n.group.label.match(/^([a-z0-9]+)[-_]/i)?.[1];
    if (prefix) byPrefix.set(prefix.toLowerCase(), [...(byPrefix.get(prefix.toLowerCase()) ?? []), n.group]);
  }
  const taken = new Set((order?.spaces ?? []).map((s) => s.name.toLowerCase()));
  return [...byPrefix]
    .filter(([p, gs]) => gs.length >= 2 && !taken.has(p) && !order?.dismissed?.includes(p))
    .map(([p, gs]) => ({ name: prefixName(p), keys: gs.map((g) => g.key), labels: gs.map((g) => g.label) }));
}

// ---- changes to the order: pure, so they are tested on their own ----

/** Moves single agents of a folder to a project, or "" for the top level. */
export function placeAgents(o: SidebarOrder, folder: string, agents: string[], space: string): SidebarOrder {
  const placed = { ...(o.placed ?? {}) };
  const home = groupHome(o, folder);
  for (const a of agents) {
    // Where its group already is: no placement of its own needed.
    if (space === home) delete placed[placedKey(folder, a)];
    else placed[placedKey(folder, a)] = space;
  }
  return { ...o, placed };
}

const without = (o: SidebarOrder, keys: string[]) => (o.spaces ?? []).map((s) => ({ ...s, members: s.members.filter((m) => !keys.includes(m)) }));

/** A new project holding `keys`, drawn where `at` is (a top-level key), else first. */
export function addSpace(o: SidebarOrder, space: Omit<Space, "members">, keys: string[] = [], at?: string): SidebarOrder {
  const projects = o.projects.filter((k) => k !== spaceKey(space.id));
  const i = at ? projects.indexOf(at) : -1;
  projects.splice(i === -1 ? 0 : i, 0, spaceKey(space.id));
  return { ...o, projects, spaces: [...without(o, keys), { ...space, members: keys }] };
}

export const updateSpace = (o: SidebarOrder, id: string, patch: { name?: string; color?: string; icon?: string | null }): SidebarOrder => ({
  ...o,
  spaces: (o.spaces ?? []).map((s) => {
    if (s.id !== id) return s;
    const { icon, ...rest } = patch;
    const next = { ...s, ...rest };
    if (icon === null) delete next.icon;
    else if (icon !== undefined) next.icon = icon;
    return next;
  }),
});

/** The groups of a project in a new order (`visible`: the ones on screen, in their new order). */
export const arrangeSpace = (o: SidebarOrder, id: string, visible: string[]): SidebarOrder => ({
  ...o,
  spaces: (o.spaces ?? []).map((s) => (s.id === id ? { ...s, order: reorderVisible(s.order ?? [], visible) } : s)),
});

/** Removes a project; its folders come back to the top level where it was. */
export function removeSpace(o: SidebarOrder, id: string): SidebarOrder {
  const s = (o.spaces ?? []).find((x) => x.id === id);
  if (!s) return o;
  const projects = o.projects.filter((k) => !s.members.includes(k)).flatMap((k) => (k === spaceKey(id) ? s.members : [k]));
  const placed = Object.fromEntries(Object.entries(o.placed ?? {}).filter(([, at]) => at !== id));
  return { ...o, projects, placed, spaces: (o.spaces ?? []).filter((x) => x.id !== id) };
}

/**
 * Moves a folder into a project (before `before`, one of its folders, else last) or, with
 * `space` null, out to the top level (before `before`, a top-level key, else last).
 */
export function placeFolder(o: SidebarOrder, key: string, space: string | null, before?: string, agents: string[] = []): SidebarOrder {
  const spaces = without(o, [key]);
  // The agents that came with it follow the group again; others placed where it now is too.
  const placed = Object.fromEntries(
    Object.entries(o.placed ?? {}).filter(([k, at]) => !(k.startsWith(`${key}\u0000`) && (agents.includes(k.slice(key.length + 1)) || at === (space ?? "")))),
  );
  if (space === null) {
    const projects = o.projects.filter((k) => k !== key);
    const i = before ? projects.indexOf(before) : -1;
    projects.splice(i === -1 ? projects.length : i, 0, key);
    return { ...o, projects, spaces, placed };
  }
  return {
    ...o,
    placed,
    spaces: spaces.map((s) => {
      if (s.id !== space) return s;
      const members = [...s.members];
      const i = before ? members.indexOf(before) : -1;
      members.splice(i === -1 ? members.length : i, 0, key);
      return { ...s, members };
    }),
  };
}

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

/** `readOnly`: a floating window draws the arrangement; only the main window saves it. */
/** Saves the order, and floating windows follow it. */
const store = (order: SidebarOrder) => {
  invoke("order_save", { order }).catch(() => {});
  emit("openadmiral://order", order).catch(() => {});
};

export function useSidebarOrder(agents: Agent[], cliReady: boolean, { readOnly = false } = {}) {
  const [order, setOrder] = useState<SidebarOrder | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    invoke<SidebarOrder | null>("order_load")
      .then((o) => setOrder({ projects: o?.projects ?? [], agents: o?.agents ?? {}, spaces: o?.spaces ?? [], placed: o?.placed ?? {}, dismissed: o?.dismissed ?? [] }))
      .catch(() => setOrder({ projects: [], agents: {} }))
      .finally(() => (loaded.current = true));
  }, []);

  useEffect(() => {
    if (!readOnly) return;
    const off = listen<SidebarOrder>("openadmiral://order", (e) => setOrder(e.payload));
    return () => void off.then((f) => f());
  }, [readOnly]);

  const save = useCallback((next: SidebarOrder) => {
    setOrder(next);
    if (!readOnly) store(next);
  }, [readOnly]);

  // Grouped by project, unknown keys placed by name until they are appended below.
  const sorted = useMemo<Group[]>(() => {
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
  const tree = useMemo(() => layout(sorted, order), [sorted, order]);
  // In the order drawn: folders inside a project come with it.
  const groups = useMemo(() => flatten(tree), [tree]);

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
    if (changed) save({ ...order, projects, agents: agentsOrder });
  }, [groups, order, save, cliReady]);

  /** Moves a top-level item (a folder on its own or a project) onto another's place. */
  const moveTop = useCallback(
    (from: string, to: string) => {
      if (!order || from === to) return;
      const visible = tree.map((n) => (n.kind === "group" ? n.group.key : spaceKey(n.space.id)));
      const a = visible.indexOf(from), b = visible.indexOf(to);
      if (a === -1 || b === -1) return;
      visible.splice(a, 1);
      visible.splice(b, 0, from);
      save({ ...order, projects: reorderVisible(order.projects, visible) });
    },
    [tree, order, save],
  );

  // The person's projects: make, rename, recolor, remove, and move folders in and out.
  // From the latest order, so several changes in a row (make a project, then move into it) compose.
  const change = useCallback((f: (o: SidebarOrder) => SidebarOrder) => {
    setOrder((prev) => {
      if (!prev) return prev;
      const next = f(prev);
      if (!readOnly) store(next);
      return next;
    });
  }, [readOnly]);
  const spaces = useMemo(
    () => ({
      tree,
      suggestions: suggestSpaces(tree, order),
      create: (name: string, keys: string[] = [], at?: string) => {
        const id = Math.random().toString(36).slice(2, 10);
        change((o) => {
          const used = new Set((o.spaces ?? []).map((s) => s.color));
          const color = SPACE_COLORS.find((c) => !used.has(c)) ?? SPACE_COLORS[(o.spaces?.length ?? 0) % SPACE_COLORS.length];
          return addSpace(o, { id, name, color }, keys, at);
        });
        return id;
      },
      update: (id: string, patch: { name?: string; color?: string; icon?: string | null }) => change((o) => updateSpace(o, id, patch)),
      remove: (id: string) => change((o) => removeSpace(o, id)),
      /** A whole group: into a project, or out to the top level (null). */
      place: (key: string, space: string | null, before?: string, agents?: string[]) => change((o) => placeFolder(o, key, space, before, agents)),
      /** Single agents of a folder: into a project, or "" for the top level. */
      placeAgents: (folder: string, agents: string[], space: string) => change((o) => placeAgents(o, folder, agents, space)),
      /** The groups of a project, reordered by hand. */
      arrange: (id: string, visible: string[]) => change((o) => arrangeSpace(o, id, visible)),
      /** Where a whole group belongs ("" for the top level). */
      homeOf: (folder: string) => groupHome(order, folder),
      dismiss: (name: string) => change((o) => ({ ...o, dismissed: [...(o.dismissed ?? []), name.toLowerCase()] })),
    }),
    [tree, order, change],
  );

  const moveAgent = useCallback(
    (slot: string, from: number, to: number) => {
      const g = groups.find((x) => slotOf(x) === slot);
      if (!order || !g || from === to) return;
      const projectKey = g.key;
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
      const placed = { ...(order.placed ?? {}) };
      if (placedKey(key, from) in placed) {
        placed[placedKey(key, to)] = placed[placedKey(key, from)];
        delete placed[placedKey(key, from)];
      }
      save({ ...order, placed, agents: { ...order.agents, [key]: renameEntry(order.agents[key] ?? [], from, to) } });
    },
    [order, save],
  );

  // The person's projects stay; only the arrangement goes back to the default.
  const reset = useCallback(() => order && save({ projects: (order.spaces ?? []).map((s) => spaceKey(s.id)), agents: {}, spaces: order.spaces, placed: order.placed, dismissed: order.dismissed }), [order, save]);

  const flat = useMemo(() => groups.flatMap((g) => g.agents), [groups]);
  return { groups, flat, spaces, moveTop, moveAgent, renameKey, reset, ready: order !== null };
}

/** The person's projects, as the sidebar uses them. */
export type Spaces = ReturnType<typeof useSidebarOrder>["spaces"];
