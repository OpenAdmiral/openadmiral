import { describe, expect, it } from "vitest";
import { activeOpenCount, isActive, staleReason } from "./delegations";
import type { Agent, AdmiralDelegation } from "./types";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const agent = (id: string, name: string, status: Agent["status"] = "idle"): Agent => ({ id, name, project: "proj", cwd: "/r", attachable: true, live: status !== "ended", status });

const dlg = (over: Partial<AdmiralDelegation> = {}): AdmiralDelegation => ({
  v: 1,
  id: "dlg_a",
  title: "T",
  detail: "",
  from: { sessionId: "s-from", project: "proj" },
  to: { address: "beta" },
  status: "sent",
  notes: [],
  createdAt: NOW - H,
  updatedAt: NOW - H,
  ...over,
});

const FROM = agent("s-from", "alpha");
const TO = agent("s-to", "beta");

describe("staleReason", () => {
  it("is alive while both ends run and it moved in the last day", () => {
    expect(staleReason(dlg(), [FROM, TO], NOW)).toBeUndefined();
  });
  it("is stale when the recipient is gone (after a grace period)", () => {
    expect(staleReason(dlg({ to: { address: "mcp-server-b3" } }), [FROM, TO], NOW)).toMatch(/isn't running/);
    expect(staleReason(dlg({ to: { address: "mcp-server-b3" }, updatedAt: NOW - 60_000 }), [FROM, TO], NOW)).toBeUndefined();
  });
  it("is stale when neither end runs", () => {
    expect(staleReason(dlg(), [agent("s-from", "alpha", "ended"), agent("s-to", "beta", "ended")], NOW)).toBe("Neither agent is running");
  });
  it("is stale after a day without news", () => {
    expect(staleReason(dlg({ status: "in_progress", updatedAt: NOW - 30 * H }), [FROM, TO], NOW)).toBe("No update for 30 h");
  });
  it("never flags closed ones", () => {
    expect(staleReason(dlg({ status: "done", to: { address: "gone" } }), [FROM], NOW)).toBeUndefined();
  });
});

describe("isActive / activeOpenCount", () => {
  it("keeps live open ones and recently closed ones, drops stale and old closed ones", () => {
    const ds = [dlg({ id: "dlg_live" }), dlg({ id: "dlg_stale", to: { address: "gone" } }), dlg({ id: "dlg_done", status: "done" }), dlg({ id: "dlg_old", status: "done", updatedAt: NOW - 48 * H })];
    expect(ds.filter((d) => isActive(d, [FROM, TO], NOW)).map((d) => d.id)).toEqual(["dlg_live", "dlg_done"]);
    expect(activeOpenCount(ds, [FROM, TO], NOW)).toBe(1);
  });
});
