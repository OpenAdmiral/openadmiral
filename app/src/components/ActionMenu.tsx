import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
export function ActionMenu({ trigger, items, header, align = "right", defaultOpen = false }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; items: ActionItem[]; header?: ReactNode; align?: "left" | "right"; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [focus, setFocus] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it.disabledReason ? -1 : i)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    setFocus(enabled[0] ?? 0);
    const outside = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
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
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={cn("absolute top-full z-50 mt-1.5 w-80 rounded-xl border border-line-strong bg-canvas p-1.5 shadow-xl outline-none", align === "right" ? "right-0" : "left-0")}
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
      </AnimatePresence>
    </div>
  );
}
