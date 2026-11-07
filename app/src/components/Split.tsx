import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { COLUMNS, LAYOUTS, type SplitLayout } from "@/lib/split";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";
import { StatusIcon } from "./StatusIcon";
import { Tip, TipLabel } from "./Tooltip";
import { Kbd } from "./primitives";

/**
 * The panes of a split chat area. `render(i)` draws pane i; the dividers drag (double-click
 * puts one back in the middle). Four panes share the vertical divider, so they stay a grid.
 */
export function SplitPanes({ layout, ratios, onRatios, render }: { layout: SplitLayout; ratios?: number[]; onRatios: (r: number[]) => void; render: (i: number) => ReactNode }) {
  // Three in a line: the first divider sits at a third, the second halves the rest.
  const columns = COLUMNS[layout];
  const even = layout === "3v" || layout === "3h" || columns ? 1 / 3 : 0.5;
  const all = [ratios?.[0] ?? even, ratios?.[1] ?? 0.5, ratios?.[2] ?? 0.5, ratios?.[3] ?? 0.5, ratios?.[4] ?? 0.5];
  const [a, b] = all;
  const set = (i: number, x: number) => onRatios(all.map((r, j) => (j === i ? x : r)));
  const setA = (x: number) => set(0, x);
  const setB = (x: number) => set(1, x);
  if (columns) {
    let next = 0;
    // Each column's panes, in order; a split one has its own divider.
    const [c0, c1, c2] = columns.map((count, c) => {
      const first = next;
      next += count;
      return count === 1 ? render(first) : <Two dir="col" ratio={all[2 + c]} onRatio={(x) => set(2 + c, x)} first={render(first)} second={render(first + 1)} />;
    });
    return <Two dir="row" ratio={a} even={even} onRatio={setA} first={c0} second={<Two dir="row" ratio={b} onRatio={setB} first={c1} second={c2} />} />;
  }
  switch (layout) {
    case "2v":
      return <Two dir="row" ratio={a} onRatio={setA} first={render(0)} second={render(1)} />;
    case "2h":
      return <Two dir="col" ratio={a} onRatio={setA} first={render(0)} second={render(1)} />;
    case "3v":
      return <Two dir="row" ratio={a} even={even} onRatio={setA} first={render(0)} second={<Two dir="row" ratio={b} onRatio={setB} first={render(1)} second={render(2)} />} />;
    case "3h":
      return <Two dir="col" ratio={a} even={even} onRatio={setA} first={render(0)} second={<Two dir="col" ratio={b} onRatio={setB} first={render(1)} second={render(2)} />} />;
    case "3l":
      return <Two dir="row" ratio={a} onRatio={setA} first={render(0)} second={<Two dir="col" ratio={b} onRatio={setB} first={render(1)} second={render(2)} />} />;
    case "3t":
      return <Two dir="col" ratio={a} onRatio={setA} first={render(0)} second={<Two dir="row" ratio={b} onRatio={setB} first={render(1)} second={render(2)} />} />;
    case "4":
      return (
        <Two
          dir="col"
          ratio={a}
          onRatio={setA}
          first={<Two dir="row" ratio={b} onRatio={setB} first={render(0)} second={render(1)} />}
          second={<Two dir="row" ratio={b} onRatio={setB} first={render(2)} second={render(3)} />}
        />
      );
    default:
      return <>{render(0)}</>;
  }
}

function Two({ dir, ratio, even = 0.5, onRatio, first, second }: { dir: "row" | "col"; ratio: number; even?: number; onRatio: (r: number) => void; first: ReactNode; second: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const row = dir === "row";
  const move = (e: React.PointerEvent) => {
    if (!dragging || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const x = row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    onRatio(Math.round(Math.min(0.8, Math.max(0.15, x)) * 1000) / 1000);
  };
  return (
    <div ref={box} className={cn("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col")}>
      <div className="min-h-0 min-w-0" style={{ flex: `${ratio} 1 0` }}>
        {first}
      </div>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        title="Drag to resize; double-click to even out"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={move}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => onRatio(even)}
        className={cn("group relative z-10 shrink-0", row ? "-mx-1 w-2 cursor-col-resize" : "-my-1 h-2 cursor-row-resize")}
      >
        <span
          className={cn(
            "absolute rounded-full bg-brand-500 opacity-0 transition-opacity duration-150 group-hover:opacity-60",
            dragging && "opacity-90",
            row ? "inset-y-6 left-1/2 w-[3px] -translate-x-1/2" : "inset-x-6 top-1/2 h-[3px] -translate-y-1/2",
          )}
        />
      </div>
      <div className="min-h-0 min-w-0" style={{ flex: `${1 - ratio} 1 0` }}>
        {second}
      </div>
      {/* While dragging, terminals and frames would swallow the pointer. */}
      {dragging && <div className={cn("fixed inset-0 z-50", row ? "cursor-col-resize" : "cursor-row-resize")} />}
    </div>
  );
}

type GridLayout = Exclude<SplitLayout, "3v" | "3h" | "c112" | "c122" | "c222">;

/** A small drawing of a layout: its panes as rounded blocks. */
export function LayoutGlyph({ layout, className }: { layout: SplitLayout; className?: string }) {
  const cell = "rounded-[2px] bg-current";
  const grid: Record<GridLayout, ReactNode> = {
    "1": <span className={cn(cell, "col-span-2 row-span-2")} />,
    "2v": (
      <>
        <span className={cn(cell, "row-span-2")} />
        <span className={cn(cell, "row-span-2")} />
      </>
    ),
    "2h": (
      <>
        <span className={cn(cell, "col-span-2")} />
        <span className={cn(cell, "col-span-2")} />
      </>
    ),
    "3l": (
      <>
        <span className={cn(cell, "row-span-2")} />
        <span className={cell} />
        <span className={cell} />
      </>
    ),
    "3t": (
      <>
        <span className={cn(cell, "col-span-2")} />
        <span className={cell} />
        <span className={cell} />
      </>
    ),
    "4": (
      <>
        <span className={cell} />
        <span className={cell} />
        <span className={cell} />
        <span className={cell} />
      </>
    ),
  };
  const columns = COLUMNS[layout];
  if (columns)
    return (
      <span className={cn("flex size-4 gap-[2px]", className)}>
        {columns.map((count, c) => (
          <span key={c} className="flex flex-1 flex-col gap-[inherit]">
            {Array.from({ length: count }, (_, i) => (
              <span key={i} className={cn(cell, "flex-1")} />
            ))}
          </span>
        ))}
      </span>
    );
  if (layout === "3v" || layout === "3h")
    return (
      <span className={cn("grid size-4 gap-[2px]", layout === "3v" ? "grid-cols-3" : "grid-rows-3", className)}>
        <span className={cell} />
        <span className={cell} />
        <span className={cell} />
      </span>
    );
  return <span className={cn("grid size-4 grid-cols-2 grid-rows-2 gap-[2px]", className)}>{grid[layout as GridLayout]}</span>;
}

/** The header's layout button: the six layouts and the text size. */
export function ViewMenu({
  layout,
  onLayout,
  scale,
  onScale,
  dense,
  onDense,
  onToWindow,
}: {
  layout: SplitLayout;
  onLayout: (l: SplitLayout) => void;
  scale: number;
  onScale: (dir: 1 | -1 | 0) => void;
  dense: boolean;
  onDense: () => void;
  /** The main window's: its panes' agents go to a new window with a grid of its own. */
  onToWindow?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Preview screenshots open it with OPENADMIRAL_TIP=view-menu.
  useEffect(() => {
    const onTip = (e: Event) => (e as CustomEvent).detail === "view-menu" && setOpen(true);
    window.addEventListener("openadmiral:tip", onTip);
    return () => window.removeEventListener("openadmiral:tip", onTip);
  }, []);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Tip side="bottom" content={open ? null : <TipLabel label="Layout and text size" kbd="⌘\" />}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Layout and text size"
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-2 transition-all duration-200 hover:bg-line hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand-500",
            open && "bg-line text-ink",
          )}
        >
          <LayoutGlyph layout={layout} className="opacity-80" />
        </button>
      </Tip>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full right-0 z-40 mt-1.5 w-[248px] rounded-xl bg-canvas p-3 shadow-2xl ring-1 ring-line-strong dark:bg-[#1d2026]"
          >
            <div className="mb-2 flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              Layout
              <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal">
                <Kbd>⌘\</Kbd> split / one
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  title={l.label}
                  aria-label={l.label}
                  aria-pressed={layout === l.id}
                  onClick={() => onLayout(l.id)}
                  className={cn(
                    "flex h-12 items-center justify-center rounded-lg ring-1 transition-colors",
                    layout === l.id ? "bg-brand-500/12 text-brand-600 ring-brand-500/50 dark:text-brand-400" : "text-ink-3 ring-line hover:bg-line hover:text-ink-2",
                  )}
                >
                  <LayoutGlyph layout={l.id} className="size-6 gap-[3px]" />
                </button>
              ))}
            </div>
            <button
              role="switch"
              aria-checked={dense}
              onClick={onDense}
              disabled={layout === "1"}
              className="mt-2.5 flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-xs text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
            >
              <span className="flex-1">
                <span className="block font-medium text-ink">Compact panes</span>
                <span className="block text-[10.5px] text-ink-3">One line per pane, tabs as icons</span>
              </span>
              <span className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", dense ? "bg-brand-600" : "bg-line-strong")}>
                <span className={cn("absolute top-[2px] size-[14px] rounded-full bg-white shadow transition-[left] duration-150", dense ? "left-[16px]" : "left-[2px]")} />
              </span>
            </button>
            {onToWindow && (
              <button
                onClick={() => {
                  setOpen(false);
                  onToWindow();
                }}
                className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-xs text-ink-2 transition-colors hover:text-ink"
              >
                <span className="flex-1">
                  <span className="block font-medium text-ink">Move these panes to a new window</span>
                  <span className="block text-[10.5px] text-ink-3">A window with a grid of its own</span>
                </span>
              </button>
            )}
            <div className="mt-3.5 mb-2 flex items-center text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              Text size
              <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal">
                <Kbd>⌘+</Kbd> <Kbd>⌘−</Kbd>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => onScale(-1)} disabled={scale <= 0.8} aria-label="Smaller text" className="h-8 flex-1 rounded-lg text-xs font-semibold text-ink-2 ring-1 ring-line transition-colors hover:bg-line disabled:opacity-40">
                A−
              </button>
              <button onClick={() => onScale(0)} title="Back to the default size" className="h-8 w-16 rounded-lg text-xs text-ink-2 tabular ring-1 ring-line transition-colors hover:bg-line">
                {Math.round(scale * 100)}%
              </button>
              <button onClick={() => onScale(1)} disabled={scale >= 1.6} aria-label="Bigger text" className="h-8 flex-1 rounded-lg text-sm font-semibold text-ink-2 ring-1 ring-line transition-colors hover:bg-line disabled:opacity-40">
                A+
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** An empty pane: the agents not on screen, to pick one (or pick in the sidebar). */
export function PanePicker({ agents, active, onPick, onFocus, sidebar = true }: { agents: Agent[]; active: boolean; onPick: (id: string) => void; onFocus: () => void; sidebar?: boolean }) {
  return (
    <div className="flex h-full min-w-0 overflow-hidden p-1.5" onPointerDown={onFocus}>
      <div
        className={cn(
          // Safe centering: in a small pane the list scrolls instead of spilling over its neighbours.
          "flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center-safe overflow-hidden rounded-2xl border border-dashed p-4 text-center transition-colors",
          active ? "border-brand-500/60 bg-brand-500/[0.04]" : "border-line-strong",
        )}
      >
        <p className="text-sm font-semibold text-ink">Pick an agent for this pane</p>
        <p className="mt-0.5 mb-3 text-xs text-ink-3">
          {!sidebar ? "It moves here from the window it is in." : active ? "Or click one in the sidebar." : "Click here, then pick one in the sidebar."}
        </p>
        <div className="flex min-h-0 w-full max-w-xs flex-col gap-0.5 overflow-y-auto text-left">
          {agents.map((a) => (
            <button key={a.id} onClick={() => onPick(a.id)} className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-line">
              <StatusIcon status={a.status} tip={false} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{a.name}</span>
              {a.project !== a.name && <span className="min-w-0 max-w-[45%] truncate text-[11px] text-ink-3">{a.project}</span>}
            </button>
          ))}
          {agents.length === 0 && <p className="text-center text-xs text-ink-3">Every agent is already on screen.</p>}
        </div>
      </div>
    </div>
  );
}
