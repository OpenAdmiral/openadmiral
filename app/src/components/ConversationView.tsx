import { useVirtualizer } from "@tanstack/react-virtual";
import { AltArrowDownLinearIcon, ArrowDownLinearIcon, ChatRoundDotsLinearIcon, CodeLinearIcon, MonitorLinearIcon } from "@solar-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Transcript, Turn } from "@/lib/transcript";
import { ago, cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

const REPLY_PREVIEW = 6000;

function duration(t: Turn) {
  if (!t.at || !t.endAt) return "";
  const s = Math.round((Date.parse(t.endAt) - Date.parse(t.at)) / 1000);
  if (s < 1) return "";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Props = {
  transcript: Transcript;
  running: boolean;
  now: number;
  /** Scroll this turn to the top and flash it; `at` makes a repeat click count. */
  jump?: { index: number; at: number };
  /** The turn being read (scroll-spy), for the index in the right column. */
  onActive: (index: number | null) => void;
  onReply?: () => void;
  onClaudeLink: (href: string) => void;
};

/** The whole transcript at reading width, one block per turn, virtualized. */
export function ConversationView({ transcript, running, now, jump, onActive, onReply, onClaudeLink }: Props) {
  const { turns, loading, found } = transcript;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  // The prompt of the turn being read, once its own card has scrolled out of view.
  const [pinned, setPinned] = useState<{ index: number; i: number } | null>(null);

  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 260,
    overscan: 4,
    getItemKey: (i) => turns[i]?.index ?? i,
  });

  // A new width (a panel opened or closed) changes every turn's height: remeasure once it settles.
  // `measure()` resets every size to the estimate, and the turns on screen will not resize again
  // to report theirs, so measure those straight away or they overlap at 260px apart.
  // `measure()` only clears the size cache: rebuild the measurements from it first, or
  // each turn still reads its old size, sees no change and stays at the estimate.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let width = el.clientWidth;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      clearTimeout(settle);
      settle = setTimeout(() => {
        virtualizer.measure();
        virtualizer.getVirtualItems();
        el.querySelectorAll<HTMLElement>("[data-index]").forEach((node) => virtualizer.measureElement(node));
      }, 120);
    });
    ro.observe(el);
    return () => {
      clearTimeout(settle);
      ro.disconnect();
    };
  }, [virtualizer]);

  // Follow new output while the reader is at the bottom.
  useLayoutEffect(() => {
    if (atBottom.current && turns.length) virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns]);

  // A jump waits until its turn has loaded (the transcript may still be reading).
  const pendingJump = useRef<{ index: number; at: number } | undefined>(undefined);
  useEffect(() => {
    pendingJump.current = jump;
  }, [jump?.at]);
  useEffect(() => {
    const jump = pendingJump.current;
    if (!jump) return;
    const i = turns.findIndex((t) => t.index === jump.index);
    if (i === -1) return;
    pendingJump.current = undefined;
    atBottom.current = false;
    virtualizer.scrollToIndex(i, { align: "start" });
    // A second pass once the target has been measured lands it exactly.
    const again = setTimeout(() => virtualizer.scrollToIndex(i, { align: "start" }), 80);
    setFlash(jump.index);
    const off = setTimeout(() => setFlash(null), 1300);
    return () => {
      clearTimeout(again);
      clearTimeout(off);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.at, turns.length]);

  // Scroll-spy: the turn under the reading line (a little below the top).
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setShowLatest(!atBottom.current);
    const line = el.scrollTop + 96;
    const item = virtualizer.getVirtualItems().find((v) => v.start <= line && v.end > line);
    const idx = item ? turns[item.index]?.index ?? null : null;
    const pin = item && el.scrollTop > item.start + 110 ? { index: idx!, i: item.index } : null;
    if (pin?.index !== pinned?.index) setPinned(pin);
    if (idx !== active) {
      setActive(idx);
      onActive(idx);
    }
  };
  useEffect(() => {
    onScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length]);

  const last = turns.at(-1)?.index;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div ref={scroller} onScroll={onScroll} className="selectable min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-8 text-sm text-ink-3">Reading the transcript…</p>
        ) : !found ? (
          <p className="p-8 text-sm text-ink-3">No transcript for this session yet.</p>
        ) : turns.length === 0 ? (
          <p className="p-8 text-sm text-ink-3">No prompts yet.</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const t = turns[v.index];
              return (
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                  <TurnBlock turn={t} now={now} active={active === t.index} flash={flash === t.index} live={running && t.index === last} onClaudeLink={onClaudeLink} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pinned && turns[pinned.i] && (
        <button
          onClick={() => virtualizer.scrollToIndex(pinned.i, { align: "start" })}
          title="Back to the start of this turn"
          className="absolute inset-x-0 top-0 z-20 border-b border-line bg-canvas/95 px-8 py-2 text-left backdrop-blur"
        >
          <span className="mx-auto flex max-w-3xl items-center gap-2.5">
            <ChatRoundDotsLinearIcon size={14} className="shrink-0 text-brand-600 dark:text-brand-400" />
            <span className="line-clamp-1 flex-1 text-xs text-ink">{turns[pinned.i].prompt}</span>
            <span className="shrink-0 text-[10px] text-ink-3">↑ start of turn</span>
          </span>
        </button>
      )}

      {showLatest && turns.length > 0 && (
        <button
          onClick={() => {
            atBottom.current = true;
            virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
          }}
          className="absolute bottom-16 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg transition-all hover:bg-brand-700"
        >
          <ArrowDownLinearIcon size={14} />
          Jump to latest
        </button>
      )}

      <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-2">
        <span className="text-[11px] text-ink-3 tabular">{turns.length} prompt{turns.length === 1 ? "" : "s"}</span>
        {onReply ? (
          <button onClick={onReply} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-brand-700">
            <MonitorLinearIcon size={14} />
            Reply in terminal
          </button>
        ) : (
          <span className="text-[11px] text-ink-3">Bring this session into OpenAdmiral to reply from here.</span>
        )}
      </div>
    </div>
  );
}

function TurnBlock({ turn: t, now, active, flash, live, onClaudeLink }: { turn: Turn; now: number; active: boolean; flash: boolean; live: boolean; onClaudeLink: (href: string) => void }) {
  const [more, setMore] = useState(false);
  const reply = more || t.reply.length <= REPLY_PREVIEW ? t.reply : `${t.reply.slice(0, REPLY_PREVIEW).trimEnd()}…`;
  const at = t.at ? Date.parse(t.at) : undefined;
  return (
    <section
      className={cn(
        "relative border-b border-line px-8 pb-6 transition-colors duration-500",
        active && "bg-brand-500/[0.035]",
        flash && "bg-brand-500/[0.12]",
      )}
    >
      {/* The turn being read: a quiet accent along its left edge. */}
      <span className={cn("absolute inset-y-0 left-0 w-[3px] transition-colors duration-300", active || flash ? "bg-brand-500" : "bg-transparent", live && "animate-breathe bg-brand-500")} />
      {/* The user's prompt; the bar at the top of the view repeats it while its turn scrolls by. */}
      <header className="pt-5 pb-3">
        <div className="mx-auto flex max-w-3xl gap-3 rounded-xl border border-brand-500/25 bg-brand-500/[0.06] px-4 py-3">
          {t.kind === "prompt" ? <ChatRoundDotsLinearIcon size={16} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" /> : <CodeLinearIcon size={16} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />}
          <div className="min-w-0 flex-1">
            <p className={cn("whitespace-pre-wrap text-sm leading-relaxed text-ink", t.kind !== "prompt" && "font-mono text-[13px]", "line-clamp-6")}>{t.prompt}</p>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3 tabular">
              {t.source && <span className="rounded bg-brand-500/12 px-1 font-semibold text-brand-700 dark:text-brand-300">{t.source === "queue" ? "queued" : t.source}</span>}
              {at && <span title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {ago(at, now)} ago</span>}
              {duration(t) && <span>· took {duration(t)}</span>}
              {live && <span className="font-semibold text-brand-600 dark:text-brand-400">· running</span>}
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-3 pt-1">
        {t.tools.length > 0 && <Tools tools={t.tools} />}
        {t.reply ? (
          <div className="text-sm leading-relaxed text-ink-2">
            <Markdown className="admiral-doc" onClaudeLink={onClaudeLink}>{reply}</Markdown>
            {t.reply.length > REPLY_PREVIEW && (
              <button onClick={() => setMore(!more)} className="mt-2 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">
                {more ? "Show less" : "Show the whole reply"}
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-3">{live ? "Working on it…" : "No reply text."}</p>
        )}
      </div>
    </section>
  );
}

/** Tool calls as compact rows; a row opens to its input and the start of its result. */
function Tools({ tools }: { tools: Turn["tools"] }) {
  const [all, setAll] = useState(tools.length <= 6);
  const [open, setOpen] = useState<number | null>(null);
  const shown = all ? tools : tools.slice(0, 4);
  return (
    <div className="rounded-lg border border-line bg-panel/60">
      {shown.map((tool, i) => (
        <div key={i} className="border-b border-line last:border-0">
          <button onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11.5px] hover:bg-line/60">
            <span className={cn("size-1.5 shrink-0 rounded-full", tool.isError ? "bg-red-500" : tool.result !== undefined ? "bg-emerald-500" : "bg-gray-400")} />
            <span className="shrink-0 font-semibold text-ink-2">{tool.name}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3">{tool.summary}</span>
            <AltArrowDownLinearIcon size={12} className={cn("shrink-0 text-ink-3 transition-transform", open === i && "rotate-180")} />
          </button>
          {open === i && (
            <div className="space-y-1.5 px-3 pb-2.5 font-mono text-[11px] leading-relaxed">
              {tool.input && <pre className="whitespace-pre-wrap break-all rounded-md bg-canvas px-2 py-1.5 text-ink-2">{tool.input}</pre>}
              {tool.result !== undefined && (
                <pre className={cn("max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md px-2 py-1.5", tool.isError ? "bg-red-500/10 text-red-700 dark:text-red-300" : "bg-canvas text-ink-3")}>
                  {tool.result || "(empty result)"}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
      {!all && (
        <button onClick={() => setAll(true)} className="w-full px-3 py-1.5 text-left text-[11px] text-ink-3 hover:text-ink">
          Show all {tools.length} tool calls
        </button>
      )}
    </div>
  );
}
