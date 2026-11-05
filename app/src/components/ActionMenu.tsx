import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export type ActionItem = {
  id: string;
  label: string;
  /** One line saying what it does. */
  description: string;
  /** Set when the action is unavailable: says why, and disables it. */
  disabledReason?: string;
  danger?: boolean;
  shortcut?: string;
  run: () => void;
};

/**
 * A popover menu whose items explain themselves: label, a one-line description,
 * and for a disabled item the reason. ↑/↓ move, Enter runs, Esc or a click outside closes.
 */
const MENU_W = 320;

export function ActionMenu({ trigger, items, header, align = "right", defaultOpen = false }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; items: ActionItem[]; header?: ReactNode; align?: "left" | "right"; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  // Drawn over the whole window, not inside the trigger's box: a pane clips what overflows it,
  // and clicks on the clipped part would land in the pane beside it.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const place = () => {
      const r = root.current!.getBoundingClientRect();
      const w = MENU_W, gap = 6, pad = 8;
      const h = menu.current?.offsetHeight ?? 0;
      const left = Math.min(Math.max(pad, align === "right" ? r.right - w : r.left), window.innerWidth - w - pad);
      const below = r.bottom + gap;
      const top = h && below + h > window.innerHeight - pad && r.top - gap - h > pad ? r.top - gap - h : below;
      setAt({ left, top });
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);
  const enabled = items.map((it, i) => (it.disabledReason ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    setFocus(enabled[0] ?? 0);
    const outside = (e: MouseEvent) => !root.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = (it: ActionItem) => {
    if (it.disabledReason) return;
    setOpen(false);
    it.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    const at = enabled.indexOf(focus);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus(enabled[(at + 1) % enabled.length]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus(enabled[(at - 1 + enabled.length) % enabled.length]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[focus];
      if (it) run(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      {trigger(() => setOpen((o) => !o), open)}
      {createPortal(
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            tabIndex={-1}
            onKeyDown={onKey}
            style={{ left: at?.left ?? -9999, top: at?.top ?? 0, width: MENU_W }}
            ref={(el) => {
              menu.current = el;
              el?.focus();
            }}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className="fixed z-[90] rounded-xl border border-line-strong bg-canvas p-1.5 shadow-xl outline-none"
          >
            {header && <div className="mb-1 border-b border-line px-3 pt-1.5 pb-2.5">{header}</div>}
            {items.map((it, i) => (
              <button
                key={it.id}
                role="menuitem"
                aria-disabled={!!it.disabledReason}
                onMouseEnter={() => !it.disabledReason && setFocus(i)}
                onClick={() => run(it)}
                className={cn(
                  "flex w-full flex-col items-start rounded-lg px-3 py-2 text-left transition-colors",
                  it.disabledReason ? "cursor-default opacity-55" : focus === i ? (it.danger ? "bg-red-500/10" : "bg-line") : "",
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className={cn("text-sm font-semibold", it.danger && !it.disabledReason ? "text-red-600 dark:text-red-400" : "text-ink")}>{it.label}</span>
                  {it.shortcut && <span className="ml-auto text-[11px] text-ink-3">{it.shortcut}</span>}
                </span>
                <span className="mt-0.5 text-xs leading-snug text-ink-3">{it.disabledReason ?? it.description}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
      )}
    </div>
  );
}
