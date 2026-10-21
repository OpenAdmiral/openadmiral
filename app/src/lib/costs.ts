import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./types";
import { modelLabel } from "./utils";

/** One day of one project as ccusage reports it. */
export type CcRow = {
  date?: string;
  period?: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelBreakdowns?: { modelName: string; cost: number }[];
};
export type CcReport = { fetchedAt: number; data: { projects?: Record<string, CcRow[]>; daily?: CcRow[] } };

const ALL_TIME = 0; // costs_refresh: 0 days means no --since, the whole history
const REFRESH_MS = 5 * 60_000;

/** Fetches ccusage through the app: the cached report first, then fresh every 5 min and on focus. */
export function useCostReport() {
  const [report, setReport] = useState<CcReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      setReport(await invoke<CcReport>("costs_refresh", { days: ALL_TIME }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    invoke<CcReport | null>("costs_cached")
      .then((cached) => {
        if (cached?.data) setReport(cached);
        if (!cached || Date.now() - cached.fetchedAt > REFRESH_MS) refresh();
      })
      .catch(() => refresh());
    const every = setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(every);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { report, loading, error, refresh };
}

/**
 * How long Claude Code keeps session transcripts (its `cleanupPeriodDays`), in days.
 * Costs are read from those transcripts, so this bounds how far back history can reach.
 * `set` asks the backend to raise it; call it only after the person confirmed.
 */
export function useRetention() {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    invoke<number>("retention_get").then(setDays).catch(() => {});
  }, []);
  const set = useCallback(async (d: number) => {
    setDays(await invoke<number>("retention_set", { days: d }));
  }, []);
  return { days, set };
}

/** How ccusage names a project directory: every non-alphanumeric becomes '-'. */
export const escapePath = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

/** A ccusage project key to the name OpenAdmiral uses: a known session's project, else the path's tail. */
export function friendlyProject(key: string, known: Map<string, string>) {
  const hit = known.get(key);
  if (hit) return hit;
  const tail = key.replace(/^-Users-[^-]+-/, "").replace(/^(dev|code|src|projects|repos)-/, "");
  return tail || key;
}

export const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export type DayCost = { date: string; total: number; byProject: Record<string, number>; byModel: Record<string, number> };
export type RangeDays = 30 | 60 | 90 | 0; // 0 = all time
export type ProjectCost = {
  name: string;
  today: number;
  d7: number;
  inRange: number; // cost within the selected range
  tokensInRange: number;
  total: number; // all-time cost, whatever the range
  topModel?: string;
  series: number[]; // the selected range, oldest first
};

export type Costs = {
  days: DayCost[]; // the selected range, oldest first, gaps filled with zero
  rangeDays: number; // how many days the range resolved to (all time reaches the first recorded day)
  allTime: boolean;
  projects: ProjectCost[]; // by in-range cost, highest first
  models: string[]; // by in-range cost, highest first
  today: number;
  last7: number;
  month: number;
  monthProjection: number;
  dailyAvg: number; // over the range
  rangeTotal: number;
};

export function useCosts(report: CcReport | null, agents: Agent[], range: RangeDays = 30): Costs | null {
  return useMemo(() => computeCosts(report, agents, range), [report, agents, range]);
}

/** The whole Costs view's numbers from a ccusage report; `now` is injectable for tests. */
export function computeCosts(report: CcReport | null, agents: Agent[], range: RangeDays = 30, now: Date = new Date()): Costs | null {
  if (!report?.data) return null;
  // Projects OpenAdmiral knows by name, keyed the way ccusage escapes their folders.
  const known = new Map<string, string>();
  for (const a of agents) {
    known.set(escapePath(a.cwd), a.project);
    if (a.session?.repo?.root) known.set(escapePath(a.session.repo.root), a.project);
  }

  const rowsByProject: Record<string, CcRow[]> = report.data.projects ?? { all: report.data.daily ?? [] };
  const today = localDate(now);

  // All time reaches back to the first recorded day, never under 30.
  let span: number = range;
  if (range === 0) {
    let first = today;
    for (const rows of Object.values(rowsByProject))
      for (const r of rows) {
        const d = r.date ?? r.period ?? "";
        if (d && d < first) first = d;
      }
    span = Math.max(30, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000) + 1);
  }

  const dates: string[] = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(localDate(d));
  }
  const idx = new Map(dates.map((d, i) => [d, i]));
  const days: DayCost[] = dates.map((date) => ({ date, total: 0, byProject: {}, byModel: {} }));
  const projects = new Map<string, ProjectCost & { models: Record<string, number> }>();
  const modelTotals: Record<string, number> = {};
  const weekStart = dates[dates.length - 7];
  const monthPrefix = today.slice(0, 7);
  let month = 0;

  for (const [key, rows] of Object.entries(rowsByProject)) {
    const name = friendlyProject(key, known);
    const p = projects.get(name) ?? { name, today: 0, d7: 0, inRange: 0, tokensInRange: 0, total: 0, series: dates.map(() => 0), models: {} };
    projects.set(name, p);
    for (const r of rows) {
      const date = r.date ?? r.period ?? "";
      p.total += r.totalCost;
      if (date.startsWith(monthPrefix)) month += r.totalCost;
      const i = idx.get(date);
      if (i === undefined) continue;
      p.inRange += r.totalCost;
      p.tokensInRange += r.totalTokens;
      p.series[i] += r.totalCost;
      if (date >= weekStart) p.d7 += r.totalCost;
      if (date === today) p.today += r.totalCost;
      const day = days[i];
      day.total += r.totalCost;
      day.byProject[name] = (day.byProject[name] ?? 0) + r.totalCost;
      for (const m of r.modelBreakdowns ?? []) {
        const label = modelLabel(m.modelName);
        day.byModel[label] = (day.byModel[label] ?? 0) + m.cost;
        p.models[label] = (p.models[label] ?? 0) + m.cost;
        modelTotals[label] = (modelTotals[label] ?? 0) + m.cost;
      }
    }
  }

  const list = [...projects.values()]
    .filter((p) => p.inRange > 0 || p.total > 0)
    .map(({ models, ...p }) => ({ ...p, topModel: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] }))
    .sort((a, b) => b.inRange - a.inRange || b.total - a.total);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const rangeTotal = days.reduce((s, d) => s + d.total, 0);
  return {
    days,
    rangeDays: span,
    allTime: range === 0,
    projects: list,
    models: Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).map(([m]) => m),
    today: days[days.length - 1].total,
    last7: days.slice(-7).reduce((s, d) => s + d.total, 0),
    month,
    monthProjection: (month / now.getDate()) * daysInMonth,
    dailyAvg: rangeTotal / span,
    rangeTotal,
  };
}

/** Folds `size` consecutive days into one bar, aligned so the last bucket ends on the last day. */
export function bucketDays(src: DayCost[], size: number): DayCost[] {
  if (size <= 1) return src;
  const out: DayCost[] = [];
  for (let end = src.length; end > 0; end -= size) {
    const chunk = src.slice(Math.max(0, end - size), end);
    const merged: DayCost = { date: chunk[0].date, total: 0, byProject: {}, byModel: {} };
    for (const d of chunk) {
      merged.total += d.total;
      for (const [k, v] of Object.entries(d.byProject)) merged.byProject[k] = (merged.byProject[k] ?? 0) + v;
      for (const [k, v] of Object.entries(d.byModel)) merged.byModel[k] = (merged.byModel[k] ?? 0) + v;
    }
    out.unshift(merged);
  }
  return out;
}

export function money(n: number, precise = false) {
  if (precise || n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
