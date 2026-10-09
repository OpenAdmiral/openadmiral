import { DollarLinearIcon, KeyboardLinearIcon, RoutingLinearIcon, SidebarMinimalisticLinearIcon, GalleryLinearIcon, StructureLinearIcon, PlaylistMinimalisticLinearIcon } from "@solar-icons/react";
import { useEffect, useRef } from "react";
import type { Group } from "@/lib/order";
import { listMenus, type AgentActions } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./StatusIcon";
import type { View } from "./Sidebar";
import { AgentTip, Tip, TipLabel } from "./Tooltip";

type Props = {
  groups: Group[];
  view: View | null;
  onSelect: (v: View) => void;
  onExpand: () => void;
  onShortcuts: () => void;
  openDelegations: number;
  scheduledCount?: number;
  actions: AgentActions;
  onClearEnded: () => void;
  onResetOrder: () => void;
};

/**
 * The sidebar collapsed to a quiet rail: no text, one status dot per agent
 * grouped by project, three nav icons, the expand button at the bottom.
 * Everything else is in the tooltips, which appear at once.
 */
export function Rail({ groups, view, onSelect, onExpand, onShortcuts, openDelegations, scheduledCount = 0, actions, onClearEnded, onResetOrder }: Props) {
  // The same right-click menus as the full sidebar.
  const menus = listMenus(actions, { onClearEnded, onResetOrder });
  const nav: { kind: "agents" | "delegations" | "queue" | "costs" | "artifacts"; icon: typeof RoutingLinearIcon; label: string; kbd: string; badge: boolean }[] = [
    { kind: "agents", icon: StructureLinearIcon, label: "Agents", kbd: "⌘E", badge: false },
    { kind: "delegations", icon: RoutingLinearIcon, label: "Delegations", kbd: "⌘D", badge: openDelegations > 0 },
    { kind: "queue", icon: PlaylistMinimalisticLinearIcon, label: "Up next", kbd: "⌘J", badge: scheduledCount > 0 },
    { kind: "costs", icon: DollarLinearIcon, label: "Costs", kbd: "⌘U", badge: false },
    { kind: "artifacts", icon: GalleryLinearIcon, label: "Artifacts", kbd: "⌘G", badge: false },
  ];
  // ⌘1–9 count agents in the order drawn, as in the full sidebar.
  let n = 0;
  // Moving with the keyboard (⌥↑/⌥↓, ⌘1–9): the selected dot shows its tooltip for a moment.
  const selectedId = view?.kind === "agent" ? view.id : undefined;
  const selectedN = selectedId ? groups.flatMap((g) => g.agents).findIndex((a) => a.id === selectedId) + 1 : 0;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!selectedN) return;
    const show = setTimeout(() => window.dispatchEvent(new CustomEvent("openadmiral:tip", { detail: `rail-agent-${selectedN}` })), 60);
    const hide = setTimeout(() => window.dispatchEvent(new Event("openadmiral:tip-hide")), 1600);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [selectedN]);
  return (
    <aside className="flex h-full w-11 shrink-0 flex-col items-center">
      {/* The traffic lights sit at this height; the main pane's first header makes room for them. */}
      <div data-tauri-drag-region className="h-[52px] w-full shrink-0" />
      <nav className="flex flex-col items-center gap-1">
        {nav.map(({ kind, icon: Icon, label, kbd, badge }) => (
          <Tip key={kind} content={<TipLabel label={label} kbd={kbd} />}>
            <button
              aria-label={label}
              onClick={() => onSelect({ kind })}
              className={cn(
                "relative flex size-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-line hover:text-ink",
                view?.kind === kind && "bg-line-strong text-ink",
              )}
            >
              <Icon size={16} />
              {badge && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand-500" />}
            </button>
          </Tip>
        ))}
      </nav>
      <div className="mt-3 mb-1 h-px w-5 bg-line" />
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto py-1" onContextMenu={menus.empty}>
        {groups.map((g) => (
          <div key={g.key} className="flex flex-col items-center gap-0.5">
            {g.agents.map((a) => {
              const selected = view?.kind === "agent" && view.id === a.id;
              n += 1;
              return (
                <Tip key={a.id} id={`rail-agent-${n}`} content={<AgentTip agent={a} n={n} />}>
                  <button
                    aria-label={a.name}
                    onClick={() => onSelect({ kind: "agent", id: a.id })}
                    onContextMenu={(e) => menus.agent(e, a)}
                    className={cn("flex h-6 w-8 items-center justify-center rounded-full transition-colors hover:bg-line", selected && "bg-line-strong")}
                  >
                    <StatusIcon status={a.status} tip={false} />
                  </button>
                </Tip>
              );
            })}
          </div>
        ))}
      </div>
      <Tip content={<TipLabel label="Keyboard shortcuts" kbd="⌘/" />}>
        <button
          aria-label="Keyboard shortcuts"
          onClick={onShortcuts}
          className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-line hover:text-ink"
        >
          <KeyboardLinearIcon size={16} />
        </button>
      </Tip>
      <Tip content={<TipLabel label="Show the sidebar" kbd="⌘0" />}>
        <button
          aria-label="Show the sidebar"
          onClick={onExpand}
          className="mb-3 flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-line hover:text-ink"
        >
          <SidebarMinimalisticLinearIcon size={16} />
        </button>
      </Tip>
    </aside>
  );
}
