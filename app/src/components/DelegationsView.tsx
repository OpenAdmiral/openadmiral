import { ArrowRightLinearIcon, LinkLinearIcon, RoutingLinearIcon } from "@solar-icons/react";
import { motion } from "framer-motion";
import { useMemo, useRef, useState, useLayoutEffect } from "react";
import type { Agent, DelegationStatus, AdmiralDelegation } from "@/lib/types";
import { ago, cn, projectColor, projectLabel } from "@/lib/utils";
import { DELEGATION_STROKE, DelegationPill } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { Info } from "./Info";
import { emptyQueue, newItemId, saveQueue, type QueueEntry } from "@/lib/queue";
import { closeDelegation, findEnd, isActive, isOpen, staleReason } from "@/lib/delegations";
import { ActionMenu, type ActionItem } from "./ActionMenu";

type Props = {
  delegations: AdmiralDelegation[];
  agents: Agent[];
  now: number;
  onJump: (agentId: string) => void;
  queues: Record<string, QueueEntry>;
};

const COLUMNS: { title: string; statuses: DelegationStatus[] }[] = [
  { title: "Open", statuses: ["draft", "sent", "accepted"] },
  { title: "In progress", statuses: ["in_progress"] },
  { title: "Blocked", statuses: ["blocked"] },
  { title: "Done", statuses: ["done", "cancelled"] },
];

function toProject(d: AdmiralDelegation) {
  return d.to.project ?? d.to.address;
}

export function DelegationsView({ delegations, agents, now, onJump, queues }: Props) {
  const byId = useMemo(() => new Map(delegations.map((d) => [d.id, d])), [delegations]);

  const findAgent = (sessionId: string | undefined, label: string) => findEnd(agents, sessionId, label);
  // Active: what is still moving (and what closed today). All: everything, stale ones marked.
  const [scope, setScope] = useState<"active" | "all">("active");
  const stale = delegations.filter((d) => staleReason(d, agents, now));
  const activeOpen = delegations.filter((d) => isOpen(d) && !staleReason(d, agents, now)).length;
  const shown = scope === "active" ? delegations.filter((d) => isActive(d, agents, now)) : delegations;
  const cancelStale = () => stale.forEach((d) => void closeDelegation(d.id, "cancelled", `closed in OpenAdmiral: ${staleReason(d, agents, now)}`));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 px-6 pt-3.5 pb-4">
        <RoutingLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Delegations</h1>
        <Info tip="Work one agent handed to another: draft (not delivered yet) → sent → accepted → in progress → done, or blocked / cancelled. Hover a status for more." align="left" />
        <span className="text-sm text-ink-3 tabular">
          {activeOpen} active{stale.length > 0 && ` · ${stale.length} stale`} · {delegations.length} total
        </span>
        <div className="ml-auto flex rounded-lg bg-line p-0.5 text-xs">
          {(["active", "all"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setScope(k)}
              className={cn("rounded-md px-2.5 py-1 font-medium capitalize", scope === k ? "bg-canvas text-ink shadow-sm" : "text-ink-3 hover:text-ink-2")}
            >
              {k}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {delegations.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <RoutingLinearIcon size={32} className="mb-3 text-ink-3" />
            <p className="text-sm font-semibold text-ink">No delegations yet</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
              When an agent hands work to another with the OpenAdmiral <code className="font-mono">delegate</code> tool, it shows up here with its status and
              dependencies.
            </p>
          </div>
        ) : (
          <>
            {scope === "active" && stale.length > 0 && (
              <div className="mb-3 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-3.5 py-2.5 text-xs text-ink-2">
                <span className="flex-1">
                  <span className="font-semibold text-ink">
                    {stale.length} stale {stale.length === 1 ? "delegation" : "delegations"} hidden
                  </span>{" "}
                  · the agent they wait on isn't running, or nothing moved for a day.
                </span>
                <button onClick={() => setScope("all")} className="rounded-md px-2 py-1 font-semibold text-ink-2 hover:bg-line">Show</button>
                <button onClick={cancelStale} className="rounded-md bg-canvas px-2.5 py-1 font-semibold text-ink shadow-sm hover:bg-line">
                  Cancel {stale.length === 1 ? "it" : "all"}
                </button>
              </div>
            )}
            {shown.length === 0 && (
              <p className="mt-10 text-center text-sm text-ink-3">Nothing in flight right now.</p>
            )}
            <DelegationMap delegations={shown} agents={agents} onJump={(label, id) => { const a = findAgent(id, label); if (a) onJump(a.id); }} />
            <div className="mt-5 grid grid-cols-4 gap-3">
              {COLUMNS.map((col) => {
                const items = shown.filter((d) => col.statuses.includes(d.status));
                return (
                  <section key={col.title} className="min-w-0">
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{col.title}</h3>
                      <span className="text-[11px] text-ink-3 tabular">{items.length}</span>
                    </div>
                    <div className="space-y-2">
                      {items.map((d) => {
                        const fromAgent = findAgent(d.from.sessionId, d.from.project);
                        const toAgent = findAgent(d.to.sessionId, toProject(d));
                        const lastNote = d.notes.at(-1);
                        const staleWhy = staleReason(d, agents, now);
                        return (
                          <motion.article
                            layout
                            key={d.id}
                            className={cn(
                              "relative rounded-xl border border-line bg-canvas p-3 shadow-sm transition-shadow duration-200 hover:shadow-md focus-within:z-20",
                              staleWhy && "border-dashed opacity-75",
                            )}
                          >
                            {staleWhy && (
                              <div className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">Stale · {staleWhy}</div>
                            )}
                            <div className="mb-1.5 flex items-start justify-between gap-2">
                              {/* min-w-0 + break-words: a long identifier in the title wraps instead of pushing the pill out. */}
                              <h4 className="min-w-0 text-sm leading-snug font-semibold break-words text-ink">{d.title}</h4>
                              <DelegationPill status={d.status} className="shrink-0" />
                            </div>
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-ink-2">
                              <AgentLink label={d.from.name ?? projectLabel(d.from.project)} project={d.from.project} agent={fromAgent} onJump={onJump} />
                              <ArrowRightLinearIcon size={12} className="text-ink-3" />
                              <AgentLink label={d.to.address} project={toProject(d)} agent={toAgent} onJump={onJump} />
                            </div>
                            {!!d.dependsOn?.length && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {d.dependsOn.map((id) => {
                                  const dep = byId.get(id);
                                  return (
                                    <span
                                      key={id}
                                      className={cn(
                                        "inline-flex max-w-full items-center gap-1 rounded-md bg-line px-1.5 py-0.5 text-[11px] text-ink-2",
                                        dep?.status === "done" && "text-ink-3 line-through",
                                      )}
                                    >
                                      <LinkLinearIcon size={11} className="shrink-0" />
                                      <span className="truncate">{dep?.title ?? id}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            {(d.result || lastNote) && (
                              <p className="selectable mt-2 line-clamp-3 border-t border-line pt-2 text-xs leading-relaxed text-ink-3">
                                {d.result ?? lastNote?.text}
                              </p>
                            )}
                            <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3 tabular">
                              <span>updated {ago(d.updatedAt, now)} ago</span>
                              {isOpen(d) && (
                                <span className="flex items-center gap-1.5">
                                  <ThenTell delegation={d} agents={agents} queues={queues} />
                                  <CloseMenu delegation={d} />
                                </span>
                              )}
                            </div>
                          </motion.article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** An end of a delegation by agent name, as the sidebar shows it; the project in its tooltip. */
function AgentLink({ label, project, agent, onJump }: { label: string; project: string; agent?: Agent; onJump: (id: string) => void }) {
  return (
    <button
      disabled={!agent}
      title={projectLabel(project)}
      onClick={() => agent && onJump(agent.id)}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5 rounded px-0.5", agent && "hover:text-brand-600 dark:hover:text-brand-400")}
    >
      {agent && <StatusIcon status={agent.status} size={12} />}
      <span className="truncate font-semibold">{agent?.name ?? label}</span>
    </button>
  );
}

/** Agents as nodes on a line (grouped by project), delegations as arcs: above for left→right, below for right→left. */
function DelegationMap({ delegations, agents, onJump }: { delegations: AdmiralDelegation[]; agents: Agent[]; onJump: (label: string, sessionId?: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  // The agents at either end, as the sidebar names them; one that is not running keeps the name the delegation carries.
  const ends = useMemo(() => {
    const endOf = (agent: Agent | undefined, fallbackKey: string, name: string, project: string) => ({
      key: agent?.id ?? fallbackKey,
      name: agent?.name ?? name,
      project: agent?.project ?? project,
      agent,
    });
    return delegations.map((d) => ({
      d,
      from: endOf(findEnd(agents, d.from.sessionId, d.from.project), `from:${d.from.project}`, d.from.name ?? projectLabel(d.from.project), d.from.project),
      to: endOf(findEnd(agents, d.to.sessionId, d.to.address), `to:${d.to.address}`, d.to.address, toProject(d)),
    }));
  }, [delegations, agents]);

  // Agents grouped by project, so a project's color reads as one stretch of the line.
  const nodes = useMemo(() => {
    const byKey = new Map<string, (typeof ends)[number]["from"]>();
    for (const e of ends) {
      byKey.set(e.from.key, e.from);
      byKey.set(e.to.key, e.to);
    }
    return [...byKey.values()].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  }, [ends]);

  // One arc per ordered pair, colored by its most urgent open delegation.
  const edges = useMemo(() => {
    const rank: Record<DelegationStatus, number> = { blocked: 0, in_progress: 1, accepted: 2, sent: 3, draft: 4, done: 5, cancelled: 6 };
    const pairs = new Map<string, { from: string; to: string; count: number; status: DelegationStatus }>();
    for (const { d, from, to } of ends) {
      const key = `${from.key}→${to.key}`;
      const p = pairs.get(key);
      if (!p) pairs.set(key, { from: from.key, to: to.key, count: 1, status: d.status });
      else {
        p.count++;
        if (rank[d.status] < rank[p.status]) p.status = d.status;
      }
    }
    return [...pairs.values()];
  }, [ends]);

  const H = 210;
  const mid = H / 2;
  const pad = 110;
  const x = (i: number) => (nodes.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (nodes.length - 1));
  const idx = new Map(nodes.map((n, i) => [n.key, i]));

  return (
    <div ref={ref} className="relative overflow-hidden rounded-2xl border border-line bg-canvas shadow-sm" style={{ height: H }}>
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
      />
      <svg className="absolute inset-0" width={width} height={H}>
        <defs>
          {Object.entries(DELEGATION_STROKE).map(([k, c]) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const a = idx.get(e.from)!;
          const b = idx.get(e.to)!;
          if (a === b) return null;
          const x1 = x(a), x2 = x(b);
          const forward = x2 > x1;
          const lift = Math.min(78, 34 + Math.abs(x2 - x1) * 0.12);
          const y = forward ? mid - 18 : mid + 18;
          const cy = forward ? y - lift : y + lift;
          const inset = 58;
          const sx = x1 + (forward ? inset : -inset), ex = x2 + (forward ? -inset : inset);
          const d = `M ${sx} ${y} Q ${(sx + ex) / 2} ${cy} ${ex} ${y}`;
          const live = e.status === "in_progress";
          return (
            <g key={`${e.from}-${e.to}`}>
              <path d={d} fill="none" stroke={DELEGATION_STROKE[e.status]} strokeWidth={1.5 + Math.min(e.count, 4) * 0.5} strokeLinecap="round"
                strokeDasharray={e.status === "draft" ? "2 6" : e.status === "sent" ? "4 5" : undefined} markerEnd={`url(#arrow-${e.status})`} opacity={e.status === "done" || e.status === "cancelled" || e.status === "draft" ? 0.45 : 0.95}>
                {live && <animate attributeName="stroke-dashoffset" from="0" to="-18" dur="0.9s" repeatCount="indefinite" />}
              </path>
              {live && <path d={d} fill="none" stroke={DELEGATION_STROKE[e.status]} strokeWidth={2} strokeDasharray="2 16" strokeLinecap="round" opacity={0.9}>
                <animate attributeName="stroke-dashoffset" from="0" to="-36" dur="1.2s" repeatCount="indefinite" />
              </path>}
              {e.count > 1 && (
                <text x={(sx + ex) / 2} y={(y + cy) / 2 + (forward ? -4 : 12)} textAnchor="middle" className="fill-[var(--color-ink-3)] text-[10px]">
                  ×{e.count}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((n, i) => (
        <button
          key={n.key}
          onClick={() => onJump(n.name, n.agent?.id)}
          title={projectLabel(n.project)}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-canvas px-3 py-1.5 shadow-md transition-all duration-200 hover:-translate-y-[calc(50%+1px)] hover:shadow-lg"
          style={{ left: x(i), top: mid }}
        >
          <span className="size-2 rounded-full" style={{ background: projectColor(n.project) }} />
          <span className="text-xs font-semibold text-ink">{n.name}</span>
          {n.agent && <StatusIcon status={n.agent.status} size={12} />}
        </button>
      ))}
    </div>
  );
}

/** Close an open delegation by hand: when its agents are gone, or it was finished without a report. */
function CloseMenu({ delegation: d }: { delegation: AdmiralDelegation }) {
  const items: ActionItem[] = [
    { id: "done", label: "Mark as done", description: "It was finished; nobody reported it.", run: () => void closeDelegation(d.id, "done", "marked done in OpenAdmiral") },
    { id: "cancel", label: "Cancel", description: "Drop it: nobody will work on it.", danger: true, run: () => void closeDelegation(d.id, "cancelled", "cancelled in OpenAdmiral") },
  ];
  return (
    // Opens rightwards: the board's left edge would clip it.
    <ActionMenu
      align="left"
      items={items}
      trigger={(toggle, isOpen) => (
        <button onClick={toggle} className={cn("rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink", isOpen && "bg-line text-ink")}>
          Close…
        </button>
      )}
    />
  );
}

/** "When this is done, tell <agent> …": a queued prompt waiting on this delegation. */
function ThenTell({ delegation: d, agents, queues }: { delegation: AdmiralDelegation; agents: Agent[]; queues: Record<string, QueueEntry> }) {
  const live = agents.filter((a) => a.status !== "ended");
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(live.find((a) => a.id === d.from.sessionId)?.id ?? live[0]?.id ?? "");
  const [text, setText] = useState("");
  const add = async () => {
    if (!to || !text.trim()) return;
    const q = queues[to]?.queue ?? emptyQueue();
    await saveQueue(to, { ...q, items: [...q.items, { id: newItemId(), text: text.trim(), createdAt: Date.now(), after: { kind: "delegation", id: d.id, status: ["done"] } }] });
    setText("");
    setOpen(false);
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink">
        Then tell…
      </button>
    );
  }
  return (
    <div className="absolute inset-x-2 bottom-2 z-10 space-y-1.5 rounded-lg border border-line-strong bg-canvas p-2 shadow-lg">
      <div className="text-[10.5px] text-ink-3">When this is done, tell</div>
      <select value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink">
        {live.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <textarea
        autoFocus
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.metaKey && add()}
        placeholder="What to do next…"
        className="w-full resize-none rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink placeholder:text-ink-3 focus:border-brand-500 focus:outline-none"
      />
      <div className="flex justify-end gap-1.5">
        <button onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-[11px] text-ink-3 hover:bg-line">Cancel</button>
        <button onClick={add} disabled={!text.trim()} className="rounded-md bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40">Queue</button>
      </div>
    </div>
  );
}
