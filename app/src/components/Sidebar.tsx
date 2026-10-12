import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AddLinearIcon, AltArrowDownLinearIcon, DollarLinearIcon, RoutingLinearIcon, SidebarMinimalisticLinearIcon, GalleryLinearIcon, StructureLinearIcon, PlaylistMinimalisticLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "framer-motion";
import { useEffect, useRef, useState, type HTMLAttributes } from "react";
import { money } from "@/lib/costs";
import type { Group } from "@/lib/order";
import { NameEditor } from "./NameEditor";
import { listMenus, type AgentActions } from "@/lib/lifecycle";
import { pending, type QueueEntry } from "@/lib/queue";
import type { AdmiralRequest } from "@/lib/admiral";
import type { Agent, AdmiralDelegation, AdmiralSession } from "@/lib/types";
import { activeOpenCount } from "@/lib/delegations";
import { branchTone, cn, contextUsed, fillText, projectColor, projectLabel } from "@/lib/utils";
import { PlanMeters } from "./PlanMeters";
import { Tip, TipLabel } from "./Tooltip";
import { Info } from "./Info";
import { KIND, Kbd, Meter } from "./primitives";
import { StatusIcon } from "./StatusIcon";

export type View = { kind: "agent"; id: string } | { kind: "agents" } | { kind: "delegations" } | { kind: "costs" } | { kind: "artifacts" } | { kind: "queue" };

type Props = {
  groups: Group[];
  delegations: AdmiralDelegation[];
  rateLimits: NonNullable<AdmiralSession["rateLimits"]>;
  view: View | null;
  todayCost?: number;
  onSelect: (v: View) => void;
  onNew: () => void;
  onMoveProject: (from: number, to: number) => void;
  onMoveAgent: (projectKey: string, from: number, to: number) => void;
  onResetOrder: () => void;
  actions: AgentActions;
  onClearEnded: () => void;
  queues: Record<string, QueueEntry>;
  unseen: Record<string, number>;
  artifactCount: number;
  requests: Record<string, AdmiralRequest>;
  onCollapse: () => void;
  onShortcuts: () => void;
  /** Scheduled Up next items across agents (the nav badge). */
  scheduledCount?: number;
  /** A newer version of OpenAdmiral, offered by the updater. */
  update?: { version: string; installing: boolean; install: () => void };
  /** Running sessions on an older OpenAdmiral plugin than the installed one. */
  pluginBehind?: { count: number; reload: () => void };
  /** Sessions found running without the plugin, and whether it is installed at all. */
  unplugged?: { installed: boolean; count: number; open: () => void };
  /** The agent whose name is being edited in its row, and what to do with the result. */
  renaming?: { id: string; save: (a: Agent, name: string) => void; cancel: () => void };
};

// Sortable ids: projects and agents share one DndContext, told apart by prefix.
const pid = (key: string) => `p:${key}`;
const aid = (projectKey: string, agentId: string) => `a:${projectKey}\u0000${agentId}`;
const parseAid = (id: string) => {
  const [projectKey, agentId] = id.slice(2).split("\u0000");
  return { projectKey, agentId };
};

/** A project only meets other projects; an agent only the agents of its own project. */
const collision: CollisionDetection = (args) => {
  const id = String(args.active.id);
  const project = id.startsWith("a:") ? parseAid(id).projectKey : null;
  const droppableContainers = args.droppableContainers.filter((c) => {
    const cid = String(c.id);
    return project === null ? cid.startsWith("p:") : cid.startsWith("a:") && parseAid(cid).projectKey === project;
  });
  return closestCenter({ ...args, droppableContainers });
};

export function Sidebar({ groups, delegations, rateLimits, view, todayCost, onSelect, onNew, onMoveProject, onMoveAgent, onResetOrder, actions, onClearEnded, queues, unseen, artifactCount, requests, onCollapse, onShortcuts, renaming, scheduledCount = 0, update,
  pluginBehind,
  unplugged }: Props) {
  const newArtifacts = Object.values(unseen).reduce((n, x) => n + x, 0);
  // Stale ones (agents gone, quiet for a day) do not count: nobody is waiting on them.
  const openDelegations = activeOpenCount(delegations, groups.flatMap((g) => g.agents), Date.now());
  const [active, setActive] = useState<string | null>(null);
  const [folded, toggleFolded] = useFolded();

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still selects.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space picks up and drops, arrows move, Esc cancels; Enter stays a click.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Esc], end: [KeyboardCode.Space] },
    }),
  );

  const onDragStart = (e: DragStartEvent) => setActive(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActive(null);
    const from = String(e.active.id);
    const to = e.over ? String(e.over.id) : null;
    if (!to || from === to) return;
    if (from.startsWith("p:")) {
      // A project dropped on one of another project's agents counts as that project.
      const target = to.startsWith("a:") ? pid(parseAid(to).projectKey) : to;
      const ids = groups.map((g) => pid(g.key));
      const a = ids.indexOf(from), b = ids.indexOf(target);
      if (a !== -1 && b !== -1) onMoveProject(a, b);
      return;
    }
    // Agents stay inside their project.
    if (!to.startsWith("a:")) return;
    const src = parseAid(from), dst = parseAid(to);
    if (src.projectKey !== dst.projectKey) return;
    const g = groups.find((x) => x.key === src.projectKey);
    if (!g) return;
    const a = g.agents.findIndex((x) => x.id === src.agentId), b = g.agents.findIndex((x) => x.id === dst.agentId);
    if (a !== -1 && b !== -1) onMoveAgent(g.key, a, b);
  };

  const menus = listMenus(actions, { onClearEnded, onResetOrder });

  // ⌘1–9 count agents in the order drawn.
  const numbers = new Map<string, number>();
  groups.flatMap((g) => g.agents).forEach((a, i) => numbers.set(a.id, i + 1));
  const activeGroup = active?.startsWith("p:") ? groups.find((g) => pid(g.key) === active) : undefined;
  const activeAgent = active?.startsWith("a:") ? groups.flatMap((g) => g.agents).find((a) => a.id === parseAid(active).agentId) : undefined;

  return (
    <aside className="flex h-full w-[272px] shrink-0 flex-col">
      {/* Title bar: the traffic lights sit at the left of this strip. */}
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-end gap-1 pr-3 pl-20">
        <Tip side="bottom" content={<TipLabel label="Hide the sidebar" kbd="⌘0" />}>
          <button
            onClick={onCollapse}
            aria-label="Hide the sidebar"
            className="inline-flex size-7 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line-strong hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <SidebarMinimalisticLinearIcon size={17} />
          </button>
        </Tip>
        <Tip side="bottom" content={<TipLabel label="New agent" kbd="⌘N" />}>
          <button
            onClick={onNew}
            aria-label="New agent"
            className="inline-flex size-7 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line-strong hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <AddLinearIcon size={18} />
          </button>
        </Tip>
      </div>

      <nav className="px-3">
        <NavItem active={view?.kind === "agents"} onClick={() => onSelect({ kind: "agents" })} icon={StructureLinearIcon} label="Agents" kbd="⌘E" />
        <NavItem active={view?.kind === "delegations"} onClick={() => onSelect({ kind: "delegations" })} icon={RoutingLinearIcon} label="Delegations" kbd="⌘D">
          {openDelegations > 0 && (
            <span className="rounded-full bg-brand-600 px-1.5 text-[10px] font-semibold leading-4 text-white tabular">{openDelegations}</span>
          )}
        </NavItem>
        <NavItem active={view?.kind === "queue"} onClick={() => onSelect({ kind: "queue" })} icon={PlaylistMinimalisticLinearIcon} label="Up next" kbd="⌘J">
          {scheduledCount > 0 && (
            <span title={`${scheduledCount} scheduled`} className="rounded-full bg-brand-500/15 px-1.5 text-[10px] font-semibold leading-4 text-brand-700 tabular dark:text-brand-300">
              {scheduledCount}
            </span>
          )}
        </NavItem>
        <NavItem active={view?.kind === "costs"} onClick={() => onSelect({ kind: "costs" })} icon={DollarLinearIcon} label="Costs" kbd="⌘U" />
        <NavItem active={view?.kind === "artifacts"} onClick={() => onSelect({ kind: "artifacts" })} icon={GalleryLinearIcon} label="Artifacts" kbd="⌘G">
          {newArtifacts > 0 ? (
            <span title={`${newArtifacts} new artifact${newArtifacts > 1 ? "s" : ""}`} className="rounded-full bg-brand-500/15 px-1.5 text-[10px] font-semibold leading-4 whitespace-nowrap text-brand-700 tabular dark:text-brand-300">
              {newArtifacts} new
            </span>
          ) : (
            artifactCount > 0 && <span className="text-[11px] text-ink-3 tabular">{artifactCount}</span>
          )}
        </NavItem>
      </nav>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-4" onContextMenu={menus.empty}>
        {groups.length === 0 && (
          <div className="mx-1 mt-6 rounded-xl border border-dashed border-line-strong p-4 text-center text-xs leading-relaxed text-ink-3">
            No agents yet. Start one with <span className="font-semibold text-ink-2">+</span>, or open Claude Code with the OpenAdmiral plugin.
          </div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActive(null)}
          autoScroll={{ threshold: { x: 0, y: 0.15 }, acceleration: 8 }}
        >
          <SortableContext items={groups.map((g) => pid(g.key))} strategy={verticalListSortingStrategy}>
            {groups.map((g) => (
              <SortableGroup key={g.key} group={g} folded={folded.has(g.key)} onFold={() => toggleFolded(g.key)}>
                <SortableContext items={g.agents.map((a) => aid(g.key, a.id))} strategy={verticalListSortingStrategy}>
                  {g.agents.map((a) => (
                    <SortableAgent
                      key={a.id}
                      id={aid(g.key, a.id)}
                      agent={a}
                      n={numbers.get(a.id)!}
                      queued={pending(queues[a.id]).length}
                      request={a.cli ? requests[a.id] : undefined}
                      selected={view?.kind === "agent" && view.id === a.id}
                      onSelect={() => onSelect({ kind: "agent", id: a.id })}
                      onMenu={(e) => menus.agent(e, a)}
                      editor={
                        renaming?.id === a.id ? (
                          <NameEditor value={a.name} onSave={(name) => renaming.save(a, name)} onCancel={renaming.cancel} className="text-sm" />
                        ) : undefined
                      }
                    />
                  ))}
                </SortableContext>
              </SortableGroup>
            ))}
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
            {activeGroup ? (
              <div className="rounded-xl bg-canvas/95 px-1 py-1 shadow-xl ring-1 ring-line-strong backdrop-blur dark:bg-[#1d2026]/95">
                <GroupHeader group={activeGroup} lifted />
                {activeGroup.agents.map((a) => (
                  <AgentRow key={a.id} agent={a} n={numbers.get(a.id)!} />
                ))}
              </div>
            ) : activeAgent ? (
              <div className="rounded-lg bg-canvas shadow-xl ring-1 ring-line-strong dark:bg-[#1d2026]">
                <AgentRow agent={activeAgent} n={numbers.get(activeAgent.id)!} lifted />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <footer className="shrink-0 border-t border-line px-5 pt-3.5 pb-2.5">
        {unplugged && unplugged.count > 0 && (
          <div className="mb-3 rounded-lg bg-brand-500/10 px-3 py-2 text-xs ring-1 ring-brand-500/25">
            <div className="font-semibold text-ink">
              {unplugged.count === 1 ? "1 session isn't" : `${unplugged.count} sessions aren't`} connected to OpenAdmiral
            </div>
            <div className="mt-0.5 text-ink-3">{unplugged.installed ? "They need /reload-plugins." : "They need the OpenAdmiral plugin."}</div>
            <button onClick={unplugged.open} className="mt-1 font-semibold text-brand-700 hover:underline dark:text-brand-300">
              How to connect
            </button>
          </div>
        )}
        {pluginBehind && pluginBehind.count > 0 && (
          <div className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs ring-1 ring-amber-500/25">
            <div className="font-semibold text-ink">
              {pluginBehind.count === 1 ? "1 session runs" : `${pluginBehind.count} sessions run`} an older OpenAdmiral plugin
            </div>
            <button onClick={pluginBehind.reload} className="mt-1 font-semibold text-amber-700 hover:underline dark:text-amber-300">
              Reload {pluginBehind.count === 1 ? "it" : "all"}
            </button>
          </div>
        )}
        {update && (
          <div className="mb-3 rounded-lg bg-brand-500/12 px-3 py-2 text-xs ring-1 ring-brand-500/25">
            <div className="font-semibold text-ink">OpenAdmiral {update.version} is available</div>
            <div className="mt-1 flex items-center gap-3">
              <button onClick={update.install} disabled={update.installing} className="font-semibold text-brand-700 hover:underline disabled:opacity-70 dark:text-brand-300">
                {update.installing ? "Installing…" : "Install & restart"}
              </button>
              <button onClick={() => void openUrl("https://openadmiral.com/releases")} className="text-ink-3 hover:text-ink hover:underline">
                What's new
              </button>
            </div>
          </div>
        )}
        {todayCost !== undefined && (
          <button onClick={() => onSelect({ kind: "costs" })} title="API-equivalent cost today" className="mb-3 flex w-full items-baseline justify-between text-left">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Today</span>
            <span className="text-sm font-semibold text-ink tabular">
              {money(todayCost)} <span className="text-[10px] font-normal text-ink-3">API eq.</span>
              <Info tip="What this usage would cost at Anthropic API prices; on the Max plan you don't pay it." align="right" className="ml-1" />
            </span>
          </button>
        )}
        {rateLimits.length > 0 && (
          <>
            <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              Plan usage <Info id="plan-usage" tip="How much of your Max plan's 5-hour and weekly limits you have used; each resets at the time shown." align="left" />
            </div>
            <PlanMeters limits={rateLimits} />
          </>
        )}
        <div className={cn("flex items-center gap-3 text-[11px] text-ink-3", rateLimits.length > 0 && "mt-3")}>
          <button onClick={onShortcuts} className="flex items-center gap-1.5 rounded-md transition-colors hover:text-ink">
            <Kbd>⌘/</Kbd> Shortcuts
          </button>
          <span className="flex-1" />
          {/* A new GitHub issue from the repo's form, type preset, versions filled in. */}
          <button onClick={() => void invoke("open_issue", { kind: "feedback" })} title="Share an idea or feedback (opens GitHub)" className="transition-colors hover:text-ink">
            Feedback
          </button>
          <button onClick={() => void invoke("open_issue", { kind: "bug" })} title="Report a bug (opens GitHub)" className="transition-colors hover:text-ink">
            Report a bug
          </button>
        </div>
      </footer>
    </aside>
  );
}

function NavItem({ active, onClick, icon: Icon, label, kbd, children }: { active: boolean; onClick: () => void; icon: typeof RoutingLinearIcon; label: string; kbd: string; children?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink-2 transition-all duration-200 hover:bg-line", active && "bg-line-strong text-ink")}
    >
      <Icon size={16} className={cn(active ? "text-brand-600 dark:text-brand-400" : "text-ink-3")} />
      <span className="flex-1 text-left">{label}</span>
      {children}
      <Kbd>{kbd}</Kbd>
    </button>
  );
}

/** Where the dragged item will land: a dashed slot in brand color. */
const DROP_SLOT = "rounded-lg outline-2 outline-dashed -outline-offset-2 outline-brand-500/60 bg-brand-500/[0.06] [&>*]:opacity-0";

/** Folded projects, remembered across launches (this webview's storage). */
const FOLDED = "openadmiral.sidebar.folded";
function useFolded(): [Set<string>, (key: string) => void] {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLDED) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      try {
        localStorage.setItem(FOLDED, JSON.stringify([...next]));
      } catch {
        // Not remembered; the fold still applies now.
      }
      return next;
    });
  return [folded, toggle];
}

/** A project: its header, then its agents indented behind a rail in the project's color. */
function SortableGroup({ group, folded, onFold, children }: { group: Group; folded: boolean; onFold: () => void; children: React.ReactNode }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: pid(group.key) });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("mt-2 border-t border-line pt-2 first:mt-0 first:border-t-0 first:pt-0", isDragging && DROP_SLOT)}
    >
      <GroupHeader group={group} folded={folded} onFold={onFold} handle={{ ref: setActivatorNodeRef, ...attributes, ...listeners }} />
      {!folded && (
        <div className="ml-[13px] border-l-2 pl-1.5" style={{ borderColor: `color-mix(in srgb, ${projectColor(group.label)} 45%, transparent)` }}>
          {children}
        </div>
      )}
    </section>
  );
}

function GroupHeader({ group, folded, onFold, handle, lifted }: { group: Group; folded?: boolean; onFold?: () => void; handle?: HTMLAttributes<HTMLDivElement> & { ref?: (el: HTMLElement | null) => void }; lifted?: boolean }) {
  const { ref, ...rest } = handle ?? {};
  // Folded away, an agent waiting on you still shows on its project.
  const waiting = folded && group.agents.some((a) => a.status === "waiting");
  return (
    <div
      ref={ref}
      {...rest}
      aria-label={`${group.label} project. Press space to reorder.`}
      className={cn(
        "mb-1 flex items-center gap-2 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        handle && "cursor-grab active:cursor-grabbing",
        lifted && "cursor-grabbing",
      )}
    >
      {onFold ? (
        <button
          type="button"
          onClick={onFold}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={folded ? `Show ${group.label}'s agents` : `Hide ${group.label}'s agents`}
          aria-expanded={!folded}
          className="-m-1 rounded p-1 text-ink-3 transition-colors hover:text-ink"
        >
          <AltArrowDownLinearIcon size={12} className={cn("transition-transform duration-150", folded && "-rotate-90")} />
        </button>
      ) : (
        <span className="w-2.5" />
      )}
      <span className="size-2 shrink-0 rounded-full" style={{ background: projectColor(group.label) }} />
      <h3 className="truncate text-[13px] font-semibold text-ink">{projectLabel(group.label)}</h3>
      {waiting && <span title="An agent here needs you" className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
      <span className="ml-auto rounded-full bg-line px-1.5 text-[10px] leading-4 text-ink-3 tabular">{group.agents.length}</span>
    </div>
  );
}

function SortableAgent({ id, agent, n, queued, request, selected, onSelect, onMenu, editor }: { id: string; agent: Agent; n: number; queued: number; request?: AdmiralRequest; selected: boolean; onSelect: () => void; onMenu: (e: React.MouseEvent) => void; editor?: React.ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id });
  // Selected from the keyboard (⌥↑/⌥↓, ⌘1–9): bring the row into view.
  const row = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        row.current = el;
      }}
      onContextMenu={onMenu} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn("mb-0.5", isDragging && DROP_SLOT)}>
      {editor ? (
        // Not the row's button: its drag handle and Enter/Space would take the keys.
        <div className="flex items-center gap-2.5 rounded-lg bg-canvas px-2.5 py-2 ring-1 ring-line-strong dark:bg-white/[0.07]">
          <StatusIcon status={agent.status} />
          {editor}
        </div>
      ) : (
        <AgentRow agent={agent} n={n} queued={queued} request={request} selected={selected} onSelect={onSelect} handle={{ ...attributes, ...listeners }} />
      )}
    </div>
  );
}

function AgentRow({ agent: a, n, queued = 0, request, selected, onSelect, handle, lifted }: { agent: Agent; n: number; queued?: number; request?: AdmiralRequest; selected?: boolean; onSelect?: () => void; handle?: HTMLAttributes<HTMLButtonElement>; lifted?: boolean }) {
  const ctx = contextUsed(a.session?.context);
  return (
    <button
      {...handle}
      onClick={onSelect}
      title={
        a.unplugged
          ? `${a.name} · in ${a.unplugged.via}, not connected: it needs the OpenAdmiral plugin`
          : a.cli
            ? `${a.name} · ${KIND[a.attachable ? "openadmiral" : "terminal"].label}: ${KIND[a.attachable ? "openadmiral" : "terminal"].hint}`
            : `${a.name} · not running`
      }
      className={cn(
        "relative flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-200 hover:bg-line focus-visible:ring-2 focus-visible:ring-brand-500",
        a.status === "ended" && !lifted && "opacity-70 dark:opacity-55",
        lifted && "cursor-grabbing hover:bg-transparent",
      )}
    >
      {selected && (
        <motion.span
          layoutId="sidebar-selection"
          className="absolute inset-0 rounded-lg bg-canvas shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_12px_rgb(0_0_0/0.06)] ring-1 ring-line-strong dark:bg-white/[0.07] dark:shadow-sm dark:ring-line"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      )}
      <span className="relative flex items-center gap-2.5">
        <StatusIcon status={a.status} />
        <span className="flex-1 truncate text-sm font-semibold text-ink">{a.name}</span>
        {queued > 0 && (
          <span title={`${queued} queued prompt${queued > 1 ? "s" : ""}`} className="rounded-full bg-brand-500/15 px-1.5 text-[10px] font-semibold leading-4 text-brand-700 tabular dark:text-brand-300">
            +{queued}
          </span>
        )}
        {a.status === "waiting" ? (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300">needs you</span>
        ) : n <= 9 ? (
          <span className="ml-1 text-[10px] text-ink-3/70 tabular">⌘{n}</span>
        ) : null}
      </span>
      {request && !request.servedAt && (
        <span className="relative truncate pl-[18px] text-[10.5px] text-amber-700 dark:text-amber-300">
          {request.action === "handoff" ? "Moving into OpenAdmiral" : "Closing"}
          {request.waiting ? ` · waiting: ${request.waiting}` : "…"}
        </span>
      )}
      <span className="relative flex items-center gap-2 pl-[18px] text-xs text-ink-3">
        <span className={cn("truncate font-mono text-[11px]", branchTone(a.session?.branch))}>{a.session?.branch ?? (a.unplugged ? `in ${a.unplugged.via}` : a.cli ? KIND[a.attachable ? "openadmiral" : "terminal"].label : "ended")}</span>
        {!!a.session?.dirty && <span className="text-amber-600 dark:text-amber-400 tabular">±{a.session.dirty}</span>}
        <span className="flex-1" />
        {ctx !== undefined && (
          <span className="flex w-14 items-center gap-1.5">
            <Meter value={ctx} className="flex-1" />
            <span className={cn("w-6 text-right text-[10px] tabular", fillText(ctx))}>{Math.round(ctx)}%</span>
          </span>
        )}
      </span>
    </button>
  );
}
