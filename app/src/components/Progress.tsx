import { cn } from "../lib/utils";
import { lastTurnOf, progressOf, type ProgressView } from "../lib/progress";
import type { AdmiralSession } from "../lib/types";
import { Meter } from "./primitives";
import { useNow } from "./QueueBits";

/** A turn runs, or backgrounded subagents work on after it. */
const working = (s: AdmiralSession | undefined) =>
  !!s && s.status !== "ended" && ((!!s.turn && (s.status === "working" || s.status === "waiting")) || !!s.subagents?.some((a) => a.status === "running"));

/** What it is doing: the step, with how many subagents carry it once the main turn is over. */
const doing = (v: ProgressView) => (v.agents ? `${v.agents === 1 ? "1 agent" : `${v.agents} agents`} · ${v.step ?? "working"}` : (v.step ?? "Working"));

/** A long turn's progress: what it is doing, how far along, and how long is left. Ticks every second. */
export function ProgressLine({ session, large, className }: { session: AdmiralSession | undefined; large?: boolean; className?: string }) {
  // Mounted only while a turn runs, so idle cards do not tick.
  if (!working(session)) return large ? null : <LastTurn session={session} className={className} />;
  return <Ticking session={session!} large={large} className={className} />;
}

function Ticking({ session, large, className }: { session: AdmiralSession; large?: boolean; className?: string }) {
  const now = useNow(1000);
  const v = progressOf(session, now);
  if (!v) return null;
  return large ? <Large v={v} className={className} /> : <Compact v={v} className={className} />;
}

/** "43%", "3/7", or nothing. */
const share = (v: ProgressView) => (v.reported ? `${Math.round(v.percent!)}%` : v.steps ? `${v.steps.done}/${v.steps.total}` : undefined);
/** "≈ 4 min left", "finishing up", "estimating…" or "last update 3m ago", if any. */
const timing = (v: ProgressView) => v.stale ?? (v.eta && (/min$/.test(v.eta) ? `${v.eta} left` : v.eta));

function Compact({ v, className }: { v: ProgressView; className?: string }) {
  const head = share(v);
  return (
    <span className={cn("relative flex flex-col gap-1 pl-[18px]", className)} title={`Working for ${v.elapsed}${v.eta ? ` · ${v.eta}` : ""}`}>
      <span className="flex items-center gap-2 text-[11px] text-ink-3">
        <span className="flex-1 truncate">{doing(v)}</span>
        <span className={cn("shrink-0 tabular", v.stale && "text-amber-700 dark:text-amber-300")}>{head ? `${head} · ${v.eta === "estimating…" ? v.elapsed : (timing(v) ?? v.elapsed)}` : v.elapsed}</span>
      </span>
      {v.percent !== undefined && <Meter value={v.percent} tone="brand" className={cn(v.stale && "opacity-50")} />}
    </span>
  );
}

function Large({ v, className }: { v: ProgressView; className?: string }) {
  const head = share(v);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline gap-2 text-sm">
        {head && <span className="font-semibold text-ink tabular">{head}</span>}
        <span className="min-w-0 flex-1 truncate text-ink-2">{doing(v)}</span>
        <span className={cn("shrink-0 text-ink-3 tabular", v.stale && "text-amber-700 dark:text-amber-300")}>
          {timing(v) ? `${timing(v)} · ` : ""}
          {v.elapsed}
        </span>
      </div>
      {v.percent !== undefined && <Meter value={v.percent} tone="brand" className={cn("h-1.5", v.stale && "opacity-50")} />}
    </div>
  );
}

/** How the last long turn ended, until the next prompt: done, or where it stopped short. */
function LastTurn({ session, className }: { session: AdmiralSession | undefined; className?: string }) {
  const t = lastTurnOf(session);
  if (!t) return null;
  return (
    <span className={cn("relative truncate pl-[18px] text-[11px]", t.stopped ? "text-amber-700 dark:text-amber-300" : "text-ink-3", className)} title={t.text}>
      {t.text}
    </span>
  );
}
