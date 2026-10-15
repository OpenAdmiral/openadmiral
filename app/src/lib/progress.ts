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
  /** Waiting for the person: the clock runs, the ETA pauses. */
  paused?: boolean;
  /** The main turn is over and subagents work on: how many. */
  agents?: number;
  /** The ETA comes from how long this project's turns usually take, not from reports. */
  usual?: boolean;
  /** Already longer than nearly all of this project's turns. */
  long?: boolean;
};

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/**
 * Time left from this project's past turns (their durations, in ms), given how long this
 * one has run: among the turns that lasted at least this long, how much longer they went.
 */
export function usualEta(history: number[] | undefined, elapsedMs: number): { eta?: string; long?: boolean } {
  if (!history || history.length < 10) return {};
  const longer = history.filter((d) => d > elapsedMs).sort((a, b) => a - b);
  if (longer.length < 5) return longer.length / history.length < 0.05 ? { long: true } : {};
  const [lo, mid, hi] = [0.25, 0.5, 0.75].map((q) => (quantile(longer, q) - elapsedMs) / 60_000);
  if (hi < 1) return { eta: "< 1 min" };
  return { eta: hi / Math.max(lo, 0.5) > 2.5 ? range(lo, hi) : minutes(mid) };
}

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
export function estimate(reports: Report[], now: number, { paceFrom = PACE_FROM, finishingFrom = FINISHING_FROM } = {}): Pick<ProgressView, "eta" | "stale"> {
  const last = reports.at(-1);
  if (!last) return {};
  const gaps = reports.slice(1).map((r, i) => r.at - reports[i].at).sort((a, b) => a - b);
  const usualGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  if (now - last.at > Math.max(STALE_MIN_MS, 3 * usualGap)) return { stale: `last update ${formatElapsed(now - last.at).split(" ")[0]} ago` };
  if (last.percent >= finishingFrom) return { eta: "finishing up" };
  const later = reports.filter((r) => r.percent >= paceFrom);
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
export function progressOf(s: AdmiralSession | undefined, now = Date.now(), history?: number[]): ProgressView | undefined {
  const turn = s?.turn;
  if (!s || s.status === "ended") return undefined;
  if (!turn || (s.status !== "working" && s.status !== "waiting")) return agentsOf(s, now);
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
  if (!view.eta && !view.stale && !view.reported) {
    // Nothing measured yet: how long this project's turns usually run on from here.
    const u = usualEta(history, now - turn.startedAt);
    if (u.eta) Object.assign(view, { eta: u.eta, usual: true });
    if (u.long) view.long = true;
  } else if (view.eta === "estimating…") {
    const u = usualEta(history, now - turn.startedAt);
    if (u.eta) Object.assign(view, { eta: u.eta, usual: true });
  }
  if (s.status === "waiting") {
    // Its time waiting for the person says nothing about the work left.
    view.paused = true;
    delete view.eta;
    delete view.stale;
  }
  return view;
}

/**
 * Subagents still at work after the main turn ended (backgrounded agents): how long the
 * batch has run and, from their own reports, how far along the slowest one is.
 */
function agentsOf(s: AdmiralSession, now: number): ProgressView | undefined {
  const running = (s.subagents ?? []).filter((a) => a.status === "running");
  if (!running.length) return undefined;
  const since = Math.min(...running.map((a) => a.startedAt));
  if (now - since < SHOW_AFTER_MS) return undefined;
  const view: ProgressView = { elapsed: formatElapsed(now - since), agents: running.length };
  const reporting = running.filter((a) => a.progress?.length);
  const slowest = reporting.sort((a, b) => a.progress!.at(-1)!.percent - b.progress!.at(-1)!.percent)[0];
  const lead = slowest ?? running[0];
  view.step = slowest?.progress!.at(-1)!.step ?? lead.description;
  if (slowest) {
    view.percent = slowest.progress!.at(-1)!.percent;
    view.reported = true;
    Object.assign(view, estimate(slowest.progress!, now));
  }
  return view;
}

/** How long ago a finished turn stays worth a line on the card. */
const LAST_TURN_SHOWN_MS = 6 * 60 * 60_000;

/** How the last long turn ended, until the next prompt: "Done in 9m 41s", "Stopped at 43% after 9m 41s". */
export function lastTurnOf(s: AdmiralSession | undefined, now = Date.now()): { text: string; stopped: boolean } | undefined {
  const t = s?.lastTurn;
  if (!s || !t || s.turn || s.status !== "idle" || now - t.endedAt > LAST_TURN_SHOWN_MS) return undefined;
  const took = formatElapsed(t.endedAt - t.startedAt);
  if (t.percent === undefined || t.percent >= 100) return { text: `Done in ${took}`, stopped: false };
  return { text: `Stopped at ${t.percent}% after ${took}${t.step ? ` · ${t.step}` : ""}`, stopped: true };
}

/** One line for the menu bar and tooltips: "43% · ≈ 4 min", "3/7 · 2m 14s", "2m 14s". */
export function progressLabel(v: ProgressView) {
  const head = v.reported ? `${Math.round(v.percent!)}%` : v.steps ? `${v.steps.done}/${v.steps.total}` : undefined;
  const tail = v.paused ? "needs you" : v.eta && v.eta !== "estimating…" ? v.eta : v.elapsed;
  return head ? `${head} · ${tail}` : tail;
}
