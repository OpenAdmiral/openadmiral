// The chat area split into panes (up to four), each showing one agent. The sidebar and the
// inspector follow the active pane: picking an agent shows it there, or, when another pane
// already shows it, makes that pane the active one.

export type SplitLayout = "1" | "2v" | "2h" | "3l" | "3t" | "4";

export type SplitState = {
  layout: SplitLayout;
  /** Agent ids by pane, null for an empty one; as many as the layout has panes. */
  panes: (string | null)[];
  active: number;
  /** Where the dividers sit: the first split, then the second (0.5 is the middle). */
  ratios?: [number, number];
  /** The multi-pane layout ⌘\ comes back to. */
  last?: SplitLayout;
};

export const PANES: Record<SplitLayout, number> = { "1": 1, "2v": 2, "2h": 2, "3l": 3, "3t": 3, "4": 4 };

export const LAYOUTS: { id: SplitLayout; label: string }[] = [
  { id: "1", label: "One agent" },
  { id: "2v", label: "Two, side by side" },
  { id: "2h", label: "Two, one above the other" },
  { id: "3l", label: "Three: one tall, two stacked" },
  { id: "3t", label: "Three: one wide, two side by side" },
  { id: "4", label: "Four in a grid" },
];

export const SINGLE: SplitState = { layout: "1", panes: [null], active: 0 };

export const clampScale = (x: number) => Math.round(Math.min(1.6, Math.max(0.8, x)) * 10) / 10;

/** The agent picked (sidebar, ⌘K, a jump) goes to the active pane, or focuses the pane that has it. */
export function show(s: SplitState, id: string): SplitState {
  const at = s.panes.indexOf(id);
  if (at !== -1) return at === s.active ? s : { ...s, active: at };
  const panes = [...s.panes];
  panes[s.active] = id;
  return { ...s, panes };
}

/**
 * Another layout: panes kept in order, new ones filled with the agents that come next
 * (`candidates`, in sidebar order, the ones already shown skipped), or left empty.
 */
export function relayout(s: SplitState, layout: SplitLayout, candidates: string[]): SplitState {
  const n = PANES[layout];
  const kept = s.panes.slice(0, n);
  const spare = candidates.filter((c) => !kept.includes(c));
  while (kept.length < n) kept.push(spare.shift() ?? null);
  return { ...s, layout, panes: kept, active: Math.min(s.active, n - 1), last: layout === "1" ? s.last : layout };
}

/** Panes whose agent is gone show the empty picker. */
export const prune = (s: SplitState, alive: Set<string>): SplitState =>
  s.panes.some((p) => p && !alive.has(p)) ? { ...s, panes: s.panes.map((p) => (p && alive.has(p) ? p : null)) } : s;
