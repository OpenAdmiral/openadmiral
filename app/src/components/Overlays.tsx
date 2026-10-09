import { DangerTriangleLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import type { Notice } from "@/lib/lifecycle";
import { cn } from "@/lib/utils";

type Confirm = { title: string; body: string; action: string; run: () => Promise<void> };

/** A destructive confirmation, macOS-alert style. */
export function ConfirmDialog({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <AnimatePresence>
      {confirm && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[18vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            className="w-[420px] rounded-2xl border border-line-strong bg-canvas p-5 shadow-xl"
            onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
          >
            <div className="flex gap-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:text-red-400">
                <DangerTriangleLinearIcon size={20} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-ink">{confirm.title}</h2>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{confirm.body}</p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button autoFocus disabled={busy} onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm text-ink-2 transition-all duration-200 hover:bg-line">
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await confirm.run();
                  setBusy(false);
                  onClose();
                }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-60"
              >
                {busy ? "Working…" : confirm.action}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Notices({ notices }: { notices: Notice[] }) {
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 z-[100] flex w-[360px] flex-col gap-2">
      <AnimatePresence>
        {notices.map((n) => (
          <motion.div
            key={n.id}
            layout
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4 }}
            className={cn(
              "selectable pointer-events-auto rounded-xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur",
              n.tone === "error" ? "border-red-500/30 bg-red-50/95 text-red-800 dark:bg-red-950/90 dark:text-red-200" : "border-line-strong bg-canvas/95 text-ink-2",
            )}
          >
            <span className="flex items-center gap-3">
              <span className="flex-1">{n.text}</span>
              {n.action && (
                <button onClick={n.action.run} className="shrink-0 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700">
                  {n.action.label}
                </button>
              )}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
