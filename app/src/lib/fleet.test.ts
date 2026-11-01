import { describe, expect, it } from "vitest";
import { arrange, bandLayout, fleetAt, histogram, resolveMessages, toolLabel, workAt, type Band, type Resolved } from "./fleet";
import type { Agent } from "./types";

const MIN = 60_000;
const msg = (at: number, from: string, to: string, summary = ""): Resolved => ({ id: `${at}${from}`, at, from, to, summary, text: "" });
const working = (...ids: string[]) => new Map(ids.map((i) => [i, null]));

describe("what the fleet is doing", () => {
  it("someone asked is working for who asked, until it answers", () => {
    const asked = [msg(100 * MIN, "a", "b", "fix it")];
    expect(fleetAt(asked, [], working("b"), 101 * MIN).worksFor).toEqual([{ from: "a", to: "b", summary: "fix it" }]);
    const answered = [...asked, msg(102 * MIN, "b", "a")];
    expect(fleetAt(answered, [], working("b"), 103 * MIN).worksFor).toEqual([]);
  });
  it("a long pause in its work means it moved on", () => {
    const work = [{ at: 110 * MIN, session: "b", label: "other" }];
    expect(fleetAt([msg(100 * MIN, "a", "b")], work, working("b"), 111 * MIN).worksFor).toEqual([]);
  });
  it("an agent awaits only the last one it wrote to", () => {
    const m = [msg(104 * MIN, "a", "b"), msg(105 * MIN, "a", "c")];
    // Both moved on to other work since: neither works for a.
    const gap = [{ at: 110 * MIN, session: "b", label: "x" }, { at: 110 * MIN, session: "c", label: "x" }];
    expect(fleetAt(m, gap, working("b", "c"), 111 * MIN).awaits.map((r) => r.to)).toEqual(["c"]);
  });
  it("working for wins over awaiting between the same two", () => {
    expect(fleetAt([msg(100 * MIN, "a", "b")], [], working("b"), 101 * MIN).awaits).toEqual([]);
  });
  it("whoever wrote and stopped awaits a busy recipient, not an idle one", () => {
    const m = [msg(104 * MIN, "a", "b", "q")];
    const gap = [{ at: 110 * MIN, session: "b", label: "x" }];
    expect(fleetAt(m, gap, working("b"), 111 * MIN).awaits).toEqual([{ from: "a", to: "b", summary: "q" }]);
    expect(fleetAt(m, gap, working(), 111 * MIN).awaits).toEqual([]);
    expect(fleetAt(m, gap, working("a", "b"), 111 * MIN).awaits).toEqual([]);
    expect(fleetAt(m, gap, working("b"), 115 * MIN).awaits).toEqual([]);
  });
  it("talks in both directions make one pair; old ones fade out", () => {
    const f = fleetAt([msg(1 * MIN, "a", "b"), msg(100 * MIN, "a", "b"), msg(101 * MIN, "b", "a")], [], working(), 102 * MIN);
    expect(f.pairs).toEqual([{ a: "a", b: "b", count: 2, last: 101 * MIN }]);
  });
  it("replaying, tool calls say who worked on what", () => {
    const w = [{ at: 100 * MIN, session: "a", label: "tests" }];
    expect(workAt(w, 100.5 * MIN).get("a")).toBe("tests");
    expect(workAt(w, 103 * MIN).has("a")).toBe(false);
    expect(workAt(w, 99 * MIN).has("a")).toBe(false);
  });
  it("reads tool names and bins the timeline", () => {
    expect(toolLabel("mcp__claude-in-chrome__computer")).toBe("computer");
    expect(toolLabel("Run tests")).toBe("Run tests");
    const bars = histogram({ messages: [{ at: 0 }, { at: 99 }, { at: 200 }], work: [{ at: 49 }] }, 0, 100, 2);
    expect(bars).toEqual([{ messages: 1, work: 1 }, { messages: 1, work: 0 }]);
  });
  it("resolves addresses to agents and drops what it cannot place", () => {
    const agents = [{ id: "s1", name: "back", project: "p", status: "idle" }, { id: "s2", name: "front", project: "q", status: "idle" }] as Agent[];
    const m = (from: string, to: string) => ({ id: from + to, at: 1, from, to, text: "" });
    expect(resolveMessages([m("s1", "front"), m("s1", "s2"), m("s1", "nobody"), m("gone", "front"), m("s1", "back")], agents).map((x) => x.to)).toEqual(["s2", "s2"]);
  });
});

describe("who shows, and where", () => {
  const band = (id: string, ...agents: string[]): Band<string> => ({ id, agents });
  const ids = (b: Band<string>[]) => b.map((x) => [x.id, ...x.agents]);
  it("leaves out the quiet and orders by activity", () => {
    const score = new Map([["a1", 1], ["a2", 5], ["b1", 9]]);
    const r = arrange([band("A", "a1", "a2", "a3"), band("B", "b1"), band("C", "c1")], (x) => x, (x) => score.get(x) ?? 0, null);
    expect(ids(r.bands)).toEqual([["B", "b1"], ["A", "a2", "a1"]]);
  });
  it("keeps its order while activity changes; newcomers go last, leavers leave", () => {
    const first = arrange([band("A", "a1", "a2")], (x) => x, (x) => (x === "a1" ? 1 : 5), null);
    expect(first.bands[0].agents).toEqual(["a2", "a1"]);
    const later = arrange([band("A", "a1", "a2", "a3"), band("B", "b1")], (x) => x, (x) => ({ a1: 50, a2: 1, a3: 99, b1: 999 })[x] ?? 0, first.order);
    expect(ids(later.bands)).toEqual([["A", "a2", "a1", "a3"], ["B", "b1"]]);
    const gone = arrange([band("A", "a1", "a2", "a3")], (x) => x, (x) => (x === "a2" ? 0 : 1), later.order);
    expect(gone.bands[0].agents).toEqual(["a1", "a3"]);
  });
  it("zigzags three or more across two rows, and stacks the bands", () => {
    const l = bandLayout([2, 4], 1200);
    expect(l.bands[0].rows).toBe(1);
    expect(l.bands[1].rows).toBe(2);
    expect(l.bands[1].top).toBeGreaterThan(l.bands[0].top + l.bands[0].height - 1);
    const ys = l.bands[1].cards.map((c) => c.top);
    expect(ys[0]).toBe(ys[2]);
    expect(ys[1]).toBe(ys[3]);
    expect(ys[1]).toBeGreaterThan(ys[0]);
    const xs = l.bands[1].cards.map((c) => c.left);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(l.height).toBe(l.bands[1].top + l.bands[1].height);
  });
});
