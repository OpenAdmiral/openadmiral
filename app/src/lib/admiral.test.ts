import { describe, expect, it } from "vitest";
import { isPhantom, mergeAgents, supersededMap } from "./admiral";
import type { AdmiralSession } from "./types";

const now = 1_000_000_000;
const session = (over: Partial<AdmiralSession> = {}): AdmiralSession => ({
  v: 1, sessionId: "s", cwd: "/r", project: "r", status: "idle", startedAt: now - 60_000, updatedAt: now - 5_000,
  activity: [{ at: now - 50_000, kind: "prompt", text: "hi" }], ...over,
});

describe("session files that are not real sessions", () => {
  it("a listed session is always real", () => expect(isPhantom(session(), true, 9, now)).toBe(false));
  it("a fresh, unlisted file is hidden after two missed polls, not before", () => {
    expect(isPhantom(session(), false, 1, now)).toBe(false);
    expect(isPhantom(session(), false, 2, now)).toBe(true);
  });
  it("an ended or stale session stays visible, greyed", () => {
    expect(isPhantom(session({ status: "ended" }), false, 5, now)).toBe(false);
    expect(isPhantom(session({ updatedAt: now - 200_000 }), false, 5, now)).toBe(false);
  });
  it("an unlisted file with no transcript (agent view) is hidden at once", () => {
    expect(isPhantom(session({ hasTranscript: false }), false, 0, now)).toBe(true);
    expect(isPhantom(session({ hasTranscript: false, updatedAt: now - 500_000, status: "ended" }), false, 0, now)).toBe(true);
  });
  it("an ended session with a transcript but no recorded prompts stays (the mod loaded late)", () => {
    expect(isPhantom(session({ hasTranscript: true, activity: [], status: "ended", updatedAt: now - 500_000 }), false, 0, now)).toBe(false);
  });
});

describe("/clear gives a running session a new id", () => {
  const cli = [{ pid: 1, cwd: "/r", kind: "background", startedAt: 0, id: "e6a471e7", sessionId: "b89c59a5-new", name: "x" }];
  it("maps the first id to the new one from the job's short id (old mods)", () => {
    expect(supersededMap([session({ sessionId: "e6a471e7-old" })], cli).get("e6a471e7-old")).toBe("b89c59a5-new");
  });
  it("follows the mod's supersededBy, through chains", () => {
    const files = [session({ sessionId: "a", supersededBy: "b", status: "ended" }), session({ sessionId: "b", supersededBy: "c", status: "ended" })];
    expect(supersededMap(files, []).get("a")).toBe("c");
  });
  it("shows one row: the new id", () => {
    const agents = mergeAgents([session({ sessionId: "e6a471e7-old" })], cli, now);
    expect(agents.map((a) => a.id)).toEqual(["b89c59a5-new"]);
  });
});

describe("sessions found without the plugin", () => {
  it("join the fleet read-only, unless the plugin or the CLI already knows them", async () => {
    const { mergeAgents } = await import("./admiral");
    const now = 1_000_000;
    const found = [
      { sessionId: "vs1", cwd: "/w/api", project: "api", branch: "main", status: "working" as const, lastPrompt: "Fix the tests", lastReply: null, updatedAt: now - 5_000, via: "VS Code" },
      { sessionId: "known", cwd: "/w/app", project: "app", branch: null, status: "idle" as const, lastPrompt: null, lastReply: null, updatedAt: now, via: "Terminal" },
    ];
    const cli = [{ pid: 1, cwd: "/w/app", kind: "background", startedAt: 0, sessionId: "known", name: "app-agent", status: "idle" }];
    const agents = mergeAgents([], cli, now, new Map(), new Map(), found);
    const vs = agents.find((a) => a.id === "vs1")!;
    expect(vs.unplugged).toEqual({ via: "VS Code" });
    expect(vs.status).toBe("working");
    expect(vs.session?.turn?.prompt).toBe("Fix the tests");
    expect(vs.attachable).toBe(false);
    expect(agents.find((a) => a.id === "known")!.unplugged).toBeUndefined();
  });
});
