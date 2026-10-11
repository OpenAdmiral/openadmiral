import { describe, expect, it } from "vitest";
import { pluginBehind } from "./plugin";
import type { Agent } from "./types";

const agent = (session: Partial<NonNullable<Agent["session"]>> | undefined, running = true) =>
  ({ cli: running ? { sessionId: "s1" } : undefined, session: session && { status: "idle", ...session } }) as unknown as Agent;

describe("pluginBehind", () => {
  const changed = 1_000_000;
  it("flags a running session that loaded the plugin before its files changed", () => {
    expect(pluginBehind(agent({ plugin: { loadedAt: changed - 60_000 } }), changed)).toBe(true);
    expect(pluginBehind(agent({ plugin: { loadedAt: changed + 5_000 } }), changed)).toBe(false);
  });
  it("counts a mod too old to say when it loaded as behind", () => {
    expect(pluginBehind(agent({}), changed)).toBe(true);
  });
  it("leaves alone sessions that are not running, ended, or when the files are unknown", () => {
    expect(pluginBehind(agent({}, false), changed)).toBe(false);
    expect(pluginBehind(agent({ status: "ended" }), changed)).toBe(false);
    expect(pluginBehind(agent({}), null)).toBe(false);
  });
});
