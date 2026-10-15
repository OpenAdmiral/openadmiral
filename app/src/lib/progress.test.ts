import { describe, expect, it } from "vitest";
import { estimate, formatElapsed, progressLabel, progressOf, type Report } from "./progress";
import type { AdmiralSession } from "./types";

const T0 = 1_800_000_000_000;
const s = (o: Partial<AdmiralSession>): AdmiralSession =>
  ({ v: 1, sessionId: "a", cwd: "/x", project: "x", status: "working", startedAt: T0 - 1e6, updatedAt: T0, ...o }) as AdmiralSession;
const r = (sec: number, percent: number, step?: string): Report => ({ at: T0 + sec * 1000, percent, step });

describe("formatElapsed", () => {
  it("reads like a clock", () => {
    expect(formatElapsed(9_400)).toBe("9s");
    expect(formatElapsed(134_000)).toBe("2m 14s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("estimate", () => {
  it("waits for the pace past the reading and planning", () => {
    expect(estimate([r(2, 5), r(8, 30)], T0 + 9_000)).toEqual({ eta: "estimating…" });
    // Two reports from 20 %, but only 5 s apart.
    expect(estimate([r(2, 20), r(7, 30)], T0 + 8_000)).toEqual({ eta: "estimating…" });
  });

  it("measures minutes from the pace and counts down between reports", () => {
    // 20 → 50 % in 3 min: 10 points a minute, 5 min left at the report.
    const reports = [r(0, 20), r(90, 35), r(180, 50)];
    expect(estimate(reports, T0 + 180_000)).toEqual({ eta: "≈ 5 min" });
    expect(estimate(reports, T0 + 300_000)).toEqual({ eta: "≈ 3 min" });
  });

  it("gives a range when the pace changes", () => {
    // Slow at first, then fast: recent and overall pace differ.
    expect(estimate([r(0, 20), r(240, 25), r(300, 40), r(330, 55)], T0 + 330_000).eta).toMatch(/^\d+–\d+ min$/);
  });

  it("says finishing up near the end instead of minutes", () => {
    expect(estimate([r(0, 20), r(60, 50), r(120, 85)], T0 + 125_000)).toEqual({ eta: "finishing up" });
  });

  it("goes quiet and shows the age once the reports stop", () => {
    expect(estimate([r(0, 20), r(60, 40)], T0 + 60_000 + 200_000)).toEqual({ stale: "last update 3m ago" });
  });

  it("never offers a negative or zero pace", () => {
    expect(estimate([r(0, 40), r(60, 30), r(120, 30)], T0 + 120_000)).toEqual({ eta: "estimating…" });
  });
});

describe("progressOf", () => {
  const turn = (sec: number, progress?: Report[]) => ({ startedAt: T0 - sec * 1000, prompt: "p", progress });

  it("stays out of quick turns and idle sessions", () => {
    expect(progressOf(s({ turn: turn(5) }), T0)).toBeUndefined();
    expect(progressOf(s({ status: "idle", turn: turn(60) }), T0)).toBeUndefined();
  });

  it("shows the elapsed time alone with nothing reported", () => {
    expect(progressOf(s({ turn: turn(134) }), T0)).toEqual({ elapsed: "2m 14s" });
  });

  it("uses Claude's last report and its step", () => {
    const v = progressOf(s({ turn: turn(100, [r(-90, 10, "Reading"), r(-30, 40, "Editing lib.rs")]) }), T0)!;
    expect(v).toMatchObject({ percent: 40, reported: true, step: "Editing lib.rs" });
    expect(progressLabel(v)).toMatch(/^40% · /);
  });

  it("ignores reports from an earlier turn", () => {
    expect(progressOf(s({ turn: turn(20, [r(-60, 80)]) }), T0)).toEqual({ elapsed: "20s" });
  });

  it("falls back to the task list for the share and the step", () => {
    const tasks = [
      { id: "1", subject: "Read", status: "completed" as const },
      { id: "2", subject: "Edit", status: "in_progress" as const, activeForm: "Editing" },
      { id: "3", subject: "Test", status: "pending" as const },
    ];
    const v = progressOf(s({ turn: turn(30), tasks }), T0)!;
    expect(v).toMatchObject({ steps: { done: 1, total: 3 }, step: "Editing" });
    expect(progressLabel(v)).toBe("1/3 · 30s");
  });

  it("forgets a finished task list", () => {
    const tasks = [{ id: "1", subject: "Read", status: "completed" as const }, { id: "2", subject: "Edit", status: "completed" as const }];
    expect(progressOf(s({ turn: turn(30), tasks }), T0)).toEqual({ elapsed: "30s" });
  });
});
