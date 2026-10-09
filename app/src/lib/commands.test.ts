import { describe, expect, it } from "vitest";
import { costCommand, offers, remoteState } from "./commands";
import type { AdmiralSession } from "./types";

const s = (over: Partial<AdmiralSession>) => ({ v: 1, sessionId: "x", cwd: "/", project: "p", status: "idle", startedAt: 0, updatedAt: 0, ...over }) as AdmiralSession;

describe("header commands", () => {
  it("offers everything to a session from an older mod", () => {
    expect(offers(s({}), "compact")).toBe(true);
    expect(costCommand(s({}))).toBe("/usage");
  });
  it("offers only what the build lists", () => {
    expect(offers(s({ commands: ["model"] }), "compact")).toBe(false);
    expect(costCommand(s({ commands: ["cost"] }))).toBe("/cost");
    expect(costCommand(s({ commands: ["model"] }))).toBeUndefined();
  });
  it("shows Remote Control by its state", () => {
    expect(remoteState(s({})).kind).toBe("hidden");
    expect(remoteState(s({ commands: ["remote-control"] })).kind).toBe("off");
    expect(remoteState(s({ commands: ["remote-control"], remote: { enabled: true, clients: 0 } })).kind).toBe("on");
    expect(remoteState(s({ commands: ["remote-control"], remote: { clients: 2 } }))).toEqual({ kind: "connected", clients: 2 });
  });
});
