import type { AdmiralSession } from "@/lib/types";
import { cn, until } from "@/lib/utils";
import { Meter } from "./primitives";

type Limits = NonNullable<AdmiralSession["rateLimits"]>;

const LABEL: Record<string, [short: string, long: string]> = {
  five_hour: ["5-hour", "5-hour window"],
  seven_day: ["Weekly", "Weekly"],
  seven_day_opus: ["Weekly · Opus", "Weekly · Opus"],
};

/** A window whose reset time has passed: its last reading no longer says how much is used. */
export function isReset(resetsAt: string | undefined, now = Date.now()) {
  if (!resetsAt) return false;
  const t = Date.parse(resetsAt);
  return !Number.isNaN(t) && t <= now;
}

export function PlanMeters({ limits, long, className }: { limits: Limits; long?: boolean; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)}>
      {limits.map((r) => {
        const label = LABEL[r.kind]?.[long ? 1 : 0] ?? r.kind.replace(/_/g, " ");
        const reset = isReset(r.resetsAt);
        return (
          <div key={r.kind}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="text-ink-2">{label}</span>
              {reset ? (
                <span className="truncate text-[11px] text-ink-3" title="The window reset after the last reading; the next API response brings a fresh one.">
                  reset · waiting for next response
                </span>
              ) : (
                <span className="text-ink-3 tabular">
                  <span className="font-semibold text-ink">{Math.round(r.percentUsed)}%</span>
                  {r.resetsAt && <span> · resets in {until(r.resetsAt)}</span>}
                </span>
              )}
            </div>
            <Meter value={reset ? 0 : r.percentUsed} className={cn(reset && "opacity-50")} />
          </div>
        );
      })}
    </div>
  );
}
