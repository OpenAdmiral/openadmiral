import { CloseCircleLinearIcon, KeyboardLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { Fragment, useEffect } from "react";
import { createPortal } from "react-dom";
import { SHORTCUTS } from "@/lib/shortcuts";
import { Kbd } from "./primitives";

/** Every shortcut, drawn from the same table the key handlers match against. */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    // Capture, so Esc closes the sheet before the terminal sees it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[10vh] backdrop-blur-[2px]"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            role="dialog"
            aria-label="Keyboard shortcuts"
            className="flex max-h-[78vh] w-[640px] flex-col rounded-2xl border border-line-strong bg-canvas shadow-xl"
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-brand-600 text-white">
                  <KeyboardLinearIcon size={16} />
                </span>
                <h2 className="text-base font-semibold text-ink">Keyboard shortcuts</h2>
              </div>
              <button onClick={onClose} aria-label="Close" className="text-ink-3 transition-colors hover:text-ink">
                <CloseCircleLinearIcon size={20} />
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto px-5 pb-5">
              {SHORTCUTS.map((g) => (
                <section key={g.title} className="mt-3 first:mt-0">
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{g.title}</h3>
                  <ul className="divide-y divide-line rounded-xl border border-line bg-panel">
                    {g.items.map((s) => (
                      <li key={s.id} className="flex items-center gap-4 px-3.5 py-2">
                        <span className="flex w-[150px] shrink-0 flex-wrap items-center gap-1">
                          {s.keys.map((chord, i) => (
                            <Fragment key={i}>
                              {i > 0 && chord[0] !== "…" && s.keys[i - 1][0] !== "…" && <span className="text-[10px] text-ink-3">or</span>}
                              {chord[0] === "…" ? <span className="text-[10px] text-ink-3">to</span> : chord.map((k) => <Kbd key={k}>{k}</Kbd>)}
                            </Fragment>
                          ))}
                        </span>
                        <span className="text-[13px] leading-snug text-ink-2">{s.description}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
