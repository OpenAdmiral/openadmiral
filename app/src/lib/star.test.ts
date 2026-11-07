import { describe, expect, it } from "vitest";
import { lidMinutes, starTitle, statusEvents } from "@/lib/star";
import type { Agent, AgentStatus } from "@/lib/types";

const agent = (id: string, status: AgentStatus, unplugged = false) => ({ id, status, ...(unplugged ? { unplugged: { via: "VS Code" } } : {}) }) as Agent;

describe("statusEvents", () => {
  it("sees finished turns and answered waits", () => {
    const before = new Map<string, AgentStatus>([
      ["a", "working"],
      ["b", "waiting"],
      ["c", "working"],
    ]);
    expect(statusEvents(before, [agent("a", "idle"), agent("b", "working"), agent("c", "working")])).toEqual([{ kind: "turn" }, { kind: "answered" }]);
  });
  it("ignores sessions without the plugin and new agents", () => {
    const before = new Map<string, AgentStatus>([["a", "working"]]);
    expect(statusEvents(before, [agent("a", "idle", true), agent("n", "idle")])).toEqual([]);
  });
});

describe("lidMinutes", () => {
  const T = 1_800_000_000_000;
  it("times a lid closed while Underway had work", () => {
    const closed = lidMinutes(null, { lidClosed: true, mode: "underway", working: 2 }, T);
    expect(closed.closedAt).toBe(T);
    expect(lidMinutes(closed.closedAt, { lidClosed: true, mode: "underway", working: 0 }, T + 60_000).closedAt).toBe(T);
    expect(lidMinutes(T, { lidClosed: false, mode: "docked", working: 0 }, T + 47 * 60_000)).toEqual({ closedAt: null, minutes: 47 });
  });
  it("does not time a lid closed with nothing to do", () => {
    expect(lidMinutes(null, { lidClosed: true, mode: "docked", working: 0 }, T)).toEqual({ closedAt: null });
    expect(lidMinutes(null, { lidClosed: false, mode: "docked", working: 0 }, T)).toEqual({ closedAt: null });
  });
});

describe("starTitle", () => {
  it("speaks in hours past 90 minutes", () => {
    expect(starTitle({ reason: "underway", minutes: 47, mode: "gh", login: null })).toBe("Your agents worked 47 min with the lid closed");
    expect(starTitle({ reason: "underway", minutes: 185, mode: "gh", login: null })).toBe("Your agents worked 3 h with the lid closed");
  });
});
