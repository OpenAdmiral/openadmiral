import { AlarmLinearIcon, RepeatLinearIcon } from "@solar-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_DAYS, WEEKDAYS, classifyQueueText, parseSlash, scheduleLabel, suggestCommands, type QueueCommand, type QueueCondition } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** A queued text as it will go: a slash command reads as one (mono, its name tinted), a prompt as prose. */
export function QueueText({ text, className, clamp = 3 }: { text: string; className?: string; clamp?: 2 | 3 }) {
  const slash = text.trim().startsWith("/") ? parseSlash(text) : undefined;
  if (slash)
    return (
      <p className={cn("selectable font-mono text-[11.5px] leading-5 text-ink", clamp === 2 ? "line-clamp-2" : "line-clamp-3", className)}>
        <span className="rounded bg-brand-500/10 px-1 py-px font-semibold text-brand-700 dark:text-brand-300">/{slash.name}</span>
        {slash.args && <span className="text-ink-2"> {slash.args}</span>}
      </p>
    );
  return <p className={cn("selectable text-xs leading-5 text-ink", clamp === 2 ? "line-clamp-2" : "line-clamp-3", className)}>{text}</p>;
}

/** Ticks so relative labels ("next in 3h") stay true. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Why this text cannot be queued for the session, or undefined when it can. */
export const queueTextProblem = (text: string, commands: readonly QueueCommand[] | undefined) => {
  const c = classifyQueueText(text, commands);
  return c.kind === "rejected" ? c.reason : undefined;
};

/**
 * The prompt box of Up next: "/" offers the session's queueable commands
 * (↑↓ to move, Tab or ↵ to take one), and a command Up next cannot run is
 * explained under the box instead of being accepted.
 */
export function QueueInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  commands,
  placeholder,
  autoFocus,
  rows,
  className,
  onReloadPlugins,
  whereElse,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  commands: readonly QueueCommand[] | undefined;
  placeholder?: string;
  autoFocus?: boolean;
  rows?: number;
  className?: string;
  /** When the session's mod predates slash commands: put /reload-plugins in its prompt. */
  onReloadPlugins?: () => void;
  /** Agents that do have a command this session lacks (project skills live in their repo). */
  whereElse?: (name: string) => string[];
}) {
  const [pick, setPick] = useState(0);
  const [dismissed, setDismissed] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(() => (dismissed === value ? [] : suggestCommands(commands, value)), [commands, value, dismissed]);
  const exact = suggestions.length === 1 && `/${suggestions[0].name}` === value;
  const open = suggestions.length > 0 && !exact;
  const problem = value.trim() ? queueTextProblem(value, commands) : undefined;
  // While the name is still being typed, the list is the answer; the error waits for a space.
  const showProblem = problem && value.trim() !== "/" && !(open && !/\s/.test(value));
  useEffect(() => setPick(0), [value]);
  // Esc hides the list for this exact text only: any edit (e.g. clearing and typing "/" again) brings it back.
  useEffect(() => {
    if (dismissed && value !== dismissed) setDismissed("");
  }, [value, dismissed]);

  const take = (c: QueueCommand) => {
    onChange(`/${c.name} `);
    ref.current?.focus();
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus={autoFocus}
        value={value}
        rows={rows ?? (value.includes("\n") ? 3 : 2)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
              return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey)) {
              e.preventDefault();
              take(suggestions[pick] ?? suggestions[0]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(value);
              return;
            }
          }
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            if (value.trim() && !problem) onSubmit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        className={cn(
          "w-full resize-none rounded-lg border bg-canvas px-2.5 py-1.5 text-xs leading-5 text-ink placeholder:text-ink-3 transition-all duration-200 focus:outline-none focus:ring-2",
          value.trim().startsWith("/") && "font-mono text-[11.5px]",
          showProblem ? "border-red-500/60 focus:border-red-500 focus:ring-red-500/20" : "border-line-strong focus:border-brand-500 focus:ring-brand-500/25",
          className,
        )}
      />
      {open && (
        // In the flow, not floating: the inspector's blocks clip anything that overflows them.
        <ul role="listbox" className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-line-strong bg-canvas py-1 shadow-xl">
          {suggestions.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === pick}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  take(c);
                }}
                onMouseEnter={() => setPick(i)}
                className={cn("flex w-full items-baseline gap-2 px-2.5 py-1 text-left", i === pick && "bg-brand-500/10")}
              >
                <span className="shrink-0 font-mono text-[11.5px] font-semibold text-ink">/{c.name}</span>
                {c.kind === "skill" && <span className="shrink-0 rounded bg-line px-1 text-[9.5px] font-semibold uppercase tracking-wide text-ink-3">prompt</span>}
                <span className="truncate text-[11px] text-ink-3">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {showProblem && (
        <p className="mt-1 text-[10.5px] leading-snug text-red-600 dark:text-red-400">
          {problem}
          {(() => {
            const name = value.trim().match(/^\/([^\s]+)/)?.[1];
            const others = commands && name ? (whereElse?.(name) ?? []) : [];
            return others.length ? ` It is a command of ${others.slice(0, 2).join(", ")}${others.length > 2 ? "…" : ""}: queue it there.` : null;
          })()}
        </p>
      )}
      {showProblem && !commands && onReloadPlugins && (
        <button
          type="button"
          onClick={onReloadPlugins}
          className="mt-1.5 rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-semibold text-ink-2 transition-colors hover:bg-line hover:text-ink"
        >
          Type /reload-plugins in its terminal
        </button>
      )}
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Monday first, as a European week reads.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Once at a date and time, or every day / weekdays / chosen days at HH:MM. */
export function SchedulePicker({ value, onChange }: { value?: QueueCondition; onChange: (c: QueueCondition | undefined) => void }) {
  const timed = value && (value.kind === "time" || value.kind === "schedule") ? value : undefined;
  const [mode, setMode] = useState<"once" | "repeat">(timed?.kind === "schedule" ? "repeat" : "once");
  const defaultAt = () => {
    // The next round hour.
    const d = new Date();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d.getTime();
  };
  const at = timed?.kind === "time" ? timed.at : undefined;
  const sched = timed?.kind === "schedule" ? timed : undefined;
  const days = sched?.days ?? WEEKDAYS;
  const time = sched?.time ?? "09:00";
  const preset = days.length === 7 ? "daily" : days.join() === WEEKDAYS.join() ? "weekdays" : "custom";

  const field = "rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink focus:border-brand-500 focus:outline-none [color-scheme:light] dark:[color-scheme:dark]";
  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md bg-line p-0.5 text-[11px]">
        {(["once", "repeat"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              onChange(m === "once" ? { kind: "time", at: at ?? defaultAt() } : { kind: "schedule", time, days });
            }}
            className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-ink-2 transition-colors", mode === m && "bg-canvas font-semibold text-ink shadow-sm")}
          >
            {m === "once" ? <AlarmLinearIcon size={11} /> : <RepeatLinearIcon size={11} />}
            {m === "once" ? "Once" : "Repeat"}
          </button>
        ))}
      </div>
      {mode === "once" ? (
        <input
          type="datetime-local"
          value={localInput(at ?? defaultAt())}
          min={localInput(Date.now())}
          onChange={(e) => {
            const t = new Date(e.target.value).getTime();
            if (!Number.isNaN(t)) onChange({ kind: "time", at: t });
          }}
          className={cn(field, "w-full")}
        />
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <select
              value={preset}
              onChange={(e) => onChange({ kind: "schedule", time, days: e.target.value === "daily" ? ALL_DAYS : e.target.value === "weekdays" ? WEEKDAYS : days })}
              className={cn(field, "flex-1")}
            >
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="custom">Chosen days</option>
            </select>
            <span className="text-[11px] text-ink-3">at</span>
            <input type="time" value={time} onChange={(e) => e.target.value && onChange({ kind: "schedule", time: e.target.value, days })} className={field} />
          </div>
          <div className="flex gap-1">
            {WEEK_ORDER.map((d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  title={DAY_NAME[d]}
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? days.filter((x) => x !== d) : [...days, d].sort();
                    if (next.length) onChange({ kind: "schedule", time, days: next });
                  }}
                  className={cn(
                    "size-6 rounded-full text-[10.5px] font-semibold transition-colors",
                    on ? "bg-brand-600 text-white" : "bg-line text-ink-3 hover:text-ink",
                  )}
                >
                  {DAY_LETTER[d]}
                </button>
              );
            })}
          </div>
          <p className="text-[10.5px] text-ink-3">{scheduleLabel({ kind: "schedule", time, days })} · stays in the queue after each run</p>
        </div>
      )}
    </div>
  );
}
