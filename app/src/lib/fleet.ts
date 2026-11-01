import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { resolveAddress } from "./agentLinks";
import type { Agent } from "./types";

// What the agents are doing to and for each other, from what they already do: their
// SendMessage traffic and their work. Who works for whom and who awaits whom is deduced from
// the order of things, so the views say so plainly; nothing asks the agents to report it.

export type Message = { id: string; at: number; from: string; to: string; summary?: string | null; text: string };
export type Work = { at: number; session: string; label: string };
export type Traffic = { messages: Message[]; work: Work[] };

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

/**
 * A band per project, stacked. Three agents or more zigzag across two rows: every pair then
 * has a way between them that crosses no card. `counts` is how many agents each band has.
 */
export function bandLayout(counts: number[], width: number) {
  let top = 0;
  const bands = counts.map((n) => {
    const rows = n >= 3 ? 2 : 1;
    const height = PAD * 2 + rows * ROW_H + (rows - 1) * CHANNEL;
    const area = Math.max(0, width - GUTTER - CARD_W - 24);
    const slot = n > 1 ? Math.min(area / (n - 1), rows === 2 ? 300 : 340) : 0;
    const cards = Array.from({ length: n }, (_, i) => ({ left: GUTTER + 12 + Math.max(slot, rows === 2 ? 150 : CARD_W + 40) * i, top: PAD + (rows === 2 && i % 2 ? ROW_H + CHANNEL : 0) }));
    const band = { top, height, rows, cards };
    top += height + BAND_GAP;
    return band;
  });
  return { bands, height: bands.length ? top - BAND_GAP : 0 };
}

export type Box = { x: number; y: number; w: number; h: number };
export type Curve = { d: string; at: (u: number) => { x: number; y: number } };

/**
 * A line between two cards, always from the sides that face each other: straight along a row,
 * through the channel between rows, and up or down between bands. `lane` keeps the two
 * directions of a pair apart.
 */
export function curveBetween(a: Box, b: Box, lane = 0): Curve {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let p0, p1, p2, p3;
  if (Math.abs(ac.y - bc.y) < a.h / 2) {
    const dir = bc.x > ac.x ? 1 : -1;
    p0 = { x: ac.x + (dir * a.w) / 2, y: ac.y + lane };
    p3 = { x: bc.x - (dir * b.w) / 2, y: bc.y + lane };
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

const EMPTY: Traffic = { messages: [], work: [] };
const POLL_MS = 3000;

/** The fleet's traffic, read only while a view shows it, and paused with the window hidden. */
export function useTraffic(agents: Agent[]) {
  const [traffic, setTraffic] = useState<Traffic>(EMPTY);
  useEffect(() => {
    const read = () => !document.hidden && invoke<Traffic>("agent_traffic").then(setTraffic, () => {});
    read();
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, []);
  const messages = useMemo(() => resolveMessages(traffic.messages, agents), [traffic.messages, agents]);
  return { messages, work: traffic.work };
}
