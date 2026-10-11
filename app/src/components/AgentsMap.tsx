import { ChatLineLinearIcon, GitForkLinearIcon, HourglassLinearIcon, StructureLinearIcon } from "@solar-icons/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { agentLinks, sharedCheckout, type AgentLink } from "@/lib/agentLinks";
import type { Group } from "@/lib/order";
import type { QueueEntry } from "@/lib/queue";
import type { Agent, DelegationStatus, AdmiralDelegation } from "@/lib/types";
import { ago, branchTone, cn, contextUsed, fillText, projectColor, usd } from "@/lib/utils";
import { DELEGATION_HELP, DELEGATION_LABEL, DELEGATION_STROKE, Meter } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { Info } from "./Info";
import { Tip } from "./Tooltip";
import { UnderwayPill } from "@/components/UnderwayPill";

type Props = {
  groups: Group[];
  agents: Agent[];
  delegations: AdmiralDelegation[];
  queues: Record<string, QueueEntry>;
  now: number;
  onJump: (agentId: string) => void;
  onOpenDelegations: () => void;
};

type Box = { x: number; y: number; w: number; h: number };

const MESSAGE_STROKE = "var(--color-ink-3)";
const WAIT_STROKE = "#8b5cf6";

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * Every agent, clustered by project in sidebar order, with what ties them together:
 * delegations (solid, by status), recent SendMessage traffic (dashed) and queued
 * prompts that wait for another session (dotted). Layout is plain flow (wrapped
 * cluster cards); the edges are an SVG layer drawn from the measured node boxes.
 */
export function AgentsMap({ groups, agents, delegations, queues, now, onJump, onOpenDelegations }: Props) {
  const [showEnded, setShowEnded] = useState(false);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);

  const clusters = useMemo(
    () => groups.map((g) => ({ ...g, agents: g.agents.filter((a) => showEnded || a.status !== "ended") })).filter((g) => g.agents.length > 0),
    [groups, showEnded],
  );
  const shown = useMemo(() => clusters.flatMap((g) => g.agents), [clusters]);
  const links = useMemo(() => agentLinks({ agents, shown, delegations, queues, now }), [agents, shown, delegations, queues, now]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const endedCount = agents.filter((a) => a.status === "ended").length;
  const live = shown.filter((a) => a.status !== "ended");

  // Node boxes, relative to the map, re-measured after every render and on resize.
  const wrap = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const o = el.getBoundingClientRect();
    const next: Record<string, Box> = {};
    for (const [id, n] of nodeEls.current) {
      if (!n.isConnected) continue;
      const r = n.getBoundingClientRect();
      // Relative to the padding box, where the SVG layer's origin is.
      next[id] = { x: Math.round(r.left - o.left - el.clientLeft), y: Math.round(r.top - o.top - el.clientTop), w: Math.round(r.width), h: Math.round(r.height) };
    }
    setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
    setSize((prev) => (prev.w === el.scrollWidth && prev.h === el.scrollHeight ? prev : { w: el.scrollWidth, h: el.scrollHeight }));
  }, []);
  useLayoutEffect(() => measure());
  const shownKey = shown.map((a) => a.id).join(",");
  useLayoutEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap.current);
    nodeEls.current.forEach((n) => ro.observe(n));
    return () => ro.disconnect();
  }, [measure, shownKey]);

  const nodeRef = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  };

  // Several links between the same two agents fan out into lanes.
  const lanes = useMemo(() => {
    const byPair = new Map<string, AgentLink[]>();
    for (const l of links) {
      const k = [l.from, l.to].sort().join("|");
      byPair.set(k, [...(byPair.get(k) ?? []), l]);
    }
    const out = new Map<string, { i: number; n: number }>();
    for (const list of byPair.values()) list.forEach((l, i) => out.set(l.id, { i, n: list.length }));
    return out;
  }, [links]);

  const touches = (l: AgentLink, id: string) => l.from === id || l.to === id;
  const neighbours = useMemo(() => {
    if (!hoverNode) return null;
    const s = new Set([hoverNode]);
    for (const l of links) if (touches(l, hoverNode)) s.add(l.from).add(l.to);
    return s;
  }, [hoverNode, links]);
  const edgeDim = (l: AgentLink) => (hoverNode ? !touches(l, hoverNode) : hoverEdge ? hoverEdge !== l.id : false);
  const nodeDim = (id: string) => {
    if (neighbours) return !neighbours.has(id);
    if (hoverEdge) {
      const l = links.find((x) => x.id === hoverEdge);
      return !!l && !touches(l, id);
    }
    return false;
  };

  const tipId = (l: AgentLink) => `map-edge-${l.id}`;
  const showTip = (l: AgentLink) => {
    setHoverEdge(l.id);
    window.dispatchEvent(new CustomEvent("openadmiral:tip", { detail: tipId(l) }));
  };
  const hideTip = () => {
    setHoverEdge(null);
    window.dispatchEvent(new Event("openadmiral:tip-hide"));
  };
  const clickEdge = (l: AgentLink) => {
    if (l.kind === "delegation") onOpenDelegations();
    else onJump(l.from);
  };

  const drawn = links
    .map((l) => {
      const a = boxes[l.from], b = boxes[l.to];
      if (!a || !b) return null;
      return { link: l, geo: geometry(a, b, lanes.get(l.id) ?? { i: 0, n: 1 }) };
    })
    .filter((x): x is { link: AgentLink; geo: Geo } => !!x);

  const counts = { delegation: 0, message: 0, wait: 0 };
  for (const l of links) counts[l.kind]++;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 px-6 pt-3.5 pb-4">
        <StructureLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Agents</h1>
        <Info
          tip="Every agent by project, and what ties them together: delegations, recent messages (SendMessage) and queued prompts that wait for another agent. Hover an agent to see only its links; click it to open it."
          align="left"
        />
        <span className="text-sm text-ink-3 tabular">
          {live.length} running or idle
          {links.length > 0 && ` · ${links.length} link${links.length > 1 ? "s" : ""}`}
        </span>
        <span className="flex-1" />
        <label className={cn("flex cursor-pointer items-center gap-2 text-xs text-ink-2 select-none", !endedCount && "opacity-60")}>
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} className="size-3.5 accent-brand-600" />
          Show ended
          {endedCount > 0 && <span className="text-ink-3 tabular">{endedCount}</span>}
        </label>
        <UnderwayPill />
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <Legend counts={counts} />
        {shown.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <StructureLinearIcon size={32} className="mb-3 text-ink-3" />
            <p className="text-sm font-semibold text-ink">No agents running</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
              Agents show up here, grouped by project, as soon as a Claude Code session with the OpenAdmiral plugin starts.
              {endedCount > 0 && " Turn on Show ended to see the ones that finished."}
            </p>
          </div>
        ) : (
          <>
            {links.length === 0 && (
              <p className="mb-3 rounded-xl border border-dashed border-line-strong px-4 py-2.5 text-xs text-ink-3">
                No links between agents right now. Delegations, messages and queued prompts that wait for another agent show up here as lines.
              </p>
            )}
            <div
              ref={wrap}
              className="relative rounded-2xl border border-line bg-canvas p-5 shadow-sm"
              onPointerLeave={() => setHoverNode(null)}
            >
              <div
                className="pointer-events-none absolute inset-0 rounded-2xl opacity-60"
                style={{ backgroundImage: "radial-gradient(var(--color-line-strong) 1px, transparent 1px)", backgroundSize: "18px 18px" }}
              />
              <div className="relative flex flex-wrap items-start gap-x-12 gap-y-6">
                {clusters.map((g) => (
                  <Cluster key={g.key} group={g}>
                    {g.agents.map((a) => (
                      <Node
                        key={a.id}
                        agent={a}
                        nodeRef={nodeRef(a.id)}
                        dim={nodeDim(a.id)}
                        hot={hoverNode === a.id}
                        onEnter={() => setHoverNode(a.id)}
                        onLeave={() => setHoverNode(null)}
                        onClick={() => onJump(a.id)}
                      />
                    ))}
                  </Cluster>
                ))}
              </div>

              {/* Edges above the cluster cards, below the nodes; only the hit paths take the pointer. */}
              <svg className="pointer-events-none absolute top-0 left-0 z-10 overflow-visible" width={size.w} height={size.h}>
                <defs>
                  {[...Object.entries(DELEGATION_STROKE), ["message", MESSAGE_STROKE], ["wait", WAIT_STROKE]].map(([k, c]) => (
                    <marker key={k} id={`map-arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: c }} />
                    </marker>
                  ))}
                </defs>
                {drawn.map(({ link: l, geo }) => (
                  <Edge key={l.id} link={l} d={geo.d} dim={edgeDim(l)} hot={hoverEdge === l.id || (!!hoverNode && touches(l, hoverNode))} />
                ))}
                {drawn.map(({ link: l, geo }) => (
                  <path
                    key={`hit-${l.id}`}
                    d={geo.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12}
                    className="cursor-pointer"
                    style={{ pointerEvents: "stroke" }}
                    onPointerEnter={() => showTip(l)}
                    onPointerLeave={hideTip}
                    onClick={() => clickEdge(l)}
                  />
                ))}
              </svg>

              {/* Edge labels: the anchor of each edge's tooltip. */}
              {drawn.map(({ link: l, geo }) => (
                <Tip key={`label-${l.id}`} id={tipId(l)} side="bottom" content={<EdgeTip link={l} byId={byId} now={now} />}>
                  <button
                    onClick={() => clickEdge(l)}
                    onPointerEnter={() => setHoverEdge(l.id)}
                    onPointerLeave={() => setHoverEdge(null)}
                    className={cn(
                      "absolute z-30 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150",
                      edgeDim(l) && "opacity-15",
                    )}
                    style={{ left: geo.mid.x, top: geo.mid.y }}
                  >
                    <EdgeLabel link={l} />
                  </button>
                </Tip>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function sameBoxes(a: Record<string, Box>, b: Record<string, Box>) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = a[k], y = b[k];
    return y && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h;
  });
}

type Geo = { d: string; mid: { x: number; y: number } };

/**
 * A cubic curve between two node boxes. Side by side: from the facing edges. In one
 * column: out of the right edges and back, bulging further the further apart they are.
 * Several links between the same pair take separate lanes.
 */
function geometry(a: Box, b: Box, lane: { i: number; n: number }): Geo {
  const offset = (lane.i - (lane.n - 1) / 2) * 10;
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let p0, p1, p2, p3;
  if (Math.abs(bc.x - ac.x) < Math.min(a.w, b.w) / 2) {
    const bulge = 28 + Math.min(80, Math.abs(bc.y - ac.y) * 0.18) + lane.i * 16;
    const x = Math.max(a.x + a.w, b.x + b.w);
    p0 = { x: a.x + a.w, y: ac.y + offset * 0.4 };
    p3 = { x: b.x + b.w + 2, y: bc.y + offset * 0.4 };
    p1 = { x: x + bulge, y: p0.y };
    p2 = { x: x + bulge, y: p3.y };
  } else {
    const fwd = bc.x > ac.x;
    p0 = { x: fwd ? a.x + a.w : a.x, y: ac.y + offset };
    p3 = { x: fwd ? b.x - 2 : b.x + b.w + 2, y: bc.y + offset };
    const c = Math.max(40, Math.abs(p3.x - p0.x) / 2) * (fwd ? 1 : -1);
    p1 = { x: p0.x + c, y: p0.y };
    p2 = { x: p3.x - c, y: p3.y };
  }
  const mid = { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 };
  return { d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`, mid };
}

function strokeOf(l: AgentLink) {
  return l.kind === "delegation" ? DELEGATION_STROKE[l.status] : l.kind === "message" ? MESSAGE_STROKE : WAIT_STROKE;
}

const DASH: Partial<Record<DelegationStatus, string>> = { draft: "2 6", sent: "5 5" };

function Edge({ link: l, d, dim, hot }: { link: AgentLink; d: string; dim: boolean; hot: boolean }) {
  const color = strokeOf(l);
  const marker = `url(#map-arrow-${l.kind === "delegation" ? l.status : l.kind})`;
  const base = l.kind === "delegation" ? (l.settled || l.status === "draft" ? 0.45 : 0.9) : l.kind === "message" ? 0.7 : 0.85;
  const opacity = dim ? 0.08 : hot ? 1 : base;
  const live = l.kind === "delegation" && l.status === "in_progress";
  return (
    <g style={{ transition: "opacity 150ms" }} opacity={opacity}>
      {l.kind === "delegation" ? (
        <path d={d} fill="none" stroke={color} strokeWidth={hot ? 2.5 : 2} strokeLinecap="round" strokeDasharray={DASH[l.status]} markerEnd={marker} />
      ) : l.kind === "message" ? (
        <path d={d} fill="none" style={{ stroke: color }} strokeWidth={hot ? 1.75 : 1.25} strokeDasharray="5 4" strokeLinecap="round" markerEnd={marker} />
      ) : (
        <path d={d} fill="none" stroke={color} strokeWidth={hot ? 2.25 : 1.75} strokeDasharray="0.5 5" strokeLinecap="round" markerEnd={marker} />
      )}
      {live && (
        <path d={d} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray="2 16" strokeLinecap="round" className="motion-reduce:hidden">
          <animate attributeName="stroke-dashoffset" from="0" to="-36" dur="1.2s" repeatCount="indefinite" />
        </path>
      )}
    </g>
  );
}

function EdgeLabel({ link: l }: { link: AgentLink }) {
  if (l.kind === "delegation") {
    return (
      <span
        className={cn(
          "flex max-w-[150px] items-center gap-1 rounded-full border border-line-strong bg-canvas px-1.5 py-px text-[10.5px] whitespace-nowrap text-ink-2 shadow-sm",
          l.settled && "text-ink-3",
          l.conditions.length > 0 && "pr-1",
        )}
      >
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: DELEGATION_STROKE[l.status] }} />
        <span className={cn("truncate", l.status === "cancelled" && "line-through")}>{short(l.title, 28)}</span>
        {l.conditions.length > 0 && <HourglassLinearIcon size={10} className="shrink-0 text-violet-500" />}
      </span>
    );
  }
  const Icon = l.kind === "message" ? ChatLineLinearIcon : HourglassLinearIcon;
  return (
    <span
      className={cn(
        "flex size-[18px] items-center justify-center rounded-full border bg-canvas shadow-sm",
        l.kind === "message" ? "border-line-strong text-ink-3" : "border-violet-500/40 text-violet-600 dark:text-violet-400",
      )}
    >
      <Icon size={10} />
    </span>
  );
}

function EdgeTip({ link: l, byId, now }: { link: AgentLink; byId: Map<string, Agent>; now: number }) {
  const from = byId.get(l.from)?.name ?? l.from.slice(0, 8);
  const to = byId.get(l.to)?.name ?? l.to.slice(0, 8);
  if (l.kind === "delegation") {
    return (
      <div className="w-64 space-y-1">
        <div className="font-semibold">{l.title}</div>
        <div className="text-[11px] text-ink-2">
          {from} → {to}
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="size-1.5 rounded-full" style={{ background: DELEGATION_STROKE[l.status] }} />
          <span className="font-semibold">{DELEGATION_LABEL[l.status]}</span>
          <span className="text-ink-3">· updated {ago(l.at, now)} ago</span>
        </div>
        <div className="text-[11px] text-ink-3">{DELEGATION_HELP[l.status]}</div>
        {l.conditions.map((c, i) => (
          <div key={i} className="border-t border-line pt-1 text-[11px] text-ink-2">
            <span className="font-semibold text-violet-600 dark:text-violet-400">Then</span> {byId.get(c.agentId)?.name ?? "an agent"} runs “{short(c.text, 80)}” when{" "}
            {c.statuses.join(" or ")}
          </div>
        ))}
        <div className="pt-0.5 text-[10.5px] text-ink-3">Click to open Delegations</div>
      </div>
    );
  }
  if (l.kind === "message") {
    return (
      <div className="w-64 space-y-1">
        <div className="text-[11px] text-ink-2">
          <span className="font-semibold text-ink">{from}</span> messaged <span className="font-semibold text-ink">{to}</span> · {ago(l.at, now)} ago
          {l.count > 1 && <span className="text-ink-3"> · {l.count} messages</span>}
        </div>
        <div className="line-clamp-4 text-[11px] text-ink-2">{l.text || "(no summary)"}</div>
      </div>
    );
  }
  return (
    <div className="w-64 space-y-1">
      <div className="text-[11px] text-ink-2">
        <span className="font-semibold text-ink">{from}</span> waits for <span className="font-semibold text-ink">{to}</span> to finish its turn
      </div>
      <div className="line-clamp-3 text-[11px] text-ink-2">Then runs “{l.text}”</div>
      {l.count > 1 && <div className="text-[11px] text-ink-3">{l.count} queued prompts wait for it</div>}
    </div>
  );
}

function Cluster({ group, children }: { group: Group; children: React.ReactNode }) {
  const color = projectColor(group.label);
  const shared = sharedCheckout(group.agents);
  return (
    <section
      className="w-[248px] rounded-2xl border p-2.5"
      style={{
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 6%, transparent)`,
      }}
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
        <h3 className="truncate text-xs font-semibold text-ink">{group.label}</h3>
        <span className="ml-auto text-[11px] text-ink-3 tabular">{group.agents.length}</span>
      </div>
      <div className="space-y-2">{children}</div>
      {shared && (
        <Tip
          side="bottom"
          content={
            <div className="w-56 text-[11px] text-ink-2">
              {shared.agents} agents work in this repo from different checkouts
              {shared.worktrees > 0 && ` (${shared.worktrees} in linked worktree${shared.worktrees > 1 ? "s" : ""})`}. Branches: {shared.branches.join(", ") || "unknown"}.
            </div>
          }
        >
          <div className="mt-2 flex items-center gap-1.5 px-1 text-[10.5px] text-ink-3">
            <GitForkLinearIcon size={11} className="shrink-0" />
            <span className="truncate">
              Same repo · {shared.branches.length > 1 ? `${shared.branches.length} branches` : "separate checkouts"}
              {shared.worktrees > 0 && ` · ${shared.worktrees} worktree${shared.worktrees > 1 ? "s" : ""}`}
            </span>
          </div>
        </Tip>
      )}
    </section>
  );
}

function Node({ agent: a, nodeRef, dim, hot, onEnter, onLeave, onClick }: { agent: Agent; nodeRef: (el: HTMLElement | null) => void; dim: boolean; hot: boolean; onEnter: () => void; onLeave: () => void; onClick: () => void }) {
  const s = a.session;
  const ctx = contextUsed(s?.context);
  const waiting = a.status === "waiting";
  const running = (s?.subagents ?? []).filter((x) => x.status === "running");
  return (
    <div className={cn("relative z-20 transition-opacity duration-150", dim && "opacity-35", a.status === "ended" && !dim && "opacity-70 dark:opacity-55")}>
      <button
        ref={nodeRef}
        onClick={onClick}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        className={cn(
          "flex w-full flex-col gap-1.5 rounded-xl border bg-canvas px-2.5 py-2 text-left shadow-sm outline-none transition-all duration-200 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500",
          waiting ? "border-amber-500/50 ring-2 ring-amber-500/20 dark:border-amber-400/40" : "border-line-strong",
          hot && !waiting && "border-brand-500/50 shadow-md",
        )}
      >
        <span className="flex items-center gap-2">
          <StatusIcon status={a.status} />
          <span className="flex-1 truncate text-[13px] font-semibold text-ink">{a.name}</span>
          {waiting ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300">needs you</span>
          ) : (
            s?.costUsd !== undefined && <span className="text-[11px] text-ink-3 tabular">{usd(s.costUsd)}</span>
          )}
        </span>
        {waiting && s?.waiting?.detail && <span className="truncate pl-[22px] text-[10.5px] text-amber-700 dark:text-amber-300">{s.waiting.detail}</span>}
        <span className="flex items-center gap-2 pl-[22px] text-xs text-ink-3">
          <span className={cn("truncate font-mono text-[11px]", branchTone(s?.branch))}>{s?.branch ?? (a.cli ? "—" : "ended")}</span>
          {s?.worktree && <span className="shrink-0 rounded bg-brand-500/10 px-1 text-[10px] text-brand-700 dark:text-brand-300">worktree</span>}
          <span className="flex-1" />
          {waiting && s?.costUsd !== undefined && <span className="text-[11px] tabular">{usd(s.costUsd)}</span>}
          {ctx !== undefined && (
            <span className="flex w-14 shrink-0 items-center gap-1.5">
              <Meter value={ctx} className="flex-1" />
              <span className={cn("w-6 text-right text-[10px] tabular", fillText(ctx))}>{Math.round(ctx)}%</span>
            </span>
          )}
        </span>
      </button>
      {running.length > 0 && (
        // Running subagents hang off their parent like satellites.
        <div className="relative mt-1 ml-[19px] flex flex-wrap gap-1 border-l border-dashed border-line-strong pt-0.5 pl-2.5">
          {running.map((x) => (
            <Tip key={x.id} side="bottom" content={<span className="block max-w-60 text-[11px]"><span className="font-semibold">{x.type ?? "Subagent"}</span>{x.description ? ` · ${x.description}` : ""}</span>}>
              <span className="inline-flex max-w-[200px] items-center gap-1 rounded-full border border-line bg-canvas px-1.5 py-px text-[10px] text-ink-2 shadow-sm">
                <span className="size-1.5 shrink-0 rounded-full bg-brand-500 motion-safe:animate-pulse" />
                <span className="truncate">{x.description ?? x.type ?? "subagent"}</span>
              </span>
            </Tip>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ counts }: { counts: Record<AgentLink["kind"], number> }) {
  const item = (svg: React.ReactNode, label: string, n?: number) => (
    <span className="flex items-center gap-1.5">
      <svg width={26} height={8} className="shrink-0">
        {svg}
      </svg>
      <span>{label}</span>
      {!!n && <span className="text-ink-3/80 tabular">{n}</span>}
    </span>
  );
  const line = (stroke: string, dash?: string, width = 2) => <line x1={1} y1={4} x2={25} y2={4} style={{ stroke }} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" />;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-ink-3">
      {item(line(DELEGATION_STROKE.in_progress), "Delegation", counts.delegation)}
      <span className="flex items-center gap-2">
        {(["draft", "sent", "accepted", "in_progress", "blocked", "done"] as DelegationStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: DELEGATION_STROKE[s] }} />
            {DELEGATION_LABEL[s].split(" ·")[0]}
          </span>
        ))}
      </span>
      {item(line(MESSAGE_STROKE, "5 4", 1.25), "Message, last 3 h", counts.message)}
      {item(line(WAIT_STROKE, "0.5 5", 1.75), "Waits for", counts.wait)}
      <span className="flex items-center gap-1.5">
        <GitForkLinearIcon size={12} />
        Same repo, other checkout
      </span>
    </div>
  );
}
