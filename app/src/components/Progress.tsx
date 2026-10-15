import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { jobView, observe, parseOutput, type Job, type JobView, type Parsed, type Seen, type Tail } from "../lib/jobs";
import { estimate, formatElapsed, lastTurnOf, progressOf, type ProgressView } from "../lib/progress";
import type { AdmiralSession } from "../lib/types";
import { cn } from "../lib/utils";
import { Meter } from "./primitives";
import { useNow } from "./QueueBits";

/** A running command whose output has not grown for this long is taken as gone. */
const GONE_AFTER_MS = 30 * 60_000;

const runningJobs = (s: AdmiralSession | undefined) => (s?.jobs ?? []).filter((j) => j.status === "running" && j.output);

/** A turn runs, backgrounded subagents work on after it, or a background command runs. */
const working = (s: AdmiralSession | undefined) =>
  !!s &&
  s.status !== "ended" &&
  ((!!s.turn && (s.status === "working" || s.status === "waiting")) || !!s.subagents?.some((a) => a.status === "running") || runningJobs(s).length > 0);

/** What it is doing: the step, with how many subagents carry it once the main turn is over. */
const doing = (v: ProgressView) => (v.agents ? `${v.agents === 1 ? "1 agent" : `${v.agents} agents`} · ${v.step ?? "working"}` : (v.step ?? "Working"));

/** "43%", "3/7", or nothing. */
const share = (v: ProgressView) => (v.reported ? `${Math.round(v.percent!)}%` : v.steps ? `${v.steps.done}/${v.steps.total}` : undefined);
/** "≈ 4 min left", "usually ≈ 4 min left", "finishing up", "estimating…", "last update 3m ago", "longer than usual". */
const timing = (v: ProgressView) =>
  v.stale ?? (v.eta ? `${v.usual ? "usually " : ""}${/min$/.test(v.eta) ? `${v.eta} left` : v.eta}` : v.long ? "longer than usual" : undefined);

// ---- what the app measures itself, shared by every card and panel ----

/** How long each project's turns took, refreshed every few minutes. */
const histories = new Map<string, { at: number; durations: number[] }>();
const HISTORY_TTL_MS = 3 * 60_000;

function useHistory(cwd: string | undefined, now: number) {
  const [, bump] = useState(0);
  const hit = cwd ? histories.get(cwd) : undefined;
  const stale = !!cwd && (!hit || now - hit.at > HISTORY_TTL_MS);
  useEffect(() => {
    if (!stale || !cwd) return;
    histories.set(cwd, { at: Date.now(), durations: histories.get(cwd)?.durations ?? [] });
    invoke<number[]>("turn_history", { cwd })
      .then((durations) => {
        histories.set(cwd, { at: Date.now(), durations });
        bump((n) => n + 1);
      })
      .catch(() => {});
  }, [stale, cwd]);
  return hit?.durations;
}

/** What each background command's output said, and how it moved across polls. */
const measured = new Map<string, { parsed: Parsed; seen: Seen }>();

function useJobs(session: AdmiralSession | undefined, now: number): JobView[] {
  const [, bump] = useState(0);
  const key = runningJobs(session).map((j) => j.output).join("\n");
  // A poll every 2 s while any runs (the clock ticks every second).
  const tick = Math.floor(now / 2000);
  useEffect(() => {
    if (!key) return;
    invoke<Tail[]>("job_tails", { paths: key.split("\n") })
      .then((tails) => {
        const at = Date.now();
        for (const t of tails) {
          const parsed = parseOutput(t.tail);
          measured.set(t.path, { parsed, seen: observe(measured.get(t.path)?.seen, t, parsed, at) });
        }
        bump((n) => n + 1);
      })
      .catch(() => {});
  }, [key, tick]);
  const recentFailure = (j: Job) => (j.status === "failed" || j.status === "killed") && !!j.endedAt && now - j.endedAt < 10 * 60_000;
  // Its end never reached the session (a session that quit, say): silent this long, it is gone.
  const gone = (j: Job) => {
    const grew = j.output ? measured.get(j.output)?.seen.grewAt.at(-1) : undefined;
    return grew !== undefined && now - grew > GONE_AFTER_MS;
  };
  return (session?.jobs ?? [])
    .filter((j) => (j.status === "running" && j.output && !gone(j)) || recentFailure(j))
    .map((j) => {
      const m = j.output ? measured.get(j.output) : undefined;
      return jobView(j, m?.parsed, m?.seen, now);
    });
}

const jobTiming = (j: JobView) =>
  j.failed ?? j.stalled ?? [j.count ?? (j.percent !== undefined ? `${Math.round(j.percent)}%` : undefined), j.eta ? `${j.eta} left` : j.elapsed].filter(Boolean).join(" · ");

// ---- the sidebar card's line ----

/** A sidebar card's progress line; once idle, how the last long turn ended. Ticks every second. */
export function ProgressLine({ session, className }: { session: AdmiralSession | undefined; className?: string }) {
  // Mounted only while something runs, so idle cards do not tick.
  if (!working(session)) return <LastTurn session={session} className={className} />;
  return <CardTicking session={session!} className={className} />;
}

function CardTicking({ session, className }: { session: AdmiralSession; className?: string }) {
  const now = useNow(1000);
  const history = useHistory(session.cwd, now);
  const jobs = useJobs(session, now);
  const v = progressOf(session, now, history);
  // A command's measured progress says more than the bare clock of an unreported turn.
  const measuredJob = jobs.find((j) => j.percent !== undefined || j.stalled || j.failed);
  if (v && (v.percent !== undefined || !measuredJob)) return <Compact v={v} className={className} />;
  const job = measuredJob ?? jobs[0];
  return job ? <CompactJob job={job} className={className} /> : null;
}

function Compact({ v, className }: { v: ProgressView; className?: string }) {
  const t = v.paused || v.eta === "estimating…" ? undefined : timing(v);
  return (
    <span className={cn("relative flex flex-col gap-1 pl-[18px]", className)} title={`Working for ${v.elapsed}${v.eta ? ` · ${v.eta}` : ""}`}>
      <span className="flex items-center gap-2 text-[11px] text-ink-3">
        <span className="flex-1 truncate">{doing(v)}</span>
        <span className={cn("shrink-0 tabular", (v.stale || v.long) && "text-amber-700 dark:text-amber-300")}>{[share(v), t ?? v.elapsed].filter(Boolean).join(" · ")}</span>
      </span>
      {v.percent !== undefined && <Meter value={v.percent} tone="brand" className={cn(v.stale && "opacity-50")} />}
    </span>
  );
}

function CompactJob({ job, className }: { job: JobView; className?: string }) {
  return (
    <span className={cn("relative flex flex-col gap-1 pl-[18px]", className)} title={job.line}>
      <span className="flex items-center gap-2 text-[11px] text-ink-3">
        <span className="flex-1 truncate">{job.label}</span>
        <span className={cn("shrink-0 tabular", (job.stalled || job.failed) && "text-amber-700 dark:text-amber-300")}>{jobTiming(job)}</span>
      </span>
      {job.percent !== undefined && <Meter value={job.percent} tone="brand" className={cn(job.stalled && "opacity-50")} />}
    </span>
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

// ---- the inspector's Tasks block: what it is doing now ----

/** Whether the Tasks block has something to show above the sub-tasks. */
export const hasNow = (s: AdmiralSession | undefined) => working(s) || !!lastTurnOf(s);

/** The main work at the top of Tasks: the step, the bar and the time, then commands and subagents. */
export function NowPanel({ session }: { session: AdmiralSession | undefined }) {
  if (!working(session)) {
    const t = lastTurnOf(session);
    return t ? <p className={cn("px-1 text-xs", t.stopped ? "text-amber-700 dark:text-amber-300" : "text-ink-3")}>{t.text}</p> : null;
  }
  return <NowTicking session={session!} />;
}

function NowTicking({ session }: { session: AdmiralSession }) {
  const now = useNow(1000);
  const history = useHistory(session.cwd, now);
  const jobs = useJobs(session, now);
  const v = progressOf(session, now, history);
  const agents = (session.subagents ?? []).filter((a) => a.status === "running");
  return (
    <div className="flex flex-col gap-3 px-1">
      {v && !v.agents && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 text-xs">
            {share(v) && <span className="font-semibold text-ink tabular">{share(v)}</span>}
            <span className="min-w-0 flex-1 truncate font-medium text-ink" title={doing(v)}>
              {doing(v)}
            </span>
            {v.percent === undefined && !v.paused && !timing(v) && <span className="shrink-0 text-[11px] text-ink-3 tabular">{v.elapsed}</span>}
          </div>
          {v.percent !== undefined && <Meter value={v.percent} tone="brand" className={cn("h-1.5", v.stale && "opacity-50")} />}
          {v.percent !== undefined || v.paused || timing(v) ? (
            <div className="flex items-center gap-2 text-[11px] text-ink-3 tabular">
              <span className={cn("flex-1", (v.stale || v.long) && "text-amber-700 dark:text-amber-300")}>{v.paused ? "Waiting for you" : (timing(v) ?? "")}</span>
              <span>{v.elapsed}</span>
            </div>
          ) : null}
        </div>
      )}
      {jobs.map((j) => (
        <Row key={j.id} kind="Command" label={j.label} percent={j.percent} right={jobTiming(j)} detail={j.line} warn={!!(j.stalled || j.failed)} />
      ))}
      {agents.map((a) => {
        const last = a.progress?.at(-1);
        const e = a.progress?.length ? estimate(a.progress, now) : {};
        const left = e.eta && e.eta !== "estimating…" ? (/min$/.test(e.eta) ? `${e.eta} left` : e.eta) : formatElapsed(now - a.startedAt);
        return <Row key={a.id} kind="Agent" label={a.description ?? a.type ?? "Subagent"} percent={last?.percent} right={[last && `${last.percent}%`, left].filter(Boolean).join(" · ")} detail={last?.step} />;
      })}
    </div>
  );
}

function Row({ kind, label, percent, right, detail, warn }: { kind: string; label: string; percent?: number; right: string; detail?: string; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{kind}</span>
        <span className="min-w-0 flex-1 truncate text-ink-2" title={label}>
          {label}
        </span>
        <span className={cn("shrink-0 text-[11px] text-ink-3 tabular", warn && "text-amber-700 dark:text-amber-300")}>{right}</span>
      </div>
      {percent !== undefined && <Meter value={percent} tone="brand" />}
      {detail && <span className="truncate font-mono text-[10.5px] text-ink-3">{detail}</span>}
    </div>
  );
}
