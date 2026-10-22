import { MagnifierLinearIcon } from "@solar-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { search, type Hit, type Target } from "@/lib/search";
import { ago, cn } from "@/lib/utils";

/** ⌘K: search agents, prompts, delegations, artifacts and Up next, and jump to what you pick. */
export function CommandPalette({ open, initialQuery = "", hits, onClose, onPick }: { open: boolean; initialQuery?: string; hits: Hit[]; onClose: () => void; onPick: (t: Target) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(() => (open ? search(hits, query) : []), [open, hits, query]);

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setIndex(0);
    // After the open animation mounts the field.
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, initialQuery]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    onPick(h.target);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setIndex((i) => Math.min(results.length - 1, i + 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") pick(results[index]);
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] backdrop-blur-[2px]"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
            role="dialog"
            aria-label="Search"
            className="flex max-h-[65vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line-strong bg-canvas shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <MagnifierLinearIcon size={17} className="shrink-0 text-ink-3" />
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search agents, prompts, delegations, artifacts…"
                spellCheck={false}
                className="h-12 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <kbd className="rounded border border-line-strong px-1.5 text-[10px] text-ink-3">esc</kbd>
            </div>
            <div ref={list} className="overflow-y-auto p-1.5">
              {results.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches “{query}”.</p>
              ) : (
                results.map((h, i) => (
                  <div key={h.key}>
                    {(i === 0 || results[i - 1].section !== h.section) && (
                      <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{h.section}</div>
                    )}
                    <button
                      type="button"
                      data-index={i}
                      onMouseMove={() => setIndex(i)}
                      onClick={() => pick(h)}
                      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left", i === index ? "bg-brand-500/12 text-ink" : "text-ink-2")}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{h.title}</span>
                      {h.detail && <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">{h.detail}</span>}
                      {h.at && h.section !== "Agents" && <span className="shrink-0 text-[11px] text-ink-3 tabular">{ago(h.at)}</span>}
                    </button>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
