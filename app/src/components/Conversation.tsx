import { AltArrowDownLinearIcon, ChatRoundDotsLinearIcon, CodeLinearIcon } from "@solar-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Transcript, Turn } from "@/lib/transcript";
import { ago, cn } from "@/lib/utils";


function duration(t: Turn) {
  if (!t.at || !t.endAt) return "";
  const s = Math.round((Date.parse(t.endAt) - Date.parse(t.at)) / 1000);
  if (s < 1) return "";
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Wraps matches of `q` in <mark>, case-insensitive. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-amber-300/60 px-0.5 text-ink dark:bg-amber-400/40">{p}</mark> : p))}</>;
}

/** The session's conversation, one card per prompt, newest at the bottom. */
/**
 * The prompt index in the right column: one compact card per prompt, newest at
 * the bottom. A click (or ↑/↓ and Enter) jumps the Conversation tab to that
 * turn; the turn being read there stays highlighted here.
 */
export function Conversation({ transcript, running, now, active, onJump }: { transcript: Transcript; running: boolean; now: number; active: number | null; onJump: (index: number) => void }) {
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const { turns, loading, found } = transcript;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? turns.filter((t) => t.prompt.toLowerCase().includes(needle) || t.reply.toLowerCase().includes(needle)) : turns;
  }, [turns, q]);
  const last = turns.at(-1)?.index;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current && !q && active === null) el.scrollTop = el.scrollHeight;
  }, [turns, q, active]);

  // Keep the card of the turn being read (or the keyboard focus) in view.
  useEffect(() => {
    const target = focus ?? active;
    if (target === null) return;
    scroller.current?.querySelector(`[data-turn="${target}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus, active]);

  const onKey = (e: React.KeyboardEvent) => {
    const ids = shown.map((t) => t.index);
    if (!ids.length) return;
    const i = focus === null ? ids.length : ids.indexOf(focus);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus(ids[Math.min(ids.length - 1, i + 1)]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus(ids[Math.max(0, (i === -1 ? ids.length : i) - 1)]);
    } else if (e.key === "Enter" && focus !== null) {
      e.preventDefault();
      onJump(focus);
    }
  };

  return (
    // The body of the inspector's "Prompts" block; its header (title, count) is the block's.
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div className="border-b border-line px-3 pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search prompts and replies…"
          className="h-7 w-full rounded-md border border-line-strong bg-canvas px-2 text-xs text-ink placeholder:text-ink-3 transition-all duration-200 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
        />
      </div>
      <div
        ref={scroller}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 outline-none"
      >
        {loading ? (
          <p className="px-2 py-3 text-xs text-ink-3">Reading the transcript…</p>
        ) : !found ? (
          <p className="px-2 py-3 text-xs text-ink-3">No transcript for this session yet.</p>
        ) : shown.length === 0 ? (
          <p className="px-2 py-3 text-xs text-ink-3">{q ? "Nothing matches." : "No prompts yet."}</p>
        ) : (
          shown.map((t) => (
            <Card
              key={t.index}
              turn={t}
              q={q.trim()}
              active={active === t.index}
              focused={focus === t.index}
              live={running && t.index === last}
              now={now}
              onClick={() => {
                setFocus(t.index);
                onJump(t.index);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Card({ turn: t, q, active, focused, live, now, onClick }: { turn: Turn; q: string; active: boolean; focused: boolean; live: boolean; now: number; onClick: () => void }) {
  const at = t.at ? Date.parse(t.at) : undefined;
  return (
    <article
      data-turn={t.index}
      className={cn(
        "relative overflow-hidden rounded-lg border transition-colors duration-200",
        active ? "border-brand-500/40 bg-brand-500/[0.07]" : "border-transparent hover:bg-line/70",
        focused && !active && "ring-1 ring-brand-500/50",
      )}
    >
      {(live || active) && <span className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand-500", live && "animate-breathe")} />}
      <button onClick={onClick} className="flex w-full items-start gap-2 px-2.5 py-2 text-left outline-none">
        {t.kind === "prompt" ? (
          <ChatRoundDotsLinearIcon size={14} className={cn("mt-[3px] shrink-0", live || active ? "text-brand-500" : "text-ink-3")} />
        ) : (
          <CodeLinearIcon size={14} className="mt-[3px] shrink-0 text-ink-3" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn("block text-xs leading-5 text-ink line-clamp-2", t.kind !== "prompt" && "font-mono text-[11px]")}>
            <Highlight text={t.prompt} q={q} />
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[10px] text-ink-3 tabular">
            {t.source && <span className="rounded bg-brand-500/12 px-1 font-semibold text-brand-700 dark:text-brand-300">{t.source === "queue" ? "queued" : t.source}</span>}
            {at && <span title={new Date(at).toLocaleString()}>{ago(at, now)} ago</span>}
            {t.tools.length > 0 && <span>{t.tools.length} tool{t.tools.length > 1 ? "s" : ""}</span>}
            {duration(t) && <span>{duration(t)}</span>}
            {live && <span className="font-semibold text-brand-600 dark:text-brand-400">running</span>}
          </span>
        </span>
      </button>
    </article>
  );
}

/** A section whose open/closed state the viewer keeps between runs. */
export function Collapsible({ id, title, aside, children, defaultOpen = false }: { id: string; title: string; aside?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const key = `openadmiral.collapsed.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === "open";
    } catch {
      return defaultOpen;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? "closed" : "open");
    } catch {
      // A convenience only.
    }
  };
  return (
    <section className="shrink-0 rounded-xl border border-line bg-canvas/70 shadow-sm backdrop-blur">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
        {aside && <span className="text-[11px] text-ink-3 tabular">{aside}</span>}
        <AltArrowDownLinearIcon size={14} className={cn("ml-auto text-ink-3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && <div className="max-h-64 overflow-y-auto px-3 pb-3">{children}</div>}
    </section>
  );
}
