import type { ReactNode } from "react";
import type { AgentStatus } from "@/lib/types";
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
