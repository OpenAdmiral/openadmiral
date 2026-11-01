import { describe, expect, it } from "vitest";
import { arrange, bandLayout, curveBetween, fleetAt, histogram, linksOf, mergeTraffic, placeBand, resolveMessages, toolLabel, workAt, type Band, type Resolved } from "./fleet";
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
  it("stacks the bands", () => {
    const l = bandLayout([placeBand(["a", "b"], []), placeBand(["c", "d", "e", "f", "g"], [])], 1200);
    expect(l.bands[1].top).toBeGreaterThan(l.bands[0].top + l.bands[0].height - 1);
    expect(l.height).toBe(l.bands[1].top + l.bands[1].height);
  });
});

describe("a band around its busiest agent", () => {
  const link = (a: string, b: string, weight = 3) => ({ a, b, weight });
  // Whether a pair's line runs through a third card, as drawn.
  const pierced = (ids: string[], links: { a: string; b: string }[]) => {
    const { bands } = bandLayout([placeBand(ids, links.map((l) => ({ ...l, weight: 3 })))], 1400);
    const boxes = new Map(ids.map((id, i) => [id, { x: bands[0].cards[i].left, y: bands[0].cards[i].top, w: 228, h: 92 }]));
    const all = [...boxes.values()];
    return links.filter((l) => {
      const a = boxes.get(l.a)!, b = boxes.get(l.b)!;
      const c = curveBetween(a, b, 0, all);
      return all.some((o) => o !== a && o !== b && Array.from({ length: 41 }, (_, i) => c.at(i / 40)).some((p) => p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h));
    });
  };

  it("puts the one most lines touch in the middle", () => {
    const ids = ["a", "b", "c", "d", "hub"];
    const cells = placeBand(ids, ["a", "b", "c", "d"].map((x) => link(x, "hub")));
    expect(cells[4]).toEqual({ col: 1, row: 1 });
    expect(new Set(cells.map((c) => `${c.col},${c.row}`)).size).toBe(5);
  });

  it("the middle's lines touch no other card, at any size", () => {
    for (const n of [3, 4, 5, 6, 7, 9]) {
      const others = Array.from({ length: n - 1 }, (_, i) => `s${i}`);
      expect(pierced(["hub", ...others], others.map((a) => ({ a, b: "hub" })))).toEqual([]);
    }
  });

  it("seats those who talk to each other side by side", () => {
    const ids = ["hub", "a", "b", "c", "d"];
    const links = [{ a: "hub", b: "a" }, { a: "hub", b: "b" }, { a: "hub", b: "c" }, { a: "hub", b: "d" }, { a: "a", b: "c" }];
    expect(pierced(ids, links)).toEqual([]);
  });

  it("goes around a card between two of the same row", () => {
    const row = (x: number) => ({ x, y: 0, w: 228, h: 92 });
    const [a, mid, b] = [row(0), row(300), row(600)];
    const c = curveBetween(a, b, 0, [a, mid, b]);
    expect(Array.from({ length: 41 }, (_, i) => c.at(i / 40)).some((p) => p.x > 300 && p.x < 528 && p.y > 0 && p.y < 92)).toBe(false);
  });

  it("counts what was said in the period, either way", () => {
    const m = (at: number, from: string, to: string) => ({ id: `${at}`, at, from, to, text: "" });
    expect(linksOf([m(1, "a", "b"), m(5, "a", "b"), m(6, "b", "a")], 2)).toEqual([{ a: "a", b: "b", weight: 2 }]);
  });
});

describe("traffic read bit by bit", () => {
  const m = (id: string, at: number) => ({ id, at, from: "a", to: "b", text: "" });
  const NOW = 1_800_000_000_000;
  it("keeps the same object when nothing came, so nothing redraws", () => {
    const have = { seq: 5, messages: [m("1", NOW)], work: [] };
    expect(mergeTraffic(have, { seq: 5, messages: [], work: [] }, NOW)).toBe(have);
  });
  it("adds what was read late in its place by time, once", () => {
    const have = { seq: 5, messages: [m("1", NOW - 10), m("3", NOW)], work: [] };
    const r = mergeTraffic(have, { seq: 7, messages: [m("2", NOW - 5), m("3", NOW)], work: [] }, NOW);
    expect(r.messages.map((x) => x.id)).toEqual(["1", "2", "3"]);
    expect(r.seq).toBe(7);
  });
  it("lets go of what is too old", () => {
    const old = NOW - 8 * 24 * 60 * 60_000;
    const r = mergeTraffic({ seq: 1, messages: [m("old", old)], work: [{ at: old, session: "a", label: "x" }] }, { seq: 2, messages: [m("new", NOW)], work: [{ at: NOW, session: "a", label: "y" }] }, NOW);
    expect(r.messages.map((x) => x.id)).toEqual(["new"]);
    expect(r.work.map((w) => w.label)).toEqual(["y"]);
  });
});
