import type { Artifact } from "./artifacts";
import type { QueueEntry } from "./queue";
import type { Agent } from "./types";
import { basename } from "./utils";

// ⌘K: one search over what the app already holds. Every hit says what it opens; the
// palette turns that into a view change. No index: a few hundred items, filtered per key.

export type Target =
  | { kind: "agent"; id: string }
  | { kind: "view"; view: "agents" | "costs" | "artifacts" | "queue" }
  | { kind: "new-agent"; cwd?: string }
  | { kind: "artifact"; sessionId: string; artifactId: string }
  | { kind: "shortcuts" }
  | { kind: "window"; label: string };

export type Section = "Windows" | "Actions" | "Agents" | "Prompts" | "Artifacts" | "Up next";

export type Hit = { key: string; section: Section; title: string; detail?: string; at?: number; target: Target; haystack: string; win?: WindowCard };

/** A window as ⌘K draws it: a card with its project's color and what its agent is doing. */
export type WindowCard = { project?: string; status?: Agent["status"]; here: boolean; main: boolean };

/** An open window (src-tauri float.rs window_list). */
export type OpenWindow = { label: string; id: string | null; focused: boolean };

const VIEW_TITLES: Record<string, string> = { agents: "Agents map", queue: "Up next", costs: "Costs", artifacts: "Artifacts" };

/** ⌘K's Windows row: the main window and each floating one, in a fixed order. `here`: this window's label. */
export function windowHits(windows: OpenWindow[], agents: Agent[], here: string): Hit[] {
  if (windows.length < 2) return [];
  return windows.map((w) => {
    const agent = w.id && !w.id.startsWith("view-") ? agents.find((a) => a.id === w.id) : undefined;
    const title = !w.id ? "Main window" : agent ? agent.name : (VIEW_TITLES[w.id.slice(5)] ?? "Window");
    const detail = !w.id ? "OpenAdmiral" : agent ? agent.project : "View";
    return {
      key: `window:${w.label}`,
      section: "Windows" as const,
      title,
      detail,
      target: { kind: "window" as const, label: w.label },
      haystack: fold(`${title} ${detail} window ventana`),
      win: { project: agent?.project, status: agent?.status, here: w.label === here, main: !w.id },
    };
  });
}

/** Lower case, without accents: "Sesión" finds "sesion". */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const VIEWS: [Target & { kind: "view" }, string, string][] = [
  [{ kind: "view", view: "agents" }, "Agents map", "⌘E"],
  [{ kind: "view", view: "queue" }, "Up next", "⌘J"],
  [{ kind: "view", view: "costs" }, "Costs", "⌘U"],
  [{ kind: "view", view: "artifacts" }, "Artifacts", "⌘G"],
];

/** Everything searchable, newest first within each section. */
export function collect(agents: Agent[], artifacts: Artifact[], queues: Record<string, QueueEntry>, projects: { key: string; label: string }[]): Hit[] {
  const hits: Hit[] = [];
  const add = (h: Omit<Hit, "haystack">, ...extra: (string | undefined)[]) => hits.push({ ...h, haystack: fold([h.title, h.detail, ...extra].filter(Boolean).join(" ")) });
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));

  add({ key: "new", section: "Actions", title: "New agent", detail: "⌘N", target: { kind: "new-agent" } }, "start create session");
  for (const p of projects) add({ key: `new:${p.key}`, section: "Actions", title: `New agent in ${p.label}`, target: { kind: "new-agent", cwd: p.key } }, "start create session", basename(p.key));
  for (const [target, title, kbd] of VIEWS) add({ key: `view:${target.view}`, section: "Actions", title, detail: kbd, target }, "go to view open");
  add({ key: "shortcuts", section: "Actions", title: "Keyboard shortcuts", detail: "⌘/", target: { kind: "shortcuts" } }, "keys help");

  for (const a of agents) {
    const s = a.session;
    add(
      { key: `agent:${a.id}`, section: "Agents", title: a.name, detail: [a.project, s?.branch].filter(Boolean).join(" · "), at: s?.updatedAt, target: { kind: "agent", id: a.id } },
      a.id.slice(0, 8),
      s?.turn?.prompt,
      s?.lastReply,
    );
    for (const p of s?.activity ?? []) {
      if (p.kind !== "prompt" || !p.text.trim()) continue;
      add({ key: `prompt:${a.id}:${p.at}`, section: "Prompts", title: p.text, detail: a.name, at: p.at, target: { kind: "agent", id: a.id } });
    }
  }
  for (const art of artifacts) {
    add({ key: `art:${art.sessionId}:${art.id}`, section: "Artifacts", title: art.title, detail: `${nameOf.get(art.sessionId) ?? art.project} · ${art.kind}`, at: art.updatedAt, target: { kind: "artifact", sessionId: art.sessionId, artifactId: art.id } });
  }
  for (const [sessionId, entry] of Object.entries(queues)) {
    for (const item of entry.queue?.items ?? []) {
      add({ key: `queue:${sessionId}:${item.id}`, section: "Up next", title: item.text, detail: nameOf.get(sessionId), target: { kind: "view", view: "queue" } });
    }
  }
  return hits;
}

// What is already running comes first: actions (a new agent, a view) are what you reach for least.
const ORDER: Section[] = ["Windows", "Agents", "Prompts", "Artifacts", "Up next", "Actions"];
/** Hits shown per section, so one busy section does not push the others out. */
const PER_SECTION = 6;

/**
 * The hits for a query: every word must appear; a title that starts with the query, then a
 * word in it that does, ranks first; ties go to the newest. Empty: the agents and the actions.
 */
export function search(hits: Hit[], query: string): Hit[] {
  const q = fold(query.trim());
  const words = q.split(/\s+/).filter(Boolean);
  const scored = hits
    .filter((h) => (words.length ? words.every((w) => h.haystack.includes(w)) : h.section === "Windows" || h.section === "Agents" || h.section === "Actions"))
    .map((h) => {
      const t = fold(h.title);
      const score = !q ? 0 : t.startsWith(q) ? 3 : t.split(/[^a-z0-9]+/).some((w) => w.startsWith(words[0])) ? 2 : t.includes(q) ? 1 : 0;
      return { h, score };
    })
    // Windows keep their own order (a row of cards that does not shuffle).
    .sort((a, b) => ORDER.indexOf(a.h.section) - ORDER.indexOf(b.h.section) || (a.h.section === "Windows" ? 0 : b.score - a.score || (b.h.at ?? 0) - (a.h.at ?? 0)));
  const count = new Map<Section, number>();
  return scored
    .filter(({ h }) => {
      const n = count.get(h.section) ?? 0;
      count.set(h.section, n + 1);
      return h.section === "Windows" || n < (q ? PER_SECTION : h.section === "Actions" ? 3 : 9);
    })
    .map(({ h }) => h);
}
