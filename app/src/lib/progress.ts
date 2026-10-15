import type { AdmiralSession } from "./types";

// Progress of a long turn (docs/CONTRACT.md, turn.progress). Claude reports a percent weighted
// by effort; the time left is measured from how fast that percent moves, never asked of
// Claude. A trial set these rules: before 20 % the pace is the quick reading and planning,
// and from 85 % Claude tends to jump straight to 100, so minutes there mislead.

/** Shown once a turn has run this long. */
export const SHOW_AFTER_MS = 10_000;
const PACE_FROM = 20;
const PACE_MIN_SPAN_MS = 15_000;
const FINISHING_FROM = 85;
/** A report this old (or 3× the usual gap) is stale: the ETA goes, the age shows. */
const STALE_MIN_MS = 120_000;

export type Report = { percent: number; step?: string; at: number };

export type ProgressView = {
  /** "2m 14s": how long this turn has run. */
  elapsed: string;
  /** Claude's last report (or the task list's share done), 0–100. */
  percent?: number;
  /** `percent` comes from Claude's reports. */
  reported?: boolean;
  /** A task list in play: done of total. */
  steps?: { done: number; total: number };
  /** What it is doing now. */
  step?: string;
  /** "estimating…", "≈ 4 min", "4–9 min", "< 1 min", "finishing up". */
  eta?: string;
  /** "last update 3m ago", instead of an ETA, when the reports stopped. */
  stale?: string;
};

export function formatElapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function minutes(m: number) {
  if (m < 1) return "< 1 min";
  if (m < 10) return `≈ ${Math.round(m)} min`;
  if (m < 20) return `≈ ${Math.round(m / 5) * 5} min`;
  return "20+ min";
}

function range(lo: number, hi: number) {
  const a = Math.max(1, Math.round(lo));
  const b = Math.max(a + 1, Math.round(hi));
  return b >= 20 ? `${a}+ min` : `${a}–${b} min`;
}

/** Points per minute between two reports. */
const pace = (a: Report, b: Report) => (b.percent - a.percent) / ((b.at - a.at) / 60_000);

/** What is left, from the reports so far: an ETA, or why there is none yet. */
export function estimate(reports: Report[], now: number): Pick<ProgressView, "eta" | "stale"> {
  const last = reports.at(-1);
  if (!last) return {};
  const gaps = reports.slice(1).map((r, i) => r.at - reports[i].at).sort((a, b) => a - b);
  const usualGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  if (now - last.at > Math.max(STALE_MIN_MS, 3 * usualGap)) return { stale: `last update ${formatElapsed(now - last.at).split(" ")[0]} ago` };
  if (last.percent >= FINISHING_FROM) return { eta: "finishing up" };
  const later = reports.filter((r) => r.percent >= PACE_FROM);
  if (later.length < 2 || later.at(-1)!.at - later[0].at < PACE_MIN_SPAN_MS) return { eta: "estimating…" };
  const overall = pace(later[0], later.at(-1)!);
  const recentFrom = later[Math.max(0, later.length - 3)];
  const recent = recentFrom === later.at(-1) ? overall : pace(recentFrom, later.at(-1)!);
  const rate = 0.6 * recent + 0.4 * overall;
  if (!(rate > 0)) return { eta: "estimating…" };
  // Counts down between reports.
  const left = Math.max(0, (100 - last.percent) / rate - (now - last.at) / 60_000);
  if (left < 1) return { eta: "< 1 min" };
  const spread = Math.abs(recent - overall) / Math.max(overall, recent);
  return { eta: spread > 0.35 ? range(left * 0.7, left * 1.4) : minutes(left) };
}

/** The progress line for a session's running turn, or nothing for a quick or idle one. */
export function progressOf(s: AdmiralSession | undefined, now = Date.now()): ProgressView | undefined {
  const turn = s?.turn;
  if (!s || !turn || (s.status !== "working" && s.status !== "waiting")) return undefined;
  if (now - turn.startedAt < SHOW_AFTER_MS) return undefined;
  const view: ProgressView = { elapsed: formatElapsed(now - turn.startedAt) };
  const tasks = s.tasks ?? [];
  const done = tasks.filter((t) => t.status === "completed").length;
  if (tasks.length > 1 && done < tasks.length) {
    view.steps = { done, total: tasks.length };
    const active = tasks.find((t) => t.status === "in_progress");
    if (active) view.step = active.activeForm || active.subject;
  }
  // Only this turn's reports: an earlier turn's pace says nothing about this one.
  const reports = (turn.progress ?? []).filter((r) => r.at >= turn.startedAt);
  const last = reports.at(-1);
  if (last) {
    view.percent = last.percent;
    view.reported = true;
    if (last.step) view.step = last.step;
    Object.assign(view, estimate(reports, now));
  } else if (view.steps) {
    view.percent = (done / view.steps.total) * 100;
  }
  return view;
}

/** One line for the menu bar and tooltips: "43% · ≈ 4 min", "3/7 · 2m 14s", "2m 14s". */
export function progressLabel(v: ProgressView) {
  const head = v.reported ? `${Math.round(v.percent!)}%` : v.steps ? `${v.steps.done}/${v.steps.total}` : undefined;
  const tail = v.eta && v.eta !== "estimating…" ? v.eta : v.elapsed;
  return head ? `${head} · ${tail}` : tail;
}
