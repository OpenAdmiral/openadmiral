import { describe, expect, it } from "vitest";
import { followed, turnFinished, welcomeDecision } from "@/lib/onboarding";
import type { Agent, AgentStatus } from "@/lib/types";

const agent = (id: string, status: AgentStatus, over: Partial<Agent> = {}) =>
  ({ id, status, session: { sessionId: id, startedAt: 0 }, ...over }) as Agent;

describe("welcomeDecision", () => {
  const base = { uiLoaded: true, agentsLoaded: true, onboarded: undefined, agents: [] as Agent[] };
  it("waits for the saved state and the first poll", () => {
    expect(welcomeDecision({ ...base, uiLoaded: false })).toBe("wait");
    expect(welcomeDecision({ ...base, agentsLoaded: false })).toBe("wait");
  });
  it("welcomes a first run", () => expect(welcomeDecision(base)).toBe("show"));
  it("treats sessions without the plugin as a first run", () =>
    expect(welcomeDecision({ ...base, agents: [agent("a", "idle", { unplugged: { via: "VS Code" } })] })).toBe("show"));
  it("skips someone already connected", () => expect(welcomeDecision({ ...base, agents: [agent("a", "idle")] })).toBe("done"));
  it("never comes back once done", () => expect(welcomeDecision({ ...base, onboarded: true })).toBe("none"));
});

describe("the last step", () => {
  it("follows the newest working agent", () => {
    const a = agent("a", "working", { cli: { startedAt: 1 } as Agent["cli"] });
    const b = agent("b", "working", { cli: { startedAt: 5 } as Agent["cli"] });
    const c = agent("c", "idle", { cli: { startedAt: 9 } as Agent["cli"] });
    expect(followed([a, b, c])?.id).toBe("b");
    expect(followed([c])?.id).toBe("c");
  });
  it("finishes on a connected agent's first finished turn", () => {
    const before = new Map<string, AgentStatus>([["a", "working"]]);
    expect(turnFinished(before, [agent("a", "idle")])).toBe(true);
    expect(turnFinished(before, [agent("a", "idle", { unplugged: { via: "Terminal" } })])).toBe(false);
    expect(turnFinished(new Map(), [agent("a", "idle")])).toBe(false);
  });
});
