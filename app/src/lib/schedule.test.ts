import { describe, expect, it } from "vitest";
import {
  WEEKDAYS,
  centralGroup,
  classifyQueueText,
  inLabel,
  isDone,
  isDueByTime,
  isLate,
  needsSessionNow,
  nextDue,
  nextOccurrence,
  recentSent,
  scheduleLabel,
  suggestCommands,
  timeLabel,
  whenLabel,
  type QueueCommand,
} from "./schedule";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const COMMANDS: QueueCommand[] = [
  { name: "clear", kind: "command" },
  { name: "compact", kind: "command" },
  { name: "simplify", kind: "skill" },
  { name: "gsd-progress", kind: "skill" },
];

describe("next run", () => {
  it("finds the next allowed day at HH:MM", () => {
    const wed10 = at(2026, 10, 7, 10); // a Wednesday
    expect(nextOccurrence({ kind: "schedule", time: "09:00", days: WEEKDAYS }, wed10)).toBe(at(2026, 10, 8, 9));
    expect(nextOccurrence({ kind: "schedule", time: "09:00", days: WEEKDAYS }, at(2026, 10, 9, 10))).toBe(at(2026, 10, 12, 9)); // Fri → Mon
    expect(nextOccurrence({ kind: "schedule", time: "18:30", days: [] }, wed10)).toBe(at(2026, 10, 7, 18, 30));
    expect(nextOccurrence({ kind: "schedule", time: "9am", days: [] }, wed10)).toBeUndefined();
  });

  it("runs a missed schedule once (catch-up), then re-arms; an edit does not fire at once", () => {
    const item = { id: "q_d", text: "report", createdAt: at(2026, 10, 5, 8), after: { kind: "schedule" as const, time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] } };
    const wed15 = at(2026, 10, 7, 15);
    expect(isDueByTime(item, [], wed15)).toBe(true);
    const sent = [{ id: "q_d", at: wed15 }];
    expect(isDueByTime(item, sent, wed15 + 60_000)).toBe(false);
    expect(nextDue(item, sent)).toBe(at(2026, 10, 8, 9));
    expect(isDone(item, sent)).toBe(false); // a schedule never finishes
    // Changed at 10:00 to 09:00: armedAt keeps today's 09:00 from counting.
    expect(isDueByTime({ ...item, armedAt: at(2026, 10, 7, 10) }, [], at(2026, 10, 7, 10, 1))).toBe(false);
  });

  it("one-shots are done once sent; Run now wakes them again", () => {
    const item = { id: "q_t", text: "x", createdAt: 0, after: { kind: "time" as const, at: 1000 } };
    expect(isDueByTime(item, [], 999)).toBe(false);
    expect(isDueByTime(item, [], 1000)).toBe(true);
    expect(isDone(item, [{ id: "q_t", at: 1001 }])).toBe(true);
    expect(isDone({ ...item, runNowAt: 2000 }, [{ id: "q_t", at: 1001 }])).toBe(false);
  });

  it("a closed session is woken only for timed or Run-now items, never when paused", () => {
    const now = at(2026, 10, 7, 9, 5);
    const due = { id: "a", text: "x", createdAt: 0, after: { kind: "time" as const, at: at(2026, 10, 7, 9) } };
    const plain = { id: "b", text: "y", createdAt: 0 };
    expect(needsSessionNow({ items: [plain] }, [], now)).toBe(false);
    expect(needsSessionNow({ items: [due] }, [], now)).toBe(true);
    expect(needsSessionNow({ paused: true, items: [due] }, [], now)).toBe(false);
    expect(needsSessionNow({ items: [{ ...due, paused: true }] }, [], now)).toBe(false);
    expect(needsSessionNow({ items: [{ ...plain, runNowAt: now }] }, [], now)).toBe(true);
  });
});

describe("labels", () => {
  const now = at(2026, 10, 7, 6); // Wednesday 06:00
  it("names schedules and times as people say them", () => {
    expect(scheduleLabel({ kind: "schedule", time: "09:00", days: WEEKDAYS })).toBe("weekdays 09:00");
    expect(scheduleLabel({ kind: "schedule", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("every day 09:00");
    expect(scheduleLabel({ kind: "schedule", time: "18:00", days: [1, 4] })).toBe("Mon, Thu 18:00");
    expect(whenLabel(at(2026, 10, 8, 9), now)).toBe("09:00 tomorrow");
    expect(inLabel(now + 3 * 3_600_000, now)).toBe("in 3h");
    const item = { id: "q", text: "x", createdAt: now, after: { kind: "schedule" as const, time: "09:00", days: WEEKDAYS } };
    expect(timeLabel(item.after, item, [], now)).toBe("weekdays 09:00 · next in 3h");
    expect(timeLabel({ kind: "time", at: at(2026, 10, 8, 9) }, item, [], now)).toBe("at 09:00 tomorrow");
  });

  it("groups items for the Up next view and flags late runs", () => {
    expect(centralGroup({ id: "a", text: "", createdAt: 0, after: { kind: "time", at: 1 } }, true)).toBe("scheduled");
    expect(centralGroup({ id: "a", text: "", createdAt: 0, after: { kind: "session-idle", sessionId: "s" } }, false)).toBe("waiting");
    expect(centralGroup({ id: "a", text: "", createdAt: 0 }, true)).toBe("ready");
    expect(isLate({ id: "a", at: 10 * 60_000, due: 0 })).toBe(true);
    expect(isLate({ id: "a", at: 60_000, due: 0 })).toBe(false);
  });

  it("lists what was sent in the last day, newest first, with its text", () => {
    const now2 = 100 * 3_600_000;
    const queues = {
      s1: { queue: { items: [{ id: "q1", text: "from the item", createdAt: 0 }] }, sent: { sent: [{ id: "q1", at: now2 - 1000 }, { id: "old", at: now2 - 30 * 3_600_000 }] } },
      s2: { sent: { sent: [{ id: "q2", at: now2 - 10, text: "/compact" }] } },
    };
    expect(recentSent(queues, now2).map((r) => [r.sessionId, r.label])).toEqual([
      ["s2", "/compact"],
      ["s1", "from the item"],
    ]);
  });
});

describe("slash commands", () => {
  it("classifies prompts, runnable commands, skills and interactive pickers", () => {
    expect(classifyQueueText("Run the linter", COMMANDS)).toEqual({ kind: "prompt" });
    expect(classifyQueueText("/compact keep the API notes", COMMANDS)).toEqual({ kind: "command", name: "compact", args: "keep the API notes" });
    expect(classifyQueueText("/simplify", COMMANDS)).toEqual({ kind: "skill", name: "simplify", args: "" });
    const model = classifyQueueText("/model", COMMANDS);
    expect(model.kind).toBe("rejected");
    expect(model.kind === "rejected" && model.reason).toContain("needs you there");
    expect(classifyQueueText("/nope", COMMANDS).kind).toBe("rejected");
    // A mod that predates queueCommands: no slash command at all.
    const old = classifyQueueText("/clear", undefined);
    expect(old.kind === "rejected" && old.reason).toContain("/reload-plugins");
  });

  it("autocompletes from the session's commands", () => {
    expect(suggestCommands(COMMANDS, "/c").map((c) => c.name)).toEqual(["clear", "compact"]);
    expect(suggestCommands(COMMANDS, "/prog").map((c) => c.name)).toEqual(["gsd-progress"]);
    expect(suggestCommands(COMMANDS, "/compact now")).toEqual([]);
    expect(suggestCommands(COMMANDS, "hello")).toEqual([]);
  });
});
