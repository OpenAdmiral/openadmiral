import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...classes: ClassValue[]) {
  return twMerge(clsx(classes));
}

export function basename(path: string) {
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

/** "3s", "4m", "2h", "5d" — how long ago `at` (epoch ms) was. */
export function ago(at: number | undefined, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "in 2h 10m" until an ISO or epoch reset time. */
export function until(at: string | number | undefined, now = Date.now()) {
  if (at === undefined) return "";
  const t = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (Number.isNaN(t)) return "";
  const m = Math.round((t - now) / 60000);
  if (m <= 0) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function compact(n: number | undefined) {
  if (n === undefined) return "";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function usd(n: number | undefined) {
  if (n === undefined) return "";
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;
}

/** Model ids to what a person calls them: claude-opus-5-5[1m] → Opus 5.5. */
export function modelLabel(model: string | undefined) {
  if (!model) return "";
  const m = model.match(/(opus|sonnet|haiku|fable)[-_ ]?(\d+)(?:[-.](\d{1,2})(?!\d))?/i);
  if (!m) return model;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}${/1m/i.test(model) ? " · 1M" : ""}`;
}

/**
 * A branch's color says how careful to be on it: production (main, master) red,
 * pre-production (sandbox, quality) orange, integration (develop, dev) blue;
 * feature branches keep the text color they are drawn in.
 */
export function branchTone(branch: string | undefined) {
  switch (branch?.toLowerCase()) {
    case "main":
    case "master":
      return "text-red-600 dark:text-red-400";
    case "sandbox":
    case "quality":
      return "text-orange-600 dark:text-orange-400";
    case "develop":
    case "dev":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "";
  }
}

/**
 * Context used, as the statusline counts it: share of the window left before
 * auto-compaction (100% = Claude compacts). Older mod builds only send `percent`.
 */
export function contextUsed(ctx: { percent?: number; usablePercent?: number } | undefined) {
  return ctx?.usablePercent ?? ctx?.percent;
}

/** Fill thresholds shared by every meter: blue, then orange from 60%, red from 80%. */
export function fillTone(v: number | undefined): "ok" | "warn" | "high" {
  const x = v ?? 0;
  return x >= 80 ? "high" : x >= 60 ? "warn" : "ok";
}

/** The text color for a fill percentage (the same steps as the meters). */
export function fillText(v: number | undefined) {
  return { ok: "text-brand-600 dark:text-brand-400", warn: "text-orange-600 dark:text-orange-400", high: "text-red-600 dark:text-red-400" }[fillTone(v)];
}

/** Deterministic hue per project, so a project keeps its color everywhere. */
/**
 * A project's color, the same everywhere (sidebar, Costs, Delegations, Artifacts):
 * the n-th project in the sidebar takes the n-th chart series color. Projects past
 * the palette, or not in the sidebar, fall back to a hue from the name.
 */
const SERIES = 7;
let projectSlots = new Map<string, number>();
let projectPrefix = "";

export function setProjectOrder(names: string[]) {
  const next = new Map<string, number>();
  for (const n of names) if (!next.has(n) && next.size < SERIES) next.set(n, next.size + 1);
  projectSlots = next;
  projectPrefix = sharedPrefix(names);
}

/** The `org-` prefix every project shares (e.g. "acme-" for acme-api, acme-web), if at least two do. */
export function sharedPrefix(names: string[]) {
  const unique = [...new Set(names)];
  if (unique.length < 2) return "";
  const first = unique[0].match(/^[^-]+-/)?.[0] ?? "";
  return first && unique.every((n) => n.startsWith(first) && n.length > first.length) ? first : "";
}

/** A project's name without the prefix all projects share, for tight labels. */
export function projectLabel(project: string) {
  return projectPrefix && project.startsWith(projectPrefix) ? project.slice(projectPrefix.length) : project;
}

export function projectColor(project: string) {
  const slot = projectSlots.get(project);
  return slot ? `var(--color-series-${slot})` : `hsl(${projectHue(project)} 80% 55%)`;
}

/** Colors for a chart's keys: sidebar projects keep theirs, the rest take the free series slots in order, then grey. */
export function projectPalette(keys: string[], other = "Other") {
  const map = new Map<string, string>();
  const used = new Set(projectSlots.values());
  const free = Array.from({ length: SERIES }, (_, i) => i + 1).filter((i) => !used.has(i));
  for (const k of keys) {
    const slot = projectSlots.get(k) ?? free.shift();
    map.set(k, slot ? `var(--color-series-${slot})` : "var(--color-series-other)");
  }
  map.set(other, "var(--color-series-other)");
  return map;
}

export function projectHue(project: string) {
  let h = 0;
  for (const c of project) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (h + 210) % 360;
}
