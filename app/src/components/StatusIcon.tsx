import { BellLinearIcon, LoaderLinearIcon, MoonSleepLinearIcon, RefreshLinearIcon, StopCircleLinearIcon } from "@solar-icons/react";
import type { AgentStatus } from "@/lib/types";
import { cn, projectColor } from "@/lib/utils";
import { STATUS_LABEL } from "./primitives";
import { Tip } from "./Tooltip";

/**
 * Status is an icon, identity a dot: the icon says what an agent is doing, the
 * project-colored dot which project it belongs to. Motion only where it means
 * something (working spins, needs-you pulses) and never under reduced motion.
 */
const STATUS: Record<AgentStatus, { icon: typeof RefreshLinearIcon; className: string; hint: string }> = {
  working: { icon: RefreshLinearIcon, className: "text-brand-600 dark:text-brand-500 motion-safe:animate-spin-slow", hint: "Working on a turn" },
  waiting: { icon: BellLinearIcon, className: "text-amber-600 dark:text-amber-400 motion-safe:animate-nudge", hint: "Needs you: a permission or an answer" },
  idle: { icon: MoonSleepLinearIcon, className: "text-emerald-800/45 dark:text-emerald-200/45", hint: "Idle, waiting for a prompt" },
  starting: { icon: LoaderLinearIcon, className: "text-ink-3 motion-safe:animate-spin-slow", hint: "Starting" },
  ended: { icon: StopCircleLinearIcon, className: "text-ink-3/80", hint: "Ended: resumable with claude --resume" },
};

export function StatusIcon({ status, size = 14, tip = true, side = "bottom", className }: { status: AgentStatus; size?: number; tip?: boolean; side?: "right" | "bottom"; className?: string }) {
  const { icon: Icon, className: tone, hint } = STATUS[status];
  const icon = (
    <span role="img" aria-label={STATUS_LABEL[status]} className={cn("inline-flex shrink-0 items-center justify-center", className)}>
      <Icon size={size} className={tone} />
    </span>
  );
  if (!tip) return icon;
  return (
    <Tip side={side} content={<span className="whitespace-nowrap"><span className="font-semibold">{STATUS_LABEL[status]}</span> · {hint}</span>}>{icon}</Tip>
  );
}

/** An agent's identity: its project's color, the same as the project's header dot. */
export function ProjectDot({ project, className }: { project: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", className)} style={{ background: projectColor(project) }} />;
}

export { projectColor };
