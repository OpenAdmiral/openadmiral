import { InfoCircleLinearIcon } from "@solar-icons/react";
import { cn } from "@/lib/utils";
import { Tip } from "./Tooltip";

/**
 * A small (i) that explains a concept in one sentence on hover or focus. It uses
 * the app's portal tooltip, so it is never clipped by the panel it sits in and
 * follows the light/dark styling. `align` is kept for callers; placement is the
 * tooltip's own (below the icon).
 */
export function Info({ tip, className, id }: { tip: string; className?: string; align?: "center" | "left" | "right"; /** For OPENADMIRAL_TIP previews. */ id?: string }) {
  return (
    <Tip side="bottom" id={id} content={<div className="max-w-60 text-[11.5px] leading-snug">{tip}</div>}>
      <span tabIndex={0} aria-label={tip} className={cn("inline-flex shrink-0 align-middle text-ink-3 outline-none hover:text-ink-2 focus:text-ink-2", className)}>
        <InfoCircleLinearIcon size={12} />
      </span>
    </Tip>
  );
}
