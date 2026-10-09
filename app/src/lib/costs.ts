import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Agent } from "./types";
import { modelLabel } from "./utils";

/** One day of one project as ccusage reports it. */
type CcRow = {
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
type CcReport = { fetchedAt: number; data: { projects?: Record<string, CcRow[]>; daily?: CcRow[] } };

const DAYS = 90;
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
      setReport(await invoke<CcReport>("costs_refresh", { days: DAYS }));
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
export type ProjectCost = {
  name: string;
  today: number;
  d7: number;
  d30: number;
  tokens30: number;
  topModel?: string;
  series: number[]; // last 30 days, oldest first
};

export type Costs = {
  days: DayCost[]; // last 30 days, oldest first, gaps filled with zero
  projects: ProjectCost[]; // by 30-day cost, highest first
  models: string[]; // by 30-day cost, highest first
  today: number;
  last7: number;
  month: number;
  monthProjection: number;
  dailyAvg30: number;
  total30: number;
};

export function useCosts(report: CcReport | null, agents: Agent[]): Costs | null {
  return useMemo(() => {
    if (!report?.data) return null;
    // Projects OpenAdmiral knows by name, keyed the way ccusage escapes their folders.
    const known = new Map<string, string>();
    for (const a of agents) {
      known.set(escapePath(a.cwd), a.project);
      if (a.session?.repo?.root) known.set(escapePath(a.session.repo.root), a.project);
    }

    const rowsByProject: Record<string, CcRow[]> = report.data.projects ?? { all: report.data.daily ?? [] };
    const today = localDate(new Date());
    const dates: string[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(localDate(d));
    }
    const idx = new Map(dates.map((d, i) => [d, i]));
    const days: DayCost[] = dates.map((date) => ({ date, total: 0, byProject: {}, byModel: {} }));
    const projects = new Map<string, ProjectCost & { models: Record<string, number> }>();
    const modelTotals: Record<string, number> = {};
    const weekStart = dates[23];
    const monthPrefix = today.slice(0, 7);
    let month = 0;

    for (const [key, rows] of Object.entries(rowsByProject)) {
      const name = friendlyProject(key, known);
      const p = projects.get(name) ?? { name, today: 0, d7: 0, d30: 0, tokens30: 0, series: dates.map(() => 0), models: {} };
      projects.set(name, p);
      for (const r of rows) {
        const date = r.date ?? r.period ?? "";
        if (date.startsWith(monthPrefix)) month += r.totalCost;
        const i = idx.get(date);
        if (i === undefined) continue;
        p.d30 += r.totalCost;
        p.tokens30 += r.totalTokens;
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
      .filter((p) => p.d30 > 0)
      .map(({ models, ...p }) => ({ ...p, topModel: Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] }))
      .sort((a, b) => b.d30 - a.d30);
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const total30 = days.reduce((s, d) => s + d.total, 0);
    return {
      days,
      projects: list,
      models: Object.entries(modelTotals).sort((a, b) => b[1] - a[1]).map(([m]) => m),
      today: days[29].total,
      last7: days.slice(23).reduce((s, d) => s + d.total, 0),
      month,
      monthProjection: (month / now.getDate()) * daysInMonth,
      dailyAvg30: total30 / 30,
      total30,
    };
  }, [report, agents]);
}

export function money(n: number, precise = false) {
  if (precise || n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
