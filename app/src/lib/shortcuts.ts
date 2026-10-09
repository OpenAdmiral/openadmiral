/**
 * Every keyboard shortcut, in one table: the Keyboard Shortcuts sheet is drawn from
 * it and the handlers match keys through it, so the two cannot drift apart.
 * `keys` are the chips shown (one shortcut may have alternatives); `match` is how a
 * keydown is recognised (physical keys where ⌥ would change e.key).
 */
export type ShortcutId =
  | "agent-n"
  | "agent-prev"
  | "agent-next"
  | "needs-prev"
  | "needs-next"
  | "new-agent"
  | "close-agent"
  | "view-agents"
  | "view-delegations"
  | "view-costs"
  | "view-artifacts"
  | "view-queue"
  | "tab-terminal"
  | "tab-conversation"
  | "tab-artifacts"
  | "toggle-sidebar"
  | "toggle-inspector"
  | "focus-mode"
  | "shortcuts"
  | "term-option"
  | "term-redraw";

type K = Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey" | "key" | "code">;

export type Shortcut = { id: ShortcutId; keys: string[][]; description: string; match?: (e: K) => boolean };
export type ShortcutGroup = { title: string; items: Shortcut[] };

const arrow = (e: K, dir: "ArrowUp" | "ArrowDown") => e.code === dir && e.altKey && !e.ctrlKey;

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Agents",
    items: [
      { id: "agent-n", keys: [["⌘", "1"], ["…"], ["⌘", "9"]], description: "Go to the agent with that number in the sidebar", match: (e) => e.metaKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key) },
      { id: "agent-prev", keys: [["⌘", "⌥", "↑"]], description: "Previous agent (plain ⌥↑ too, outside the terminal)", match: (e) => arrow(e, "ArrowUp") && !e.shiftKey },
      { id: "agent-next", keys: [["⌘", "⌥", "↓"]], description: "Next agent (plain ⌥↓ too, outside the terminal)", match: (e) => arrow(e, "ArrowDown") && !e.shiftKey },
      { id: "needs-prev", keys: [["⌘", "⌥", "⇧", "↑"]], description: "Previous agent that needs you", match: (e) => arrow(e, "ArrowUp") && e.shiftKey },
      { id: "needs-next", keys: [["⌘", "⌥", "⇧", "↓"]], description: "Next agent that needs you: waiting first, then new artifacts or finished delegations", match: (e) => arrow(e, "ArrowDown") && e.shiftKey },
      { id: "new-agent", keys: [["⌘", "N"]], description: "Start a new agent", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && e.key === "n" },
      { id: "close-agent", keys: [["⌘", "W"]], description: "Close the selected agent (it can be resumed later)", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && e.key === "w" },
    ],
  },
  {
    title: "Views",
    items: [
      { id: "view-agents", keys: [["⌘", "E"]], description: "Agents map: every agent and how they relate", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.code === "KeyE" },
      { id: "view-delegations", keys: [["⌘", "D"]], description: "Delegations between agents", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && e.key === "d" },
      { id: "view-costs", keys: [["⌘", "U"]], description: "Costs and plan usage", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && e.key === "u" },
      { id: "view-artifacts", keys: [["⌘", "G"]], description: "All artifacts", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && e.key === "g" },
      { id: "view-queue", keys: [["⌘", "J"]], description: "Up next: every queued and scheduled prompt, across agents", match: (e) => e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey && e.code === "KeyJ" },
    ],
  },
  {
    title: "Agent tabs",
    items: [
      { id: "tab-terminal", keys: [["⌃", "1"]], description: "Terminal", match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Digit1" },
      { id: "tab-conversation", keys: [["⌃", "2"]], description: "Conversation", match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Digit2" },
      { id: "tab-artifacts", keys: [["⌃", "3"]], description: "Artifacts", match: (e) => e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Digit3" },
    ],
  },
  {
    title: "Panels",
    items: [
      { id: "toggle-sidebar", keys: [["⌘", "0"], ["⌘", "⌃", "S"]], description: "Show or hide the sidebar", match: (e) => e.metaKey && !e.altKey && ((e.code === "Digit0" && !e.shiftKey) || (e.code === "KeyS" && e.ctrlKey)) },
      { id: "toggle-inspector", keys: [["⌘", "⌥", "0"]], description: "Show or hide the inspector (right column)", match: (e) => e.metaKey && e.altKey && e.code === "Digit0" },
      { id: "focus-mode", keys: [["⌘", "⇧", "F"]], description: "Focus mode: hide both panels; again to bring them back", match: (e) => e.metaKey && e.shiftKey && !e.altKey && e.code === "KeyF" },
      { id: "shortcuts", keys: [["⌘", "/"]], description: "This list", match: (e) => e.metaKey && !e.altKey && (e.key === "/" || e.code === "Slash") },
    ],
  },
  {
    title: "Terminal",
    items: [
      { id: "term-option", keys: [["⌥", "2"], ["⌥", "3"], ["⌥", "1"]], description: "Typed as the symbol your keyboard composes (@, #, |, [ ] { } € …); ⌥←/→ and ⌥B/F still move by word" },
      { id: "term-redraw", keys: [["⌃", "L"]], description: "Ask Claude Code to redraw its screen" },
    ],
  },
];

const ALL = SHORTCUTS.flatMap((g) => g.items);

/** The shortcut a keydown is, if any (first match in table order). */
export const matchShortcut = (e: K): ShortcutId | undefined => ALL.find((s) => s.match?.(e))?.id;
