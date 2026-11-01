import { DollarLinearIcon, KeyboardLinearIcon, SidebarMinimalisticLinearIcon, GalleryLinearIcon, StructureLinearIcon, PlaylistMinimalisticLinearIcon } from "@solar-icons/react";
import { useEffect, useRef } from "react";
import { slotOf, spaceKey, type Group, type Node as TreeNode } from "@/lib/order";
import { popupMenu } from "@/lib/menu";
import type { FloatableView } from "./FloatingView";
import { SpaceTile, useFolded } from "./Sidebar";
import { listMenus, type AgentActions } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./StatusIcon";
import type { View } from "./Sidebar";
import { AgentTip, Tip, TipLabel } from "./Tooltip";

type Props = {
  groups: Group[];
  /** The agents by project, as the sidebar has them (none in Recent: a flat list). */
  tree?: TreeNode[];
  onFloatView: (view: FloatableView) => void;
  view: View | null;
  onSelect: (v: View) => void;
  onExpand: () => void;
  onShortcuts: () => void;
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
export function Rail({ groups, tree, onFloatView, view, onSelect, onExpand, onShortcuts, scheduledCount = 0, actions, onClearEnded, onResetOrder }: Props) {
  // The same right-click menus as the full sidebar.
  const menus = listMenus(actions, { onClearEnded, onResetOrder });
  const nav: { kind: "agents" | "queue" | "costs" | "artifacts"; icon: typeof StructureLinearIcon; label: string; kbd: string; badge: boolean }[] = [
    { kind: "agents", icon: StructureLinearIcon, label: "Agents", kbd: "⌘E", badge: false },
    { kind: "queue", icon: PlaylistMinimalisticLinearIcon, label: "Up next", kbd: "⌘J", badge: scheduledCount > 0 },
    { kind: "costs", icon: DollarLinearIcon, label: "Costs", kbd: "⌘U", badge: false },
    { kind: "artifacts", icon: GalleryLinearIcon, label: "Artifacts", kbd: "⌘G", badge: false },
  ];
  // ⌘1–9 count agents in the order drawn, as in the full sidebar.
  let n = 0;
  const [folded, toggleFolded] = useFolded();
  const nodes: TreeNode[] = (tree ?? groups.map((group): TreeNode => ({ kind: "group", group }))).filter((x) => x.kind === "group" || x.groups.length > 0);
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
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void popupMenu([{ id: `rail:float:${kind}`, text: `Open ${label} in Its Own Window`, action: () => onFloatView(kind) }]);
              }}
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
        {nodes.map((node, i) => {
          const list = node.kind === "group" ? [node.group] : node.groups;
          const all = list.flatMap((g) => g.agents);
          const foldKey = node.kind === "space" ? spaceKey(node.space.id) : undefined;
          const isFolded = !!foldKey && folded.has(foldKey);
          // Folded agents keep their ⌘ numbers, as in the full sidebar.
          if (isFolded) n += all.length;
          return (
            <div key={foldKey ?? slotOf(list[0])} className="flex w-full flex-col items-center gap-1">
              {i > 0 && <div className="my-0.5 h-px w-5 shrink-0 bg-line" />}
              {node.kind === "space" && (
                <Tip content={<TipLabel label={`${node.space.name} · ${isFolded ? "show" : "hide"} its ${all.length} agent${all.length === 1 ? "" : "s"}`} />}>
                  <button
                    aria-label={node.space.name}
                    aria-expanded={!isFolded}
                    onClick={() => toggleFolded(foldKey!)}
                    className={cn("relative rounded-[7px] transition-transform hover:scale-105", isFolded && all.some((a) => view?.kind === "agent" && view.id === a.id) && "ring-2 ring-brand-500")}
                  >
                    <SpaceTile space={node.space} />
                    {isFolded && all.some((a) => a.status === "waiting") && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-amber-500 ring-2 ring-sidebar" />}
                  </button>
                </Tip>
              )}
              {!isFolded &&
                all.map((a) => {
                  const selected = view?.kind === "agent" && view.id === a.id;
                  n += 1;
                  return (
                    <Tip key={a.id} id={`rail-agent-${n}`} content={<AgentTip agent={a} n={n} />}>
                      <button
                        aria-label={a.name}
                        onClick={() => onSelect({ kind: "agent", id: a.id })}
                        onContextMenu={(e) => menus.agent(e, a)}
                        className={cn("flex h-6 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-line", selected && "bg-line-strong")}
                      >
                        <StatusIcon status={a.status} tip={false} />
                      </button>
                    </Tip>
                  );
                })}
            </div>
          );
        })}
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
