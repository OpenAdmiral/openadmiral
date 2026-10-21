import { CloseCircleLinearIcon, DollarLinearIcon, RefreshLinearIcon } from "@solar-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bucketDays, localDate, money, useRetention, type Costs, type DayCost, type RangeDays } from "@/lib/costs";
import type { Agent, AdmiralSession } from "@/lib/types";
import { ago, cn, compact, projectPalette } from "@/lib/utils";
import { PlanMeters } from "./PlanMeters";
import { Info } from "./Info";
import { SectionTitle } from "./primitives";
import { StatusIcon } from "./StatusIcon";
import { UnderwayPill } from "@/components/UnderwayPill";

type Props = {
  costs: Costs | null;
  range: RangeDays;
  onRange: (r: RangeDays) => void;
  fetchedAt?: number;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  agents: Agent[];
  rateLimits: NonNullable<AdmiralSession["rateLimits"]>;
  now: number;
  onJump: (agentId: string) => void;
};

const SLOTS = 7;
const OTHER = "Other";

/** Color follows the entity: slot by 30-day rank over the whole report, kept under any filter. */
function palette(keys: string[]) {
  const map = new Map<string, string>();
  keys.forEach((k, i) => map.set(k, i < SLOTS ? `var(--color-series-${i + 1})` : "var(--color-series-other)"));
  map.set(OTHER, "var(--color-series-other)");
  return map;
}

export function CostsView({ costs, range, onRange, fetchedAt, loading, error, onRefresh, agents, rateLimits, now, onJump }: Props) {
  const [mode, setMode] = useState<"project" | "model">("project");
  const [filter, setFilter] = useState<string | null>(null);
  const rangeLabel = costs?.allTime ? "all time" : `last ${costs?.rangeDays ?? range} days`;
  // Long ranges fold days into whole weeks so the bars stay readable.
  const bucket = costs && costs.days.length > 95 ? 7 * Math.ceil(costs.days.length / 630) : 1;

  // Claude Code deletes transcripts after `retention.days`; a range reaching further
  // back than that can only ever be partly filled.
  const retention = useRetention();
  const neededDays = range === 0 ? RETENTION_OPTIONS[RETENTION_OPTIONS.length - 1][0] : range;

  // Only offer ranges the retention actually keeps data for; "All" once it goes past 90.
  // Raising the retention (the control below) is what unlocks the longer ranges.
  const rangeOptions = useMemo(() => {
    const kept = retention.days ?? 3650; // not read yet: offer everything, it settles in a blink
    const opts: [RangeDays, string][] = [[30, "30d"]];
    if (kept >= 60) opts.push([60, "60d"]);
    if (kept >= 90) opts.push([90, "90d"]);
    if (kept > 90) opts.push([0, "All"]);
    return opts;
  }, [retention.days]);
  // A range the retention no longer covers falls back to the 30 days that always exist.
  useEffect(() => {
    if (!rangeOptions.some(([d]) => d === range)) onRange(30);
  }, [rangeOptions, range, onRange]);

  // Projects keep their sidebar color; recomputed each render so a reorder shows at once.
  const projectColors = projectPalette(costs?.projects.map((p) => p.name) ?? [], OTHER);
  const modelColors = useMemo(() => palette(costs?.models ?? []), [costs]);
  const live = agents.filter((a) => a.status !== "ended");
  const liveShown = filter ? live.filter((a) => a.project === filter) : live;
  const liveCost = live.reduce((s, a) => s + (a.session?.costUsd ?? 0), 0);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header data-tauri-drag-region className="flex shrink-0 items-center gap-3 px-6 pt-3.5 pb-4">
        <DollarLinearIcon size={20} className="text-brand-600 dark:text-brand-400" />
        <h1 className="text-xl font-semibold tracking-tight text-ink">Costs</h1>
        <span className="text-sm text-ink-3">API-equivalent, from your local Claude Code logs</span>
        <span className="flex-1" />
        <span className="text-xs text-ink-3 tabular">{loading ? "Updating…" : fetchedAt ? `Updated ${ago(fetchedAt, now)} ago` : ""}</span>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
          className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
        >
          <RefreshLinearIcon size={16} className={cn(loading && "animate-spin")} />
        </button>
        <UnderwayPill />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
            <span className="font-semibold">Could not refresh costs.</span>
            <span className="selectable truncate">{error}</span>
            {costs && <span className="ml-auto shrink-0 opacity-80">Showing the last saved report.</span>}
          </div>
        )}
        {!costs ? (
          <div className="mt-24 text-center text-sm text-ink-3">{loading ? "Reading usage with ccusage…" : "No usage data yet."}</div>
        ) : (
          <>
            <Kpis costs={costs} rateLimits={rateLimits} />

            {retention.days !== null && <RetentionControl retention={retention.days} needed={neededDays} onSet={retention.set} />}

            <section className="mt-4 rounded-2xl border border-line bg-canvas p-5 shadow-sm">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-ink">{bucket === 1 ? "Daily cost" : "Weekly cost"} · {rangeLabel}</h2>
                  <p className="text-xs text-ink-3">
                    Stacked by {mode}
                    {filter ? `, ${filter} only` : ""}
                    {bucket > 7 ? ` · each bar is ${bucket} days` : ""}
                  </p>
                </div>
                {filter && (
                  <button
                    onClick={() => setFilter(null)}
                    className="inline-flex h-6 items-center gap-1 rounded-full bg-brand-500/10 pr-1.5 pl-2.5 text-xs font-semibold text-brand-700 dark:text-brand-300"
                  >
                    {filter}
                    <CloseCircleLinearIcon size={14} />
                  </button>
                )}
                <span className="flex-1" />
                {rangeOptions.length > 1 && <Segmented value={range} onChange={onRange} options={rangeOptions} />}
                <Segmented value={mode} onChange={setMode} options={[["project", "By project"], ["model", "By model"]]} />
              </div>
              <StackedBars days={costs.days} bucket={bucket} mode={mode} filter={filter} order={mode === "project" ? costs.projects.map((p) => p.name) : costs.models} colors={mode === "project" ? projectColors : modelColors} />
            </section>

            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_300px] gap-4">
              <ProjectTable costs={costs} colors={projectColors} filter={filter} onFilter={(n) => setFilter(filter === n ? null : n)} live={live} onJump={onJump} />
              <section className="self-start rounded-2xl border border-line bg-canvas p-4 shadow-sm">
                <SectionTitle aside={money(liveCost, true)}>Live now</SectionTitle>
                <p className="mb-3 px-1 text-[11px] leading-relaxed text-ink-3">Cost of each running session so far, as Claude Code counts it.</p>
                {liveShown.length === 0 ? (
                  <p className="px-1 text-xs text-ink-3">{filter ? `No running agents in ${filter}.` : "No running agents."}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {[...liveShown]
                      .sort((a, b) => (b.session?.costUsd ?? 0) - (a.session?.costUsd ?? 0))
                      .map((a) => (
                        <li key={a.id}>
                          <button onClick={() => onJump(a.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-line">
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-semibold text-ink">{a.name}</span>
                                <StatusIcon status={a.status} size={12} tip={false} />
                              </span>
                              <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
                                <span className="size-1.5 rounded-full" style={{ background: projectColors.get(a.project) ?? "var(--color-series-other)" }} />
                                {a.project}
                              </span>
                            </span>
                            <span className="text-xs font-semibold text-ink tabular">{a.session?.costUsd !== undefined ? money(a.session.costUsd, true) : "—"}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const RETENTION_OPTIONS: [number, string][] = [[30, "30 days"], [90, "90 days"], [365, "1 year"], [3650, "10 years"]];

function retentionLabel(days: number) {
  return RETENTION_OPTIONS.find(([d]) => d === days)?.[1] ?? `${days} days`;
}

/**
 * Claude Code keeps session transcripts for `retention` days (`cleanupPeriodDays`), and
 * costs are read from them — so that bounds how far back history reaches. A quiet line
 * normally; a highlighted notice when the selected range reaches further back than that.
 * Raising or lowering asks for an explicit confirmation first: it changes Claude Code
 * itself, not just this app, and lowering lets it delete the older transcripts.
 */
function RetentionControl({ retention, needed, onSet }: { retention: number; needed: number; onSet: (days: number) => Promise<void> }) {
  const short = retention < needed;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      await onSet(pending);
      setPending(null);
      setOpen(false);
      setSaved(true);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const optionButton = (d: number, label: string) => (
    <button
      key={d}
      onClick={() => {
        setPending(d);
        setSaved(false);
      }}
      className="rounded-full bg-brand-500/15 px-2.5 py-1 font-semibold text-brand-700 transition-colors hover:bg-brand-500/25 dark:text-brand-300"
    >
      {label}
    </button>
  );
  return (
    <div
      className={cn(
        "mt-4 rounded-xl border px-4 py-2.5 text-xs text-ink-2",
        short || pending !== null || open ? "border-brand-500/30 bg-brand-500/[0.08]" : "border-line",
      )}
    >
      {pending !== null ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span>
            This sets <code className="text-ink">cleanupPeriodDays</code> to {pending} in <code className="text-ink">~/.claude/settings.json</code>, for all of Claude Code.{" "}
            {pending < retention ? (
              <b className="text-amber-700 dark:text-amber-300">
                Claude Code will then delete transcripts older than {retentionLabel(pending)}, and the cost history past that point is gone for good.
              </b>
            ) : (
              <>Transcripts will take more disk space over time.</>
            )}{" "}
            Keep them for {retentionLabel(pending)}?
          </span>
          <button
            onClick={confirm}
            disabled={busy}
            className="rounded-full bg-brand-600 px-2.5 py-1 font-semibold text-white transition-colors hover:bg-brand-500 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Confirm"}
          </button>
          <button
            onClick={() => {
              setPending(null);
              setError(null);
            }}
            disabled={busy}
            className="rounded-full px-2.5 py-1 font-semibold text-ink-2 transition-colors hover:bg-line"
          >
            Cancel
          </button>
          {error && <span className="selectable text-amber-800 dark:text-amber-200">Could not save: {error}</span>}
        </div>
      ) : short || open ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span>
            {short ? (
              <>
                Claude Code deletes its session transcripts after <b className="text-ink">{retentionLabel(retention)}</b>, and costs are read
                from them — so history can only reach back that far. Keep them longer and history builds up from today:
              </>
            ) : (
              <>
                Claude Code keeps its session transcripts — your cost history — for <b className="text-ink">{retentionLabel(retention)}</b>. Keep them for:
              </>
            )}
          </span>
          {/* "Keep them longer" offers only longer; the explicit Change menu also lets you shorten. */}
          {RETENTION_OPTIONS.filter(([d]) => (short ? d > retention : d !== retention)).map(([d, label]) => optionButton(d, label))}
          {!short && (
            <button onClick={() => setOpen(false)} className="rounded-full px-2.5 py-1 font-semibold text-ink-2 transition-colors hover:bg-line">
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-ink-3">
          <span>
            Claude Code keeps its session transcripts — your cost history — for <b className="text-ink-2">{retentionLabel(retention)}</b>.
            {saved && <span className="ml-1.5 font-semibold text-emerald-700 dark:text-emerald-300">Saved.</span>}
          </span>
          <button
            onClick={() => {
              setOpen(true);
              setSaved(false);
            }}
            className="rounded-full px-2.5 py-1 font-semibold text-brand-700 transition-colors hover:bg-brand-500/15 dark:text-brand-300"
          >
            Change
          </button>
        </div>
      )}
    </div>
  );
}

function Kpis({ costs, rateLimits }: { costs: Costs; rateLimits: Props["rateLimits"] }) {
  const tiles: { label: string; value: string; note?: string }[] = [
    { label: "Today", value: money(costs.today) },
    { label: "Last 7 days", value: money(costs.last7) },
    { label: "This month", value: money(costs.month), note: `on pace for ${money(costs.monthProjection)}` },
    { label: "Daily average", value: money(costs.dailyAvg), note: costs.allTime ? "all time" : `last ${costs.rangeDays} days` },
  ];
  return (
    <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.35fr)] gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-line bg-canvas px-4 py-3.5 shadow-sm">
          <div className="text-xs text-ink-3">{t.label}</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-ink tabular">{t.value}</div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-3">
            {t.note ?? "API-equivalent"}
            {!t.note && <Info tip="What this usage would cost at Anthropic API prices; on the Max plan you don't pay it." align="left" />}
          </div>
        </div>
      ))}
      <div className="rounded-2xl border border-brand-500/20 bg-brand-500/[0.06] px-4 py-3.5">
        <div className="flex items-baseline justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
            What you actually use <Info tip="How much of your Max plan's 5-hour and weekly limits you have used; each resets at the time shown." align="left" />
          </span>
          <span className="text-[11px] text-ink-3">Max plan</span>
        </div>
        {rateLimits.length === 0 ? (
          <p className="mt-2 text-xs text-ink-3">Plan limits appear once a session with the OpenAdmiral plugin gets an API response.</p>
        ) : (
          <PlanMeters limits={rateLimits} long className="mt-2 space-y-2" />
        )}
        <p className="mt-2 text-[11px] leading-snug text-ink-3">The dollar figures are what this usage would cost at API prices, not what you pay.</p>
      </div>
    </div>
  );
}

function Segmented<T extends string | number>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="inline-flex rounded-lg bg-line p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-all duration-200",
            value === v ? "bg-canvas font-semibold text-ink shadow-sm" : "text-ink-2 hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function niceMax(v: number) {
  if (v <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

function shortDate(date: string) {
  const [, m, d] = date.split("-").map(Number);
  return new Date(2000, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function StackedBars({ days: dailyDays, bucket, mode, filter, order, colors }: { days: DayCost[]; bucket: number; mode: "project" | "model"; filter: string | null; order: string[]; colors: Map<string, string> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const days = useMemo(() => bucketDays(dailyDays, bucket), [dailyDays, bucket]);
  // Series: the top slots by name, the rest folded into Other, bottom-up in slot order.
  const series = useMemo(() => {
    const top = order.slice(0, SLOTS);
    return top.length < order.length ? [...top, OTHER] : top;
  }, [order]);
  const stacks = useMemo(
    () =>
      days.map((d) => {
        const src = mode === "project" ? d.byProject : d.byModel;
        // A project filter keeps that project's own share of each day (by model, its share is not split).
        if (filter && mode === "project") return { [filter]: src[filter] ?? 0 } as Record<string, number>;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(src)) {
          const key = series.includes(k) ? k : OTHER;
          out[key] = (out[key] ?? 0) + v;
        }
        return out;
      }),
    [days, mode, filter, series],
  );
  const shownSeries = filter && mode === "project" ? [filter] : series;
  const totals = stacks.map((s) => Object.values(s).reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(...totals, 1));

  const H = 240, top = 8, bottom = 24, left = 52, right = 4;
  const plotH = H - top - bottom;
  const plotW = Math.max(100, width - left - right);
  const step = plotW / days.length;
  const barW = Math.min(22, step * 0.66);
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const GAP = 2;
  // Date labels thin out as bars multiply; ~5 across, like the 30-day view always had.
  const labelEvery = Math.max(7, Math.ceil(days.length / 6));

  return (
    <div>
      {/* Legend: identity is never color alone. */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {shownSeries.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <span className="size-2.5 rounded-[3px]" style={{ background: colors.get(k) }} />
            {k}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={H} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeDasharray={t === 0 ? undefined : "2 4"} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end" className="fill-[var(--color-ink-3)] text-[10px] tabular">
                {t === 0 ? "$0" : money(t)}
              </text>
            </g>
          ))}
          {stacks.map((s, i) => {
            const cx = left + step * i + step / 2;
            const x = cx - barW / 2;
            let acc = 0;
            const segs = shownSeries.filter((k) => (s[k] ?? 0) > 0);
            const totalH = y(0) - y(totals[i]);
            const r = Math.min(4, barW / 2, totalH);
            const clipTop = y(totals[i]);
            return (
              <g key={days[i].date} opacity={hover === null || hover === i ? 1 : 0.45} className="transition-opacity duration-150">
                <clipPath id={`col-${i}`}>
                  {/* Rounded data end, square at the baseline. */}
                  <path d={`M${x} ${y(0)} V${clipTop + r} Q${x} ${clipTop} ${x + r} ${clipTop} H${x + barW - r} Q${x + barW} ${clipTop} ${x + barW} ${clipTop + r} V${y(0)} Z`} />
                </clipPath>
                <g clipPath={`url(#col-${i})`}>
                  {segs.map((k, j) => {
                    const v = s[k];
                    const y1 = y(acc + v);
                    const h = y(acc) - y1;
                    acc += v;
                    // A 2px surface gap between stacked fills.
                    const gap = j > 0 ? GAP : 0;
                    return <rect key={k} x={x} y={y1} width={barW} height={Math.max(0, h - gap)} fill={colors.get(k)} />;
                  })}
                </g>
                {(i % labelEvery === 2 || i === days.length - 1) && (
                  <text x={cx} y={H - 6} textAnchor="middle" className="fill-[var(--color-ink-3)] text-[10px]">
                    {i === days.length - 1 && bucket === 1 ? "Today" : shortDate(days[i].date)}
                  </text>
                )}
                {/* Hit target: the whole column, wider than the bar. */}
                <rect x={left + step * i} y={top} width={step} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && totals[hover] > 0 && (
          <Tooltip
            day={days[hover]}
            bucket={bucket}
            total={totals[hover]}
            rows={shownSeries.filter((k) => (stacks[hover][k] ?? 0) > 0).map((k) => [k, stacks[hover][k]] as [string, number]).sort((a, b) => b[1] - a[1])}
            colors={colors}
            x={left + step * hover + step / 2}
            width={width}
          />
        )}
      </div>
    </div>
  );
}

function Tooltip({ day, bucket, total, rows, colors, x, width }: { day: DayCost; bucket: number; total: number; rows: [string, number][]; colors: Map<string, string>; x: number; width: number }) {
  const W = 230;
  const leftPos = x + 14 + W > width ? x - 14 - W : x + 14;
  // A bucketed bar covers [date, date + bucket), capped at today.
  const end = useMemo(() => {
    if (bucket <= 1) return null;
    const [y, m, d] = day.date.split("-").map(Number);
    const last = new Date(y, m - 1, d + bucket - 1);
    return localDate(last) > localDate(new Date()) ? localDate(new Date()) : localDate(last);
  }, [day.date, bucket]);
  return (
    <div className="pointer-events-none absolute top-2 z-10 rounded-xl border border-line-strong bg-canvas/95 p-3 shadow-lg backdrop-blur" style={{ left: leftPos, width: W }}>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-ink">{end ? `${shortDate(day.date)} – ${shortDate(end)}` : shortDate(day.date)}</span>
        <span className="text-xs font-semibold text-ink tabular">{money(total, true)}</span>
      </div>
      <ul className="space-y-1">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: colors.get(k) }} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{k}</span>
            <span className="text-ink-3 tabular">{Math.round((v / total) * 100)}%</span>
            <span className="w-16 text-right text-ink tabular">{money(v, true)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const W = 84, H = 22;
  const max = Math.max(...values, 0.01);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (W - 2) + 1},${H - 2 - (v / max) * (H - 4)}`).join(" ");
  return (
    <svg width={W} height={H} className="block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function ProjectTable({ costs, colors, filter, onFilter, live, onJump }: { costs: Costs; colors: Map<string, string>; filter: string | null; onFilter: (name: string) => void; live: Agent[]; onJump: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = all ? costs.projects : costs.projects.slice(0, 10);
  const rangeHead = costs.allTime ? "All time" : `${costs.rangeDays} days`;
  return (
    <section className="min-w-0 rounded-2xl border border-line bg-canvas shadow-sm">
      <div className="flex items-center justify-between px-5 pt-4 pb-2">
        <h2 className="text-sm font-semibold text-ink">Projects</h2>
        <span className="text-[11px] text-ink-3">Click a project to filter the chart</span>
      </div>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-line text-left text-[11px] text-ink-3">
            <th className="py-2 pl-5 font-semibold">Project</th>
            <th className="py-2 text-right font-semibold">Today</th>
            <th className="py-2 text-right font-semibold">7 days</th>
            <th className="py-2 text-right font-semibold">{rangeHead}</th>
            {!costs.allTime && <th className="py-2 text-right font-semibold">All time</th>}
            <th className="py-2 pl-4 font-semibold">Share</th>
            <th className="py-2 font-semibold">Top model</th>
            <th className="py-2 font-semibold">Trend</th>
            <th className="py-2 pr-5 text-right font-semibold">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const share = costs.rangeTotal > 0 ? (p.inRange / costs.rangeTotal) * 100 : 0;
            const agents = live.filter((a) => a.project === p.name);
            const color = colors.get(p.name) ?? "var(--color-series-other)";
            return (
              <tr
                key={p.name}
                onClick={() => onFilter(p.name)}
                className={cn(
                  "cursor-pointer border-b border-line transition-colors last:border-0 hover:bg-line/60",
                  filter === p.name && "bg-brand-500/[0.07]",
                  filter && filter !== p.name && "opacity-50",
                )}
              >
                <td className="py-2 pl-5">
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
                    <span className="truncate font-semibold text-ink">{p.name}</span>
                    {agents.map((a) => (
                      <button
                        key={a.id}
                        title={`Open ${a.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onJump(a.id);
                        }}
                        className="inline-flex items-center rounded-full p-0.5 hover:bg-line-strong"
                      >
                        <StatusIcon status={a.status} size={12} tip={false} />
                      </button>
                    ))}
                  </span>
                </td>
                <td className="py-2 text-right text-ink-2">{p.today ? money(p.today) : "—"}</td>
                <td className="py-2 text-right text-ink-2">{p.d7 ? money(p.d7) : "—"}</td>
                <td className="py-2 text-right font-semibold text-ink">{p.inRange ? money(p.inRange) : "—"}</td>
                {!costs.allTime && <td className="py-2 text-right text-ink-2">{money(p.total)}</td>}
                <td className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    <span className="h-1 w-12 overflow-hidden rounded-full bg-line-strong">
                      <span className="block h-full rounded-full" style={{ width: `${share}%`, background: color }} />
                    </span>
                    <span className="w-8 text-ink-3">{share < 1 ? "<1" : Math.round(share)}%</span>
                  </span>
                </td>
                <td className="py-2 text-ink-2">{p.topModel ?? "—"}</td>
                <td className="py-1">
                  <Sparkline values={p.series} color={color} />
                </td>
                <td className="py-2 pr-5 text-right text-ink-3">{compact(p.tokensInRange)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {costs.projects.length > 10 && (
        <button onClick={() => setAll(!all)} className="w-full border-t border-line py-2 text-xs text-ink-3 hover:text-ink">
          {all ? "Show top 10" : `Show all ${costs.projects.length} projects`}
        </button>
      )}
    </section>
  );
}
