import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cloneElement, createContext, useCallback, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "@/lib/types";
import { branchTone, cn, contextUsed, fillText } from "@/lib/utils";
import { Meter, STATUS_LABEL } from "./primitives";
import { StatusIcon } from "./StatusIcon";

type Side = "right" | "bottom";
type Shown = { content: ReactNode; rect: DOMRect; side: Side };

const Ctx = createContext<{ show: (s: Shown) => void; hide: () => void } | null>(null);

/**
 * One tooltip for the whole app, drawn in a portal so no panel's overflow clips it.
 * It appears at once; moving to a neighbour moves the same tooltip there, no new delay.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reduced = useReducedMotion();
  const show = useCallback((s: Shown) => {
    clearTimeout(hideTimer.current);
    setShown(s);
  }, []);
  // A short grace period: crossing the gap to the next item keeps the tooltip up, so it glides.
  const hide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShown(null), 90);
  }, []);

  // A tooltip opened by event (the rail following a keyboard move) closes on `openadmiral:tip-hide`.
  useEffect(() => {
    const off = () => hide();
    window.addEventListener("openadmiral:tip-hide", off);
    return () => window.removeEventListener("openadmiral:tip-hide", off);
  }, [hide]);

  const pos = shown && (shown.side === "right" ? { x: shown.rect.right + 10, y: shown.rect.top + shown.rect.height / 2 } : { x: shown.rect.left + shown.rect.width / 2, y: shown.rect.bottom + 8 });

  return (
    <Ctx.Provider value={{ show, hide }}>
      {children}
      {createPortal(
        <AnimatePresence>
          {shown && pos && (
            <motion.div
              key="tooltip"
              role="tooltip"
              className="pointer-events-none fixed top-0 left-0 z-[100]"
              initial={{ opacity: 0, x: pos.x, y: pos.y, scale: reduced ? 1 : 0.96 }}
              animate={{ opacity: 1, x: pos.x, y: pos.y, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 700, damping: 42, mass: 0.6, opacity: { duration: 0.08 } }}
            >
              <div
                className={cn(
                  "relative max-w-72 rounded-lg border px-2.5 py-1.5 text-xs leading-snug shadow-lg",
                  "border-black/[0.08] bg-white text-ink dark:border-white/10 dark:bg-[#0e0f12]/92 dark:text-ink dark:backdrop-blur-md",
                  shown.side === "right" ? "-translate-y-1/2" : "-translate-x-1/2",
                )}
              >
                {/* The arrow points back at what the tooltip explains. */}
                <span
                  className={cn(
                    "absolute size-2 rotate-45 border bg-white dark:bg-[#0e0f12]",
                    shown.side === "right"
                      ? "top-1/2 -left-[5px] -translate-y-1/2 border-t-0 border-r-0 border-black/[0.08] dark:border-white/10"
                      : "-top-[5px] left-1/2 -translate-x-1/2 border-r-0 border-b-0 border-black/[0.08] dark:border-white/10",
                  )}
                />
                <div className="relative">{shown.content}</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

type Triggerable = ReactElement<{
  onPointerEnter?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: React.PointerEvent<HTMLElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
}>;

/**
 * Gives its one child an instant tooltip, on hover and on keyboard focus. With an `id`,
 * an `openadmiral:tip` event naming it opens the tooltip too (preview screenshots).
 */
export function Tip({ content, side = "right", id, children }: { content: ReactNode; side?: Side; id?: string; children: Triggerable }) {
  const ctx = useContext(Ctx);
  const open = (el: HTMLElement) => ctx?.show({ content, rect: el.getBoundingClientRect(), side });
  useEffect(() => {
    if (!id || !ctx || !content) return;
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== id) return;
      const el = document.querySelector<HTMLElement>(`[data-tip-id="${CSS.escape(id)}"]`);
      if (el) open(el);
    };
    window.addEventListener("openadmiral:tip", on);
    return () => window.removeEventListener("openadmiral:tip", on);
  });
  if (!ctx || !content) return children;
  const p = children.props;
  return cloneElement(children, {
    ...(id ? { "data-tip-id": id } : {}),
    onPointerEnter: (e) => {
      p.onPointerEnter?.(e);
      open(e.currentTarget);
    },
    onPointerLeave: (e) => {
      p.onPointerLeave?.(e);
      ctx.hide();
    },
    onFocus: (e) => {
      p.onFocus?.(e);
      if (e.currentTarget.matches(":focus-visible")) open(e.currentTarget);
    },
    onBlur: (e) => {
      p.onBlur?.(e);
      ctx.hide();
    },
    // A press acts; the tooltip steps aside.
    onPointerDown: (e) => {
      p.onPointerDown?.(e);
      ctx.hide();
    },
  });
}

/** Label plus its shortcut, for icon-only buttons. */
export function TipLabel({ label, kbd }: { label: string; kbd?: string }) {
  return (
    <span className="flex items-center gap-3 whitespace-nowrap">
      <span className="font-semibold">{label}</span>
      {kbd && <span className="text-[11px] text-ink-3">{kbd}</span>}
    </span>
  );
}

/** An agent at a glance: name, status · project@branch, context, its ⌘N. */
export function AgentTip({ agent: a, n }: { agent: Agent; n?: number }) {
  const ctx = contextUsed(a.session?.context);
  return (
    <div className="w-60">
      <div className="flex items-baseline gap-2">
        <StatusIcon status={a.status} size={12} tip={false} className="self-center" />
        <span className="truncate font-semibold">{a.name}</span>
        {n !== undefined && n <= 9 && <span className="ml-auto shrink-0 text-[11px] text-ink-3">⌘{n}</span>}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-2">
        <span>{STATUS_LABEL[a.status]}</span>
        <span className="truncate text-ink-3">
          · {a.project}
          {a.session?.branch ? <span className={branchTone(a.session.branch)}>@{a.session.branch}</span> : ""}
        </span>
      </div>
      {ctx !== undefined && (
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-3">
          <span>Context</span>
          <Meter value={ctx} className="flex-1" />
          <span className={cn("tabular", fillText(ctx))}>{Math.round(ctx)}%</span>
        </div>
      )}
    </div>
  );
}
