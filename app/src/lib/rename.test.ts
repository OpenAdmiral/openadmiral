import { describe, expect, it } from "vitest";
import { renameEntry } from "./order";
import { canRename, cleanName } from "./rename";
import type { Agent } from "./types";

describe("cleanName", () => {
  it("trims and collapses spaces", () => expect(cleanName("  auth   scopes ", "old")).toBe("auth scopes"));
  it("rejects empty and unchanged names", () => {
    expect(cleanName("   ", "old")).toBeNull();
    expect(cleanName(" old ", "old")).toBeNull();
  });
});

describe("renameEntry", () => {
  it("keeps the agent's place under its new name", () => expect(renameEntry(["a", "b", "c"], "b", "x")).toEqual(["a", "x", "c"]));
  it("drops an older entry with the new name", () => expect(renameEntry(["x", "a", "b"], "b", "x")).toEqual(["a", "x"]));
  it("leaves the list alone when the old name is not in it", () => {
    const list = ["a"];
    expect(renameEntry(list, "b", "x")).toBe(list);
  });
});

describe("canRename", () => {
  const base = { id: "s", name: "n", project: "p", cwd: "/", attachable: true, live: true, status: "idle" } as Agent;
  const cli = { pid: 1, cwd: "/", kind: "background", startedAt: 0, sessionId: "s" };
  it("needs a running session whose mod offers rename", () => {
    expect(canRename({ ...base, cli, session: { commands: ["rename"] } as Agent["session"] })).toBe(true);
    expect(canRename({ ...base, cli, session: { commands: ["model"] } as Agent["session"] })).toBe(false);
    expect(canRename({ ...base, session: { commands: ["rename"] } as Agent["session"] })).toBe(false);
  });
});
