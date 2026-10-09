/**
 * Up next scheduling and slash-command rules, shared with the mod: the rules
 * themselves live in ../../../plugin/hooks/queue.ts (one source for both sides);
 * this file adds what the UI needs on top (labels, grouping, recently sent). Pure.
 */
import {
  ALL_DAYS,
  WEEKDAYS,
  classifyQueueText,
  isDone,
  isDueByTime,
  isRecurring,
  isTimed,
  lastRun,
  needsSessionNow,
  nextDue,
  nextOccurrence,
  parseSlash,
  parseTime,
  runNowPending,
  type Classified,
  type QueueCommand,
  type QueueCondition,
  type QueueItemCore,
  type ScheduleCondition,
  type SentEntry,
} from "../../../plugin/hooks/queue";

export {
  ALL_DAYS,
  WEEKDAYS,
  classifyQueueText,
  isDone,
  isDueByTime,
  isRecurring,
  isTimed,
  lastRun,
  needsSessionNow,
  nextDue,
  nextOccurrence,
  parseSlash,
  parseTime,
  runNowPending,
};
export type { Classified, QueueCommand, QueueCondition, QueueItemCore, ScheduleCondition, SentEntry };

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "every day 09:00", "weekdays 09:00", "weekends 18:30", "Mon, Thu 09:00". */
export function scheduleLabel(s: ScheduleCondition) {
  const days = [...new Set(s.days.length ? s.days : ALL_DAYS)].sort();
  const key = days.join(",");
  const which =
    key === ALL_DAYS.join(",") ? "every day" : key === WEEKDAYS.join(",") ? "weekdays" : key === "0,6" ? "weekends" : [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)].map((d) => DAY[d]).join(", ");
  return `${which} ${s.time}`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "09:00 today", "09:00 tomorrow", "09:00 Thu", "09:00 Oct 12". */
export function whenLabel(at: number, now: number) {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  const d = new Date(at);
  const day =
    days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : days > 1 && days < 7 ? DAY[d.getDay()] : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${hhmm(at)} ${day}`;
}

/** "in 12m", "in 3h", "in 3h 20m", "in 2d"; "now" when due. */
export function inLabel(at: number, now: number) {
  const m = Math.round((at - now) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 10) return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

/** What a timed item shows: "at 09:00 tomorrow", "weekdays 09:00 · next in 3h". */
export function timeLabel(after: QueueCondition, item: QueueItemCore, sent: readonly SentEntry[], now: number): string | undefined {
  if (after.kind === "time") return after.at <= now ? `due since ${whenLabel(after.at, now)}` : `at ${whenLabel(after.at, now)}`;
  if (after.kind !== "schedule") return undefined;
  const next = nextDue(item, sent);
  const label = scheduleLabel(after);
  if (next === undefined) return label;
  return next <= now ? `${label} · due now` : `${label} · next ${inLabel(next, now)}`;
}

export type CentralGroup = "scheduled" | "waiting" | "ready";

/** Which section of the Up next view an item sits in: timed first, then gated, else ready. */
export function centralGroup(item: QueueItemCore, conditionMet: boolean): CentralGroup {
  if (isTimed(item)) return "scheduled";
  if (item.after && !conditionMet) return "waiting";
  return "ready";
}

/** Sort key inside "Scheduled": the next due time (overdue first), unknown last. */
export const scheduledSortKey = (item: QueueItemCore, sent: readonly SentEntry[]) => (runNowPending(item, sent) ? 0 : nextDue(item, sent) ?? Number.MAX_SAFE_INTEGER);

/** Late enough to call a catch-up run (OpenAdmiral or the session was closed when it was due). */
export const LATE_MS = 5 * 60_000;
export const isLate = (s: SentEntry) => s.due !== undefined && s.at - s.due > LATE_MS;

export type RecentSent = SentEntry & { sessionId: string; label: string };

/** What the mod sent in the last `windowMs`, newest first, with the text it went out as. */
export function recentSent(
  queues: Record<string, { queue?: { items?: QueueItemCore[] }; sent?: { sent: SentEntry[] } }>,
  now: number,
  windowMs = 86_400_000,
): RecentSent[] {
  const out: RecentSent[] = [];
  for (const [sessionId, entry] of Object.entries(queues)) {
    for (const s of entry.sent?.sent ?? []) {
      if (now - s.at > windowMs) continue;
      const label = s.text ?? entry.queue?.items?.find((i) => i.id === s.id)?.text ?? "(prompt)";
      out.push({ ...s, sessionId, label });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Commands for the "/" autocomplete, best matches first. */
export function suggestCommands(commands: readonly QueueCommand[] | undefined, typed: string, limit = 8): QueueCommand[] {
  if (!commands || !typed.startsWith("/") || /\s/.test(typed)) return [];
  const q = typed.slice(1).toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, limit);
}
