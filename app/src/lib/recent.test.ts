import { describe, expect, it } from "vitest";
import { lastActivity, recentOrder } from "./recent";
import type { Agent } from "./types";

const agent = (name: string, status: Agent["status"], session: Record<string, unknown>) =>
  ({ id: name, name, project: "p", cwd: "/p", attachable: true, live: true, status, session: { startedAt: 0, updatedAt: 9_999_999, ...session } }) as unknown as Agent;

describe("Recent order", () => {
  it("goes by what the agent last did, not by its heartbeat", () => {
    const a = agent("a", "idle", { lastTool: { at: 500 }, updatedAt: 9_999_999 });
    expect(lastActivity(a)).toBe(500);
  });
  it("puts the ones waiting on you first, then the most recent, ended last", () => {
    const list = [
      agent("old", "idle", { turn: { startedAt: 100 } }),
      agent("gone", "ended", { lastTool: { at: 900 } }),
      agent("new", "working", { turn: { startedAt: 800 } }),
      agent("asks", "waiting", { waiting: { since: 50 } }),
    ];
    expect(recentOrder(list).map((a) => a.name)).toEqual(["asks", "new", "old", "gone"]);
  });
});
