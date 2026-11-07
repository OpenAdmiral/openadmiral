import { MagnifierLinearIcon, MonitorLinearIcon, WindowFrameLinearIcon } from "@solar-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Artifact } from "@/lib/artifacts";
import type { QueueEntry } from "@/lib/queue";
import { collect, search, windowHits, type Hit, type OpenWindow, type Target } from "@/lib/search";
import { matchShortcut } from "@/lib/shortcuts";
import type { Agent } from "@/lib/types";
import { ago, cn, projectColor } from "@/lib/utils";
import { StatusIcon } from "./StatusIcon";

type Props = {
  open: boolean;
  initialQuery?: string;
  hits: Hit[];
  agents: Agent[];
  /** This window's label ("main", or a floating window's). */
  here: string;
  onClose: () => void;
  /** What this window opens itself; windows and agents in other windows are handled here. */
  onPick: (t: Target) => void;
};

/**
 * ⌘K, in every window: the open windows as cards, then agents, prompts, artifacts and
 * Up next. What it lists is taken when it opens and stays put while you look.
 */
export function CommandPalette({ open, initialQuery = "", hits, agents, here, onClose, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [frozen, setFrozen] = useState<Hit[]>([]);
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const latest = useRef({ hits, agents });
  latest.current = { hits, agents };

  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setIndex(0);
    // A snapshot: statuses and times changing underneath must not move what you are reading.
    setFrozen([]);
    setWindows([]);
    invoke<OpenWindow[]>("window_list").then(
      (w) => {
        setWindows(w);
        setFrozen([...windowHits(w, latest.current.agents, here), ...latest.current.hits]);
      },
      () => setFrozen(latest.current.hits),
    );
    // After the open animation mounts the field.
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, initialQuery, here]);
  const results = useMemo(() => (open ? search(frozen, query) : []), [open, frozen, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (h: Hit | undefined) => {
    if (!h) return;
    onClose();
    const t = h.target;
    // An agent with a window of its own: that window comes forward.
    const own = t.kind === "agent" ? windows.find((w) => w.id === t.id) : undefined;
    if (t.kind === "window") void invoke("window_focus", { label: t.label });
    else if (own) {
      if (own.label !== here) void invoke("window_focus", { label: own.label });
    } else if (here === "main") onPick(t);
    else void invoke("palette_pick", { target: t });
  };
  const cards = results.filter((h) => h.section === "Windows").length;
  const onKey = (e: React.KeyboardEvent) => {
    const onCard = index < cards;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) setIndex((i) => Math.min(results.length - 1, i < cards ? cards : i + 1));
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) setIndex((i) => Math.max(0, i <= cards ? 0 : i - 1));
    else if (onCard && e.key === "ArrowRight") setIndex((i) => Math.min(cards - 1, i + 1));
    else if (onCard && e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Tab" && cards) setIndex((i) => (e.shiftKey ? (i - 1 + cards) % cards : (i + 1) % cards));
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
            className="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-strong bg-canvas shadow-2xl"
          >
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              <MagnifierLinearIcon size={17} className="shrink-0 text-ink-3" />
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search windows, agents, prompts, artifacts…"
                spellCheck={false}
                className="h-12 flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <kbd className="rounded border border-line-strong px-1.5 text-[10px] text-ink-3">esc</kbd>
            </div>
            <div ref={list} className="overflow-y-auto p-1.5">
              {frozen.length === 0 ? null : results.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches “{query}”.</p>
              ) : (
                <>
                  {cards > 0 && (
                    <div className="px-1 pb-1">
                      <div className="px-1.5 pt-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">Windows</div>
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                        {results.slice(0, cards).map((h, i) => (
                          <WindowTile key={h.key} hit={h} active={i === index} onHover={() => setIndex(i)} onPick={() => pick(h)} index={i} />
                        ))}
                      </div>
                    </div>
                  )}
                  {results.slice(cards).map((h, j) => {
                    const i = j + cards;
                    return (
                      <div key={h.key}>
                        {(j === 0 || results[i - 1].section !== h.section) && (
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
                    );
                  })}
                </>
              )}
            </div>
            {cards > 0 && (
              <div className="flex items-center gap-3 border-t border-line px-4 py-1.5 text-[11px] text-ink-3">
                <span>
                  <kbd className="font-sans">⇥</kbd> next window
                </span>
                <span>
                  <kbd className="font-sans">↵</kbd> go there
                </span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** One open window, as a card: its agent's project color, name and state. */
function WindowTile({ hit, active, index, onHover, onPick }: { hit: Hit; active: boolean; index: number; onHover: () => void; onPick: () => void }) {
  const w = hit.win!;
  const color = w.project ? projectColor(w.project) : undefined;
  return (
    <button
      type="button"
      data-index={index}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        "relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border p-3 text-left transition-colors",
        active ? "border-brand-500/70 bg-brand-500/[0.08] ring-2 ring-brand-500/20" : "border-line-strong hover:border-ink-3",
      )}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color ?? "var(--color-line-strong)" }} />
      <span className="flex items-center gap-1.5 text-[11px] text-ink-3">
        {w.main ? <MonitorLinearIcon size={13} /> : <WindowFrameLinearIcon size={13} />}
        <span className="min-w-0 truncate">{hit.detail}</span>
        {w.here && <span className="ml-auto shrink-0 rounded-full bg-line px-1.5 text-[10px] font-semibold">this one</span>}
      </span>
      <span className="truncate text-sm font-semibold text-ink">{hit.title}</span>
      {w.status && (
        <span className={cn("flex items-center gap-1.5 text-[11.5px]", w.status === "waiting" ? "text-amber-600 dark:text-amber-400" : w.status === "working" ? "text-brand-600 dark:text-brand-400" : "text-ink-3")}>
          <StatusIcon status={w.status} size={12} tip={false} />
          {w.status === "waiting" ? "Needs you" : w.status === "working" ? "Working" : w.status === "ended" ? "Closed" : "Idle"}
        </span>
      )}
    </button>
  );
}

/**
 * ⌘K in a floating window: the same search, with its own shortcut. What it picks opens in
 * the window that shows it (an agent's own window, else the main window).
 */
export function WindowPalette({ agents, artifacts, queues }: { agents: Agent[]; artifacts: Artifact[]; queues: Record<string, QueueEntry> }) {
  const [open, setOpen] = useState(false);
  const here = useMemo(() => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "float";
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchShortcut(e) !== "search") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const hits = useMemo(() => (open ? collect(agents, artifacts, queues, []) : []), [open, agents, artifacts, queues]);
  return <CommandPalette open={open} hits={hits} agents={agents} here={here} onClose={() => setOpen(false)} onPick={(t) => void invoke("palette_pick", { target: t })} />;
}
