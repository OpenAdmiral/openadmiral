import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { resolveAddress } from "./agentLinks";
import type { Agent } from "./types";

// What the agents are doing to and for each other, from what they already do: their
// SendMessage traffic and their work. Who works for whom and who awaits whom is deduced from
// the order of things, so the views say so plainly; nothing asks the agents to report it.

export type Message = { id: string; at: number; from: string; to: string; summary?: string | null; text: string };
export type Work = { at: number; session: string; label: string };
export type Traffic = { seq?: number; messages: Message[]; work: Work[] };

/** A message with both ends known. `to` is the receiving agent's id. */
export type Resolved = Message & { to: string };

/** An agent counts as working this long after its last tool call, when replaying. */
export const WORK_MS = 90_000;
/** Who counts as having talked: a faint line between two agents fades over this long. */
export const TRAFFIC_MS = 15 * 60_000;
/** Still looks like a wait after this long? Then it is something else. */
const AWAIT_MS = 10 * 60_000;
/** A pause this long in its work means it moved on from what it was asked. */
const WORK_GAP_MS = 120_000;

/** Tool names as a person reads them: `mcp__claude-in-chrome__computer` is `computer`. */
export const toolLabel = (label: string) => label.replace(/^mcp__.*__/, "");

/** Keeps messages between two different agents on the list, with `to` as an agent id. */
export function resolveMessages(messages: Message[], agents: Agent[]): Resolved[] {
  const ids = new Set(agents.map((a) => a.id));
  return messages.flatMap((m) => {
    if (!ids.has(m.from)) return [];
    const to = resolveAddress(m.to, agents.filter((a) => a.id !== m.from));
    return to && to.id !== m.from ? [{ ...m, to: to.id }] : [];
  });
}

export type Relation = { from: string; to: string; summary: string };
export type Pair = { a: string; b: string; count: number; last: number };

export type FleetState = {
  /** At this moment, per agent: working, and on what. Live, the agents' own status says. */
  working: Map<string, string | null>;
  /** `to` is working on what `from` asked. */
  worksFor: Relation[];
  /** `from` wrote to `to`, stopped, and `to` is busy and has not answered. */
  awaits: Relation[];
  /** Who has been talking, however recently. */
  pairs: Pair[];
  recent: Resolved[];
};

/**
 * The fleet at `at`. `working` is who is working then and on what: from the sessions when
 * live, from `workOf` when replaying.
 */
export function fleetAt(messages: Resolved[], work: Work[], working: Map<string, string | null>, at: number): FleetState {
  const recent = messages.filter((m) => m.at <= at && at - m.at < TRAFFIC_MS);
  const lastOf = new Map<string, Resolved>();
  for (const m of recent) lastOf.set(`${m.from}>${m.to}`, m);
  const worksFor: Relation[] = [];
  for (const id of working.keys()) {
    const asked = recent.filter((m) => m.to === id).at(-1);
    if (!asked) continue;
    const answered = lastOf.get(`${id}>${asked.from}`);
    if (answered && answered.at > asked.at) continue;
    // Still on it: no long pause in its work since it was asked.
    let prev = asked.at;
    let steady = true;
    for (const w of work) {
      if (w.session !== id || w.at <= asked.at || w.at > at) continue;
      if (w.at - prev > WORK_GAP_MS) {
        steady = false;
        break;
      }
      prev = w.at;
    }
    if (steady) worksFor.push({ from: asked.from, to: id, summary: asked.summary ?? "" });
  }
  // Most messages are notices: an agent awaits only the last one it wrote to, and not for long.
  const awaits: Relation[] = [];
  const lastSent = new Map<string, Resolved>();
  for (const m of recent) lastSent.set(m.from, m);
  for (const m of lastSent.values()) {
    const answered = lastOf.get(`${m.to}>${m.from}`);
    if (answered && answered.at > m.at) continue;
    if (working.has(m.from) || !working.has(m.to) || at - m.at > AWAIT_MS) continue;
    if (worksFor.some((r) => r.from === m.from && r.to === m.to)) continue;
    awaits.push({ from: m.from, to: m.to, summary: m.summary ?? "" });
  }
  const byPair = new Map<string, Pair>();
  for (const m of recent) {
    const [a, b] = [m.from, m.to].sort();
    const key = `${a}|${b}`;
    const p = byPair.get(key) ?? { a, b, count: 0, last: 0 };
    p.count++;
    p.last = Math.max(p.last, m.at);
    byPair.set(key, p);
  }
  return { working, worksFor, awaits, pairs: [...byPair.values()], recent };
}

/** Who was working at `at`, going by their tool calls. */
export function workAt(work: Work[], at: number): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const w of work) if (w.at <= at && at - w.at < WORK_MS) out.set(w.session, w.label);
  return out;
}

/** Bars for the timeline: how many messages and how much work fell in each slice. */
export function histogram(traffic: { messages: { at: number }[]; work: { at: number }[] }, from: number, to: number, slices: number) {
  const bars = Array.from({ length: slices }, () => ({ messages: 0, work: 0 }));
  const slot = (at: number) => Math.min(slices - 1, Math.floor(((at - from) / (to - from)) * slices));
  for (const m of traffic.messages) if (m.at >= from && m.at <= to) bars[slot(m.at)].messages++;
  for (const w of traffic.work) if (w.at >= from && w.at <= to) bars[slot(w.at)].work++;
  return bars;
}

/** How much each agent did since `from`: a message says more than one more tool call. */
export function activityScores(messages: Resolved[], work: Work[], from: number) {
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  for (const w of work) if (w.at >= from) add(w.session, 1);
  for (const m of messages) {
    if (m.at < from) continue;
    add(m.from, 3);
    add(m.to, 3);
  }
  return out;
}

export type Band<T> = { id: string; agents: T[] };
/** The order on screen, kept while looking so nothing moves around under the eye. */
export type Arrangement = { bands: string[]; agents: string[] };

/**
 * Only who did something, by project. The most active first the first time (`previous` null);
 * after that everyone keeps their place, newcomers go last and the quiet leave.
 */
export function arrange<T>(bands: Band<T>[], idOf: (a: T) => string, score: (a: T) => number, previous: Arrangement | null) {
  const place = (list: string[] | undefined, id: string) => {
    const i = list?.indexOf(id) ?? -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const shown = bands
    .map((b) => {
      const agents = b.agents
        .filter((a) => score(a) > 0)
        .sort((x, y) => place(previous?.agents, idOf(x)) - place(previous?.agents, idOf(y)) || score(y) - score(x));
      return { ...b, agents, total: agents.reduce((n, a) => n + score(a), 0) };
    })
    .filter((b) => b.agents.length > 0)
    .sort((x, y) => place(previous?.bands, x.id) - place(previous?.bands, y.id) || y.total - x.total);
  return {
    bands: shown as Band<T>[],
    order: { bands: shown.map((b) => b.id), agents: shown.flatMap((b) => b.agents.map(idOf)) } as Arrangement,
  };
}

export const CARD_W = 228;
const ROW_H = 92;
const CHANNEL = 64;
const PAD = 26;
const GUTTER = 136;
const BAND_GAP = 12;
/** Half a row: the middle of an X sits between the two rows of its corners. */
const HALF_ROW = (ROW_H + CHANNEL) / 2;

/** Where a card goes in its band; `row` counts half rows. */
export type Cell = { col: number; row: number };
export type Link = { a: string; b: string; weight: number };

/** How much each pair talked since `from`, whichever way. */
export function linksOf(messages: Resolved[], from: number): Link[] {
  const pairs = new Map<string, Link>();
  for (const m of messages) {
    if (m.at < from) continue;
    const [a, b] = m.from < m.to ? [m.from, m.to] : [m.to, m.from];
    const key = `${a}|${b}`;
    const link = pairs.get(key) ?? { a, b, weight: 0 };
    link.weight++;
    pairs.set(key, link);
  }
  return [...pairs.values()];
}

/** The centre of a band of `n` cards, and the places around it, nearest first. */
function cellsFor(n: number): { hub: Cell; around: Cell[] } {
  if (n <= 2) return { hub: { col: 0, row: 0 }, around: [{ col: 1, row: 0 }] };
  if (n === 3) return { hub: { col: 1, row: 0 }, around: [{ col: 0, row: 0 }, { col: 2, row: 0 }] };
  if (n <= 5) return { hub: { col: 1, row: 1 }, around: [{ col: 0, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 2 }, { col: 2, row: 2 }] };
  let cols = 3;
  while (cols * 3 - 1 < n - 1) cols += 2;
  const hub = { col: (cols - 1) / 2, row: 2 };
  const around: Cell[] = [];
  for (const row of [0, 2, 4]) for (let col = 0; col < cols; col++) if (col !== hub.col || row !== hub.row) around.push({ col, row });
  const away = (c: Cell) => Math.abs(c.col - hub.col) + Math.abs(c.row - hub.row) / 2;
  return { hub, around: around.sort((x, y) => away(x) - away(y)) };
}

/** How bad a placement is: a line through a card, then lines that cross, then long lines. */
function placementCost(cells: Map<string, Cell>, links: Link[]) {
  const box = (c: Cell): Box => ({ x: c.col * 300, y: c.row * HALF_ROW, w: CARD_W, h: ROW_H });
  const boxes = new Map([...cells].map(([id, c]) => [id, box(c)]));
  const all = [...boxes.values()];
  const lines = links.flatMap((l) => {
    const a = boxes.get(l.a), b = boxes.get(l.b);
    if (!a || !b) return [];
    const curve = curveBetween(a, b, 0, all);
    return [{ a, b, weight: 1 + Math.log2(l.weight), points: Array.from({ length: 13 }, (_, i) => curve.at(i / 12)) }];
  });
  let cost = 0;
  lines.forEach((line, i) => {
    for (const other of all) if (other !== line.a && other !== line.b && line.points.some((p) => p.x > other.x - 6 && p.x < other.x + other.w + 6 && p.y > other.y - 6 && p.y < other.y + other.h + 6)) cost += 1000 * line.weight;
    for (let k = 1; k < line.points.length; k++) cost += Math.hypot(line.points[k].x - line.points[k - 1].x, line.points[k].y - line.points[k - 1].y) * 0.01 * line.weight;
    for (const other of lines.slice(i + 1)) if (polylinesCross(line.points, other.points)) cost += 100 * Math.min(line.weight, other.weight);
  });
  return cost;
}

type Point = { x: number; y: number };
function polylinesCross(p: Point[], q: Point[]) {
  const side = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < q.length; j++)
      if (side(p[i - 1], p[i], q[j - 1]) * side(p[i - 1], p[i], q[j]) < 0 && side(q[j - 1], q[j], p[i - 1]) * side(q[j - 1], q[j], p[i]) < 0) return true;
  return false;
}

/**
 * Who goes where in a band: the one most lines touch in the middle (the first, most active, if
 * none does), and the rest wherever their lines run freest. `ids` in order; cells in that order.
 */
export function placeBand(ids: string[], links: Link[]): Cell[] {
  const inside = links.filter((l) => l.a !== l.b && ids.includes(l.a) && ids.includes(l.b));
  const degree = (id: string) => inside.reduce((n, l) => n + (l.a === id || l.b === id ? l.weight : 0), 0);
  const hub = ids.reduce((best, id) => (degree(id) > degree(best) ? id : best), ids[0]);
  const { hub: centre, around } = cellsFor(ids.length);
  // The busiest take the nearest places, then swaps while they help.
  const others = ids.filter((id) => id !== hub).sort((x, y) => degree(y) - degree(x));
  const seats: (string | null)[] = around.map((_, i) => others[i] ?? null);
  const placement = () => {
    const m = new Map<string, Cell>([[hub, centre]]);
    seats.forEach((id, i) => id && m.set(id, around[i]));
    return m;
  };
  let best = placementCost(placement(), inside);
  for (let improved = true, pass = 0; improved && pass < 8; pass++) {
    improved = false;
    for (let i = 0; i < seats.length; i++)
      for (let j = i + 1; j < seats.length; j++) {
        if (!seats[i] && !seats[j]) continue;
        [seats[i], seats[j]] = [seats[j], seats[i]];
        const cost = placementCost(placement(), inside);
        if (cost < best - 1e-6) {
          best = cost;
          improved = true;
        } else [seats[i], seats[j]] = [seats[j], seats[i]];
      }
  }
  const final = placement();
  return ids.map((id) => final.get(id) ?? centre);
}

/** A band per project, stacked, each around its centre. `cells` is where each band's cards go. */
export function bandLayout(cells: Cell[][], width: number) {
  let top = 0;
  const bands = cells.map((list) => {
    const cols = Math.max(0, ...list.map((c) => c.col)) + 1;
    const lastRow = Math.max(0, ...list.map((c) => c.row));
    const height = PAD * 2 + ROW_H + lastRow * HALF_ROW;
    const area = Math.max(0, width - GUTTER - CARD_W - 32);
    const step = cols > 1 ? Math.max(CARD_W + 96, Math.min(area / (cols - 1), 400)) : 0;
    const inset = cols >= 3 ? Math.max(0, (area - step * (cols - 1)) / 2) : 0;
    const band = { top, height, cards: list.map((c) => ({ left: GUTTER + 12 + inset + c.col * step, top: PAD + c.row * HALF_ROW })) };
    top += height + BAND_GAP;
    return band;
  });
  return { bands, height: bands.length ? top - BAND_GAP : 0 };
}

/** `band` tells apart cards in different bands; lines between bands run up or down. */
export type Box = { x: number; y: number; w: number; h: number; band?: number };
export type Curve = { d: string; at: (u: number) => { x: number; y: number } };

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));

/**
 * A line between two cards, from the sides that face each other: straight along a row, around
 * a card in between (through the channel beside the row), out of the sides to another column,
 * up or down otherwise. `lane` keeps the two directions of a pair apart; `obstacles` are all
 * the cards.
 */
export function curveBetween(a: Box, b: Box, lane = 0, obstacles: Box[] = []): Curve {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const gap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  let p0, p1, p2, p3;
  if (Math.abs(ac.y - bc.y) < a.h / 2) {
    const blocked = obstacles.some((o) => o !== a && o !== b && Math.abs(o.y + o.h / 2 - ac.y) < a.h / 2 && o.x + o.w / 2 > Math.min(ac.x, bc.x) && o.x + o.w / 2 < Math.max(ac.x, bc.x));
    if (blocked) {
      const band = obstacles.filter((o) => o.band === a.band);
      const down = !band.some((o) => o.y < a.y - 1) && band.some((o) => o.y > a.y + 1);
      const up = down ? 1 : -1;
      const dir = bc.x > ac.x ? 1 : -1;
      p0 = { x: ac.x + dir * a.w * 0.3 + lane, y: ac.y + (up * a.h) / 2 };
      p3 = { x: bc.x - dir * b.w * 0.3 + lane, y: bc.y + (up * b.h) / 2 };
      p1 = { x: p0.x + dir * 40, y: p0.y + up * 34 };
      p2 = { x: p3.x - dir * 40, y: p3.y + up * 34 };
    } else {
      const dir = bc.x > ac.x ? 1 : -1;
      p0 = { x: ac.x + (dir * a.w) / 2, y: ac.y + lane };
      p3 = { x: bc.x - (dir * b.w) / 2, y: bc.y + lane };
      const c = (p3.x - p0.x) / 2;
      p1 = { x: p0.x + c, y: p0.y };
      p2 = { x: p3.x - c, y: p3.y };
    }
  } else if (a.band === b.band && gap >= 24) {
    const dir = bc.x > ac.x ? 1 : -1;
    // Fanned out, so the lines leaving one side do not start on the same point.
    const fan = clamp((bc.y - ac.y) * 0.2, a.h * 0.3);
    p0 = { x: ac.x + (dir * a.w) / 2, y: ac.y + fan + lane };
    p3 = { x: bc.x - (dir * b.w) / 2, y: bc.y - fan + lane };
    const c = (p3.x - p0.x) / 2;
    p1 = { x: p0.x + c, y: p0.y };
    p2 = { x: p3.x - c, y: p3.y };
  } else {
    const dn = bc.y > ac.y ? 1 : -1;
    const dx = bc.x - ac.x;
    const lean = Math.max(-a.w * 0.36, Math.min(a.w * 0.36, dx * 0.28));
    p0 = { x: ac.x + lean + lane, y: ac.y + (dn * a.h) / 2 };
    p3 = { x: bc.x - lean + lane, y: bc.y - (dn * b.h) / 2 };
    // Each distance bends at its own height, so lines through a channel do not stack.
    const bend = p0.y + (p3.y - p0.y) * (0.5 + Math.max(-0.16, Math.min(0.16, (dx / 900) * 0.16)) * dn);
    p1 = { x: p0.x, y: bend };
    p2 = { x: p3.x, y: bend };
  }
  const f = (u: number, k: "x" | "y") => (1 - u) ** 3 * p0[k] + 3 * (1 - u) ** 2 * u * p1[k] + 3 * (1 - u) * u * u * p2[k] + u ** 3 * p3[k];
  return { d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`, at: (u) => ({ x: f(u, "x"), y: f(u, "y") }) };
}

const EMPTY: Traffic = { seq: 0, messages: [], work: [] };
/** What the backend keeps: older than this leaves here too. */
const KEEP_MESSAGES = 3000;
const KEEP_MESSAGES_MS = 7 * 24 * 60 * 60_000;
const KEEP_WORK_MS = 12 * 60 * 60_000;

/** What was read since last time, added to what a view has. The same object if nothing came. */
export function mergeTraffic(have: Traffic, fresh: Traffic, now: number): Traffic {
  if (!fresh.messages.length && !fresh.work.length) return have.seq === fresh.seq ? have : { ...have, seq: fresh.seq };
  const known = new Set(have.messages.map((m) => m.id));
  const messages = fresh.messages.length ? [...have.messages, ...fresh.messages.filter((m) => !known.has(m.id))].filter((m) => m.at >= now - KEEP_MESSAGES_MS).sort((a, b) => a.at - b.at).slice(-KEEP_MESSAGES) : have.messages;
  const work = fresh.work.length ? [...have.work, ...fresh.work].filter((w) => w.at >= now - KEEP_WORK_MS).sort((a, b) => a.at - b.at) : have.work;
  return { seq: fresh.seq, messages, work };
}
const POLL_MS = 3000;

/** The fleet's traffic, read only while a view shows it, and paused with the window hidden. */
export function useTraffic(agents: Agent[]) {
  const [traffic, setTraffic] = useState<Traffic>(EMPTY);
  useEffect(() => {
    let seq = 0;
    let reading = false;
    const read = () => {
      if (document.hidden || reading) return;
      reading = true;
      invoke<Traffic>("agent_traffic", { after: seq })
        .then((fresh) => {
          seq = fresh.seq ?? 0;
          setTraffic((have) => mergeTraffic(have, fresh, Date.now()));
        })
        .catch(() => {})
        .finally(() => (reading = false));
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, []);
  const messages = useMemo(() => resolveMessages(traffic.messages, agents), [traffic.messages, agents]);
  return { messages, work: traffic.work };
}
