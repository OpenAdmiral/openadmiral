import { PauseLinearIcon, PlayLinearIcon, StructureLinearIcon } from "@solar-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { waitLinks } from "@/lib/agentLinks";
import { activityScores, arrange, bandLayout, CARD_W, curveBetween, fleetAt, histogram, linksOf, placeBand, toolLabel, useTraffic, workAt, type Arrangement, type Band, type Box, type Cell, type Resolved } from "@/lib/fleet";
import { slotOf, type Node as TreeNode } from "@/lib/order";
import type { QueueEntry } from "@/lib/queue";
import type { Agent } from "@/lib/types";
import { ago, branchTone, cn, contextUsed, fillText, projectColor, usd } from "@/lib/utils";
import { Meter } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { SpaceTile } from "./Sidebar";
import { Info } from "./Info";
import { Tip } from "./Tooltip";
import { UnderwayPill } from "@/components/UnderwayPill";

type Props = {
  /** The projects the person made and the folders on their own, as the sidebar has them. */
  tree: TreeNode[];
  agents: Agent[];
  queues: Record<string, QueueEntry>;
  onJump: (agentId: string) => void;
};

const SPEEDS = [10, 30, 90];
const PERIODS = [1, 3, 8];
const HOUR = 3_600_000;
const SLICES = 120;
const WORKS_STROKE = "var(--color-brand-500)";
const AWAITS_STROKE = "#8b5cf6";
/** How long a message's summary stays on its line. */
const SHOW_MS = 7000;

type ProjectBand = Band<Agent> & { node: TreeNode };

/**
 * What the fleet is doing, as it happens: a band per project with the agents that did something
 * in the timeline's period, messages crossing between them, and who works for or awaits whom
 * (deduced from the order of things, see lib/fleet). Live by default; the timeline replays.
 */
export function AgentsMap({ tree, agents, queues, onJump }: Props) {
  const { messages, work } = useTraffic(agents);
  const [hours, setHours] = useState(3);
  const [replay, setReplay] = useState<{ at: number; speed: number; playing: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  // Live, the clock only says what time it is; replaying, it drives the picture.
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setNow(Date.now()), replay?.playing ? 100 : 1000);
    return () => clearInterval(t);
  }, [replay?.playing]);
  const lastTick = useRef(now);
  useEffect(() => {
    const dt = now - lastTick.current;
    lastTick.current = now;
    if (replay?.playing) setReplay((r) => (r ? (r.at + dt * r.speed >= now ? null : { ...r, at: r.at + dt * r.speed }) : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);
  const at = replay?.at ?? now;
  const from = now - hours * HOUR;

  // Live, the agents' own status says who works; replaying, their tool calls then.
  const working = useMemo(() => {
    if (replay) return workAt(work, at);
    const out = new Map<string, string | null>();
    for (const a of agents) if (a.status === "working") out.set(a.id, a.session?.turn?.progress?.at(-1)?.step ?? a.session?.lastTool?.summary ?? null);
    return out;
  }, [replay, work, at, agents]);
  const fleet = useMemo(() => fleetAt(messages, work, working, at), [messages, work, working, at]);

  // Only who did something in the period, or is at it now; in place while looking.
  const bandsAll = useMemo<ProjectBand[]>(
    () => tree.map((node) => (node.kind === "space" ? { id: `s:${node.space.id}`, agents: node.groups.flatMap((g) => g.agents), node } : { id: slotOf(node.group), agents: node.group.agents, node })),
    [tree],
  );
  const order = useRef<{ hours: number; order: Arrangement } | null>(null);
  const scores = activityScores(messages, work, from);
  const score = (a: Agent) => (scores.get(a.id) ?? 0) + (a.status === "working" || a.status === "waiting" ? 1 : 0);
  // Before the first reading, activity would look like none at all and fix a wrong order.
  const ready = messages.length > 0 || work.length > 0;
  const arranged = arrange(bandsAll, (a) => a.id, score, order.current?.hours === hours ? order.current.order : null);
  if (ready) order.current = { hours, order: arranged.order };
  const bands = arranged.bands as ProjectBand[];
  const shown = bands.flatMap((b) => b.agents);
  const quiet = agents.filter((a) => a.status !== "ended").length - shown.filter((a) => a.status !== "ended").length;

  // Width of the stage, and the cards as they really are, for the lines.
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  useLayoutEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  // Each band around its busiest agent. Decided once for the period and these agents: cards
  // that moved with every message could not be followed.
  const placements = useRef(new Map<string, { key: string; cells: Cell[] }>());
  const cells = bands.map((b) => {
    const ids = b.agents.map((a) => a.id);
    const key = `${hours}|${ids.join()}`;
    const known = placements.current.get(b.id);
    if (known?.key === key) return known.cells;
    const made = placeBand(ids, linksOf(messages, from));
    if (ready) placements.current.set(b.id, { key, cells: made });
    return made;
  });
  const layout = bandLayout(cells, width);
  const boxes = useMemo(() => {
    const out: Record<string, Box> = {};
    bands.forEach((b, i) => b.agents.forEach((a, j) => {
      const c = layout.bands[i].cards[j];
      out[a.id] = { x: c.left, y: layout.bands[i].top + c.top, w: CARD_W, h: 92, band: i };
    }));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((a) => a.id).join(), JSON.stringify(cells), width]);
  const curve = (a: Box, b: Box, lane = 0) => curveBetween(a, b, lane, Object.values(boxes));

  // Messages on their way. Live: what just arrived, not what was already there on opening.
  const seen = useRef<Map<string, number> | null>(null);
  const known = seen.current;
  if (ready && !known) seen.current = new Map(messages.map((m) => [m.id, 0]));
  else if (known) for (const m of messages) if (!known.has(m.id)) known.set(m.id, Date.now());
  const flying: Resolved[] = replay
    ? messages.filter((m) => m.at <= at && at - m.at < SHOW_MS * Math.max(replay.speed, 1)).slice(-3)
    : messages.filter((m) => now - (seen.current?.get(m.id) ?? 0) < SHOW_MS).slice(-3);

  const [hover, setHover] = useState<string | null>(null);
  const touches = (r: { from: string; to: string }) => !hover || r.from === hover || r.to === hover;
  const near = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const r of [...fleet.worksFor, ...fleet.awaits]) if (r.from === hover || r.to === hover) s.add(r.from).add(r.to);
    for (const p of fleet.pairs) if (p.a === hover || p.b === hover) s.add(p.a).add(p.b);
    return s;
  }, [hover, fleet]);
  const queued = waitLinks(queues, shown);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const lane = (from: string, to: string) => (from < to ? 5 : -5);

  // Summaries sit on their line, moved aside when they would land on one another.
  const placed: { x: number; y: number }[] = [];
  const pills = flying.flatMap((m) => {
    const a = boxes[m.from], b = boxes[m.to];
    if (!a || !b) return [];
    const mid = curve(a, b, lane(m.from, m.to)).at(0.5);
    let y = mid.y;
    for (let i = 0; i < 6 && placed.some((p) => Math.abs(p.x - mid.x) < 200 && Math.abs(p.y - y) < 26); i++) y = mid.y + (i % 2 ? -1 : 1) * ((i + 2) >> 1) * 28;
    placed.push({ x: mid.x, y });
    return [{ m, x: mid.x, y }];
  });

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 px-6 pt-3.5 pb-2">
        <StructureLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Agents</h1>
        <Info
          tip="Who is doing what, as it happens: the agents active in the timeline's period, by project, and the messages between them. “Working for” and “awaiting” are deduced from who wrote to whom and who has answered. Hover an agent to see only its lines; click it to open it."
          align="left"
        />
        <span className="text-sm text-ink-3 tabular">
          {shown.length} active in the last {hours} h · {working.size} working now
          {quiet > 0 && ` · ${quiet} quiet, hidden`}
        </span>
        <span className="flex-1" />
        <UnderwayPill />
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 text-[11px] text-ink-3">
        <LegendLine stroke={WORKS_STROKE} label="Working for" />
        <LegendLine stroke={AWAITS_STROKE} dash="2 4" label="Awaiting reply" />
        <LegendLine stroke="var(--color-line-strong)" label="Spoke in the last 15 min" />
        {queued.length > 0 && <LegendLine stroke={AWAITS_STROKE} dash="0.5 5" label="Queued until it finishes" />}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-3">
        {bands.length === 0 ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <StructureLinearIcon size={32} className="mb-3 text-ink-3" />
            <p className="text-sm font-semibold text-ink">{ready ? `Nothing in the last ${hours} h` : "Reading what the agents did…"}</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-3">Agents show up here, by project, as soon as they do something.</p>
          </div>
        ) : (
          <div ref={wrap} className="relative" style={{ height: layout.height, minWidth: Math.max(...layout.bands.flatMap((b) => b.cards.map((c) => c.left + CARD_W + 16))) }} onPointerLeave={() => setHover(null)}>
            {bands.map((b, i) => (
              <BandBackground key={b.id} band={b} top={layout.bands[i].top} height={layout.bands[i].height} />
            ))}
            <svg className="pointer-events-none absolute top-0 left-0 z-10 overflow-visible" width="100%" height={layout.height}>
              <defs>
                <marker id="fleet-works" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 1 1 L 9 5 L 1 9" fill="none" style={{ stroke: WORKS_STROKE }} strokeWidth={2} />
                </marker>
                <marker id="fleet-awaits" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke={AWAITS_STROKE} strokeWidth={2} />
                </marker>
                <filter id="fleet-blur" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="3" />
                </filter>
              </defs>
              {fleet.pairs.map((p) => {
                const a = boxes[p.a], b = boxes[p.b];
                if (!a || !b) return null;
                const fresh = Math.max(0, 1 - (at - p.last) / (15 * 60_000));
                return <path key={`${p.a}|${p.b}`} d={curve(a, b).d} fill="none" style={{ stroke: "var(--color-ink-3)" }} strokeWidth={1} opacity={hover && !(p.a === hover || p.b === hover) ? 0.05 : 0.12 + 0.3 * fresh} />;
              })}
              {queued.map((l) => {
                const a = boxes[l.from], b = boxes[l.to];
                if (!a || !b) return null;
                return <path key={l.id} d={curve(a, b, 10).d} fill="none" stroke={AWAITS_STROKE} strokeWidth={1.5} strokeDasharray="0.5 5" strokeLinecap="round" markerEnd="url(#fleet-awaits)" opacity={touches(l) ? 0.85 : 0.08} />;
              })}
              {fleet.awaits.map((r) => {
                const a = boxes[r.from], b = boxes[r.to];
                if (!a || !b) return null;
                return (
                  <path key={`await:${r.from}>${r.to}`} d={curve(a, b, lane(r.from, r.to)).d} fill="none" stroke={AWAITS_STROKE} strokeWidth={1.6} strokeDasharray="2 6" strokeLinecap="round" markerEnd="url(#fleet-awaits)" opacity={touches(r) ? 1 : 0.08}>
                    <title>
                      {nameOf(r.from)} awaits {nameOf(r.to)}: {r.summary}
                    </title>
                  </path>
                );
              })}
              {fleet.worksFor.map((r) => {
                const a = boxes[r.from], b = boxes[r.to];
                if (!a || !b) return null;
                const d = curve(a, b, lane(r.from, r.to)).d;
                return (
                  <g key={`works:${r.from}>${r.to}`} opacity={touches(r) ? 1 : 0.08}>
                    <path d={d} fill="none" style={{ stroke: WORKS_STROKE }} strokeWidth={1.6} opacity={0.6} markerEnd="url(#fleet-works)">
                      <title>
                        {nameOf(r.to)} works for {nameOf(r.from)}: {r.summary}
                      </title>
                    </path>
                    <path d={d} pathLength={100} fill="none" stroke="#a9c0f5" strokeWidth={2} strokeLinecap="round" className="fleet-pulse" />
                  </g>
                );
              })}
              {flying.map((m) => {
                const a = boxes[m.from], b = boxes[m.to];
                if (!a || !b) return null;
                const d = curve(a, b, lane(m.from, m.to)).d;
                return (
                  <g key={m.id}>
                    <path d={d} pathLength={100} fill="none" stroke="#5ee1ff" strokeWidth={6} opacity={0.55} filter="url(#fleet-blur)" className="fleet-beam" />
                    <path d={d} pathLength={100} fill="none" stroke="#d6f6ff" strokeWidth={2} strokeLinecap="round" className="fleet-beam" />
                  </g>
                );
              })}
            </svg>
            {pills.map(({ m, x, y }) => (
              <div key={m.id} className="pointer-events-none absolute z-30 max-w-[300px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full bg-ink px-2.5 py-1 text-[11px] font-medium text-canvas shadow-lg" style={{ left: x, top: y }}>
                {m.summary || m.text.slice(0, 60)}
              </div>
            ))}
            {bands.map((b, i) =>
              b.agents.map((a, j) => {
                const c = layout.bands[i].cards[j];
                return (
                  <div key={a.id} className={cn("absolute z-20 transition-opacity duration-150", near && !near.has(a.id) && "opacity-35")} style={{ left: c.left, top: layout.bands[i].top + c.top, width: CARD_W }}>
                    <AgentCard agent={a} isWorking={working.has(a.id)} doing={working.get(a.id) ?? null} replaying={!!replay} onEnter={() => setHover(a.id)} onLeave={() => setHover(null)} onClick={() => onJump(a.id)} />
                  </div>
                );
              }),
            )}
          </div>
        )}
      </div>

      <Timeline messages={messages} work={work} from={from} to={now} at={at} hours={hours} setHours={setHours} replay={replay} setReplay={setReplay} />
    </div>
  );
}

function LegendLine({ stroke, dash, label }: { stroke: string; dash?: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width={22} height={6} className="shrink-0">
        <line x1={1} y1={3} x2={21} y2={3} style={{ stroke }} strokeWidth={2} strokeDasharray={dash} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
}

/** A project's band, tinted as its card in the sidebar, with its name in the left gutter. */
function BandBackground({ band, top, height }: { band: ProjectBand; top: number; height: number }) {
  const n = band.node;
  const color = n.kind === "space" ? n.space.color : projectColor(n.group.label);
  const name = n.kind === "space" ? n.space.name : n.group.label;
  return (
    <section
      className="absolute inset-x-0 rounded-2xl"
      style={{
        top,
        height,
        background: `linear-gradient(180deg, color-mix(in srgb, ${color} 10%, transparent), color-mix(in srgb, ${color} 4%, transparent))`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 24%, transparent)`,
      }}
    >
      <div className="absolute top-1/2 left-4 flex w-[112px] -translate-y-1/2 flex-col items-start gap-1.5">
        {n.kind === "space" ? <SpaceTile space={n.space} /> : <span className="size-2.5 rounded-full" style={{ background: color }} />}
        <h3 className="text-[13.5px] leading-tight font-semibold tracking-[-0.01em] break-words text-ink">{name}</h3>
        <span className="text-[11px] text-ink-3 tabular">{band.agents.length}</span>
      </div>
    </section>
  );
}

function AgentCard({ agent: a, isWorking, doing, replaying, onEnter, onLeave, onClick }: { agent: Agent; isWorking: boolean; doing: string | null; replaying: boolean; onEnter: () => void; onLeave: () => void; onClick: () => void }) {
  const s = a.session;
  const ctx = contextUsed(s?.context);
  const waiting = !replaying && a.status === "waiting";
  const running = (s?.subagents ?? []).filter((x) => x.status === "running");
  // Replaying, its state then, not its state now.
  const status = waiting ? "waiting" : replaying ? (isWorking ? "working" : "idle") : a.status;
  return (
    <div className={cn(a.status === "ended" && !isWorking && "opacity-70 dark:opacity-55")}>
      <button
        onClick={onClick}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        className={cn(
          "flex h-[92px] w-full flex-col gap-1 rounded-xl border bg-canvas px-2.5 py-2 text-left shadow-sm outline-none transition-[border-color,box-shadow] duration-200 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500",
          waiting ? "border-amber-500/60 ring-2 ring-amber-500/20" : isWorking ? "border-brand-500/60 shadow-[0_8px_26px_-8px_rgb(59_110_240/0.65)] ring-2 ring-brand-500/15" : "border-line-strong",
        )}
      >
        <span className="flex items-center gap-2">
          <StatusIcon status={status} tip={false} />
          <span className="flex-1 truncate text-[13px] font-semibold text-ink">{a.name}</span>
          {waiting ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold leading-4 text-amber-700 dark:text-amber-300">needs you</span>
          ) : (
            s?.costUsd !== undefined && <span className="text-[11px] text-ink-3 tabular">{usd(s.costUsd)}</span>
          )}
        </span>
        <span className={cn("truncate pl-[22px] text-[11px]", waiting ? "text-amber-700 dark:text-amber-300" : isWorking ? "text-brand-700 dark:text-brand-300" : "text-ink-3")}>
          {waiting ? (s?.waiting?.detail ?? "Waiting for you") : isWorking ? toolLabel(doing ?? "Working") : status === "ended" ? "ended" : "idle"}
        </span>
        <span className="mt-auto flex items-center gap-2 pl-[22px] text-xs text-ink-3">
          <span className={cn("truncate font-mono text-[11px]", branchTone(s?.branch))}>{s?.branch ?? "—"}</span>
          {s?.worktree && <span className="shrink-0 rounded bg-brand-500/10 px-1 text-[10px] text-brand-700 dark:text-brand-300">worktree</span>}
          <span className="flex-1" />
          {ctx !== undefined && (
            <span className="flex w-14 shrink-0 items-center gap-1.5">
              <Meter value={ctx} className="flex-1" />
              <span className={cn("w-6 text-right text-[10px] tabular", fillText(ctx))}>{Math.round(ctx)}%</span>
            </span>
          )}
        </span>
      </button>
      {running.length > 0 && !replaying && (
        // Running subagents hang off their parent like satellites.
        <div className="relative mt-1 ml-[19px] flex flex-wrap gap-1 border-l border-dashed border-line-strong pt-0.5 pl-2.5">
          {running.slice(0, 2).map((x) => (
            <Tip key={x.id} side="bottom" content={<span className="block max-w-60 text-[11px]"><span className="font-semibold">{x.type ?? "Subagent"}</span>{x.description ? ` · ${x.description}` : ""}</span>}>
              <span className="inline-flex max-w-[180px] items-center gap-1 rounded-full border border-line bg-canvas px-1.5 py-px text-[10px] text-ink-2 shadow-sm">
                <span className="size-1.5 shrink-0 rounded-full bg-brand-500 motion-safe:animate-pulse" />
                <span className="truncate">{x.description ?? x.type ?? "subagent"}</span>
              </span>
            </Tip>
          ))}
          {running.length > 2 && <span className="text-[10px] text-ink-3">+{running.length - 2}</span>}
        </div>
      )}
    </div>
  );
}

type Replay = { at: number; speed: number; playing: boolean } | null;

/** The period, the replay, and LIVE. Blue bars are messages, grey ones work. */
function Timeline({ messages, work, from, to, at, hours, setHours, replay, setReplay }: { messages: Resolved[]; work: { at: number }[]; from: number; to: number; at: number; hours: number; setHours: (h: number) => void; replay: Replay; setReplay: (f: Replay | ((r: Replay) => Replay)) => void }) {
  const bars = useMemo(() => histogram({ messages, work }, from, to, SLICES), [messages, work, Math.floor(from / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = Math.max(1, ...bars.map((b) => b.work));
  const topM = Math.max(1, ...bars.map((b) => b.messages));
  const area = useRef<HTMLDivElement>(null);
  const seek = (x: number) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    setReplay((p) => ({ at: from + Math.max(0, Math.min(1, (x - r.left) / r.width)) * (to - from), speed: p?.speed ?? 30, playing: p?.playing ?? false }));
  };
  const button = (on: boolean) => cn("rounded-md px-2 py-1 font-medium transition-colors", on ? "bg-canvas text-ink shadow-sm dark:bg-white/10" : "text-ink-3 hover:text-ink-2");
  return (
    <div className="mx-6 mb-3 flex h-14 shrink-0 items-center gap-3 rounded-2xl border border-line bg-canvas px-3 shadow-sm">
      <button
        aria-label={replay?.playing ? "Pause" : "Play from here"}
        onClick={() => setReplay((r) => (r ? { ...r, playing: !r.playing } : { at: from, speed: 30, playing: true }))}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-line text-ink transition-colors hover:bg-line-strong"
      >
        {replay?.playing ? <PauseLinearIcon size={15} /> : <PlayLinearIcon size={15} />}
      </button>
      <div className="flex shrink-0 rounded-lg bg-line p-0.5 text-[11px]" role="radiogroup" aria-label="Replay speed">
        {SPEEDS.map((s) => (
          <button key={s} role="radio" aria-checked={replay?.speed === s} className={button(replay?.speed === s)} onClick={() => setReplay((r) => ({ at: r?.at ?? from, speed: s, playing: true }))}>
            {s}×
          </button>
        ))}
      </div>
      <div className="flex shrink-0 rounded-lg bg-line p-0.5 text-[11px]" role="radiogroup" aria-label="Period">
        {PERIODS.map((h) => (
          <button key={h} role="radio" aria-checked={hours === h} className={button(hours === h)} onClick={() => setHours(h)}>
            {h} h
          </button>
        ))}
      </div>
      <div
        ref={area}
        role="slider"
        aria-label="Timeline"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={at}
        tabIndex={0}
        className="relative flex h-10 min-w-0 flex-1 cursor-ew-resize touch-none items-end gap-px"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(e.clientX);
        }}
        onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}
      >
        {bars.map((b, i) => (
          <span key={i} className="relative h-full min-w-0 flex-1">
            <span className="absolute inset-x-0 bottom-0 rounded-[1px] bg-line-strong" style={{ height: `${(b.work / top) * 100}%` }} />
            <span className="absolute inset-x-0 bottom-0 rounded-[1px] bg-brand-500" style={{ height: `${(b.messages / topM) * 100}%` }} />
          </span>
        ))}
        <span className="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-ink shadow-[0_0_8px_rgb(255_255_255/0.5)]" style={{ left: `${Math.max(0, Math.min(100, ((at - from) / (to - from)) * 100))}%` }} />
      </div>
      <span className="w-[52px] shrink-0 text-right text-xs text-ink-2 tabular">{replay ? `-${ago(at, to)}` : new Date(at).toTimeString().slice(0, 5)}</span>
      <button
        onClick={() => setReplay(null)}
        aria-pressed={!replay}
        title={replay ? "Back to what is happening now" : "Showing what is happening now"}
        className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold tracking-wider transition-colors", replay ? "bg-line text-ink-3 hover:text-ink" : "bg-red-500/15 text-red-500 dark:text-red-400")}
      >
        <span className={cn("size-1.5 rounded-full", replay ? "bg-ink-3" : "bg-red-500 motion-safe:animate-pulse")} />
        LIVE
      </button>
    </div>
  );
}
