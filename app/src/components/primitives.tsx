import type { ReactNode } from "react";
import type { AgentStatus, DelegationStatus } from "@/lib/types";
import { cn, fillTone } from "@/lib/utils";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Working",
  waiting: "Needs you",
  starting: "Starting",
  idle: "Idle",
  ended: "Ended",
};

/** A thin meter; turns amber then red as it fills, as a fuel gauge would. */
export function Meter({ value, className, tone }: { value: number | undefined; className?: string; tone?: "auto" | "brand" }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const color = tone === "brand" ? "bg-brand-500" : { ok: "bg-brand-500", warn: "bg-orange-500", high: "bg-red-500" }[fillTone(v)];
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-line-strong", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Chip({ children, icon, className, title, onClick, active }: { children: ReactNode; icon?: ReactNode; className?: string; title?: string; onClick?: () => void; active?: boolean }) {
  const base = "inline-flex h-6 items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-xs text-ink-2 tabular";
  // Clickable chips say so on hover; the tooltip around them says what the click does.
  if (onClick)
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          base,
          "cursor-pointer transition-colors duration-150 hover:border-line-strong hover:bg-line hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          active && "border-line-strong bg-line text-ink",
          className,
        )}
      >
        {icon}
        {children}
      </button>
    );
  return (
    <span title={title} className={cn(base, className)}>
      {icon}
      {children}
    </span>
  );
}

const PILL: Record<DelegationStatus, string> = {
  draft: "bg-transparent text-ink-3 ring-0 outline-1 outline-dashed outline-gray-500/50 -outline-offset-1",
  sent: "bg-gray-500/10 text-ink-2 ring-gray-500/20",
  accepted: "bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/25",
  in_progress: "bg-brand-500/10 text-brand-700 dark:text-brand-300 ring-brand-500/25",
  blocked: "bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/30",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25",
  cancelled: "bg-gray-500/10 text-ink-3 ring-gray-500/15 line-through",
};

export const DELEGATION_LABEL: Record<DelegationStatus, string> = {
  draft: "Draft · not delivered",
  sent: "Sent",
  accepted: "Accepted",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/** One sentence per delegation status, for tooltips. */
export const DELEGATION_HELP: Record<DelegationStatus, string> = {
  draft: "Recorded but not delivered yet; the agent still has to send it.",
  sent: "Delivered to the other agent, which has not picked it up yet.",
  accepted: "The other agent has taken it on.",
  in_progress: "The other agent is working on it.",
  blocked: "The other agent is stuck and needs something before it can go on.",
  done: "Finished; the result is in the card.",
  cancelled: "Called off; nothing more will happen.",
};

export function DelegationPill({ status, className }: { status: DelegationStatus; className?: string }) {
  return (
    <span title={DELEGATION_HELP[status]} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold ring-1 ring-inset", PILL[status], className)}>
      {DELEGATION_LABEL[status]}
    </span>
  );
}

export const DELEGATION_STROKE: Record<DelegationStatus, string> = {
  draft: "#9ca3af",
  sent: "#9ca3af",
  accepted: "#38bdf8",
  in_progress: "#1258ff",
  blocked: "#f59e0b",
  done: "#10b981",
  cancelled: "#9ca3af",
};

/** Where a session runs, in the person's words rather than the CLI's ("background", "interactive"). */
export const KIND = {
  openadmiral: { label: "In OpenAdmiral", hint: "Keeps running when you close OpenAdmiral" },
  terminal: { label: "In Terminal", hint: "Running in a terminal window — bring it into OpenAdmiral to work on it here" },
} as const;

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between px-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{children}</h3>
      {aside && <span className="text-[11px] text-ink-3 tabular">{aside}</span>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-canvas/60 px-1 font-sans text-[10px] text-ink-3">
      {children}
    </kbd>
  );
}
