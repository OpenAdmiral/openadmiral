import { estimate, formatElapsed, type Report } from "./progress";

// Background shell commands (docs/CONTRACT.md, jobs): their progress is measured from their
// own output, not reported by Claude. The output's last lines say how far along it is
// ("118/240", "45%"), and how often it grows says whether it has stalled.

export type Job = { id: string; label?: string; output?: string; startedAt: number; endedAt?: number; status: "running" | "completed" | "failed" | "killed"; exitCode?: number };
export type Tail = { path: string; size: number; modifiedAt: number; tail: string };

/** What a command's output says about its progress. */
export type Parsed = { percent?: number; done?: number; total?: number; line?: string };

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strips colour codes and keeps what a terminal would show last: \r rewrites the line. */
export function screenLines(text: string): string[] {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.split("\r").filter((p) => p.trim()).at(-1) ?? "")
    .map((l) => l.trim())
    .filter(Boolean);
}

// "118/240", "[ 3/12]", "Building [====>  ] 210/450": not a date (2026/10/15) nor a path.
const COUNT = /(?<![\d/.:-])(\d{1,7})\s*\/\s*(\d{1,7})(?![\d/.-])/g;
// "45%", "45.5 %", "[ 45%]": not inside a longer number.
const PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s?%/g;

/** The newest progress in the output: the last line that has a count or a percent. */
export function parseOutput(text: string): Parsed {
  const lines = screenLines(text).slice(-40);
  const line = lines.at(-1);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const counts = [...l.matchAll(COUNT)].map((m) => [Number(m[1]), Number(m[2])] as const).filter(([d, t]) => t >= 2 && d <= t);
    const percents = [...l.matchAll(PERCENT)].map((m) => Number(m[1])).filter((p) => p <= 100);
    if (counts.length) {
      const [done, total] = counts.at(-1)!;
      return { done, total, percent: (done / total) * 100, line };
    }
    if (percents.length) return { percent: percents.at(-1), line };
  }
  return { line };
}

/** What the app has seen of a job across polls: its readings and when its output last grew. */
export type Seen = { reports: Report[]; grewAt: number[]; size: number };

/** Records one poll: a reading when the percent moved, and the time when the output grew. */
export function observe(seen: Seen | undefined, tail: Tail, parsed: Parsed, now: number): Seen {
  const s: Seen = seen ?? { reports: [], grewAt: [], size: -1 };
  const grew = tail.size !== s.size;
  const last = s.reports.at(-1);
  const reports = parsed.percent !== undefined && parsed.percent !== last?.percent ? [...s.reports, { percent: parsed.percent, at: now }].slice(-30) : s.reports;
  return { reports, grewAt: grew ? [...s.grewAt, tail.modifiedAt || now].slice(-30) : s.grewAt, size: tail.size };
}

const STALL_MIN_MS = 120_000;

export type JobView = {
  id: string;
  label: string;
  elapsed: string;
  percent?: number;
  /** "118/240" */
  count?: string;
  line?: string;
  eta?: string;
  /** "no output for 4m": quiet far longer than it usually is. */
  stalled?: string;
  failed?: string;
};

/** One row for a running (or just failed) background command. */
export function jobView(job: Job, parsed: Parsed | undefined, seen: Seen | undefined, now: number): JobView {
  const v: JobView = { id: job.id, label: job.label || "Background command", elapsed: formatElapsed((job.endedAt ?? now) - job.startedAt), line: parsed?.line };
  if (job.status === "failed" || job.status === "killed") {
    v.failed = job.status === "killed" ? "stopped" : `failed${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ""}`;
    return v;
  }
  if (parsed?.percent !== undefined) v.percent = parsed.percent;
  if (parsed?.total !== undefined) v.count = `${parsed.done}/${parsed.total}`;
  const grew = seen?.grewAt ?? [];
  const lastGrew = grew.at(-1);
  if (lastGrew) {
    // Quiet for longer than 5× its usual gap between writes (and 2 min at least).
    const gaps = grew.slice(1).map((t, i) => t - grew[i]).sort((a, b) => a - b);
    const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    if (now - lastGrew > Math.max(STALL_MIN_MS, 5 * usual)) v.stalled = `no output for ${formatElapsed(now - lastGrew).split(" ")[0]}`;
  }
  if (!v.stalled && seen && seen.reports.length >= 2) {
    // A measured percent: its pace is the command's own, so the plain rule applies from the start.
    const e = estimate(seen.reports, now, { paceFrom: 0, finishingFrom: 101 });
    if (e.eta && e.eta !== "estimating…") v.eta = e.eta;
  }
  return v;
}
