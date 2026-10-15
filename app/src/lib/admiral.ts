import { noteAttention } from "./attention";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentStatus, CliAgent, AdmiralDelegation, AdmiralSession, DiscoveredSession } from "./types";
import { basename } from "./utils";
import type { QueueEntry } from "./queue";
import { formatElapsed } from "./progress";
import type { Artifact } from "./artifacts";

/** A turn at least this long gets a notification when it ends. */
const DONE_NOTICE_MIN_MS = 2 * 60_000;

/** A pending hand-off or exit request (docs/CONTRACT.md "requests/"); `waiting` is the mod's note while it cannot exit yet. */
export type AdmiralRequest = { action: "handoff" | "exit"; at: number; servedAt?: number; waiting?: string };

type Snapshot = { sessions: AdmiralSession[]; delegations: AdmiralDelegation[]; queues?: Record<string, QueueEntry>; artifacts?: Artifact[]; requests?: Record<string, AdmiralRequest> };

/** A session file this old, whose session the CLI no longer lists, has ended. */
const STALE_MS = 90_000;

function statusOf(session: AdmiralSession | undefined, cli: CliAgent | undefined, now: number): AgentStatus {
  const fresh = session && now - session.updatedAt < STALE_MS;
  if (!cli && !fresh) return "ended";
  if (session?.status === "waiting") return "waiting";
  if (session?.status === "working" || cli?.status === "busy") return "working";
  if (session?.status === "ended" && !cli) return "ended";
  if (session?.status === "starting") return "starting";
  return "idle";
}

/**
 * Session files that are not real sessions: a `claude` process the CLI never
 * registered (Claude's agent view after /exit in an attach loads the mod too).
 * Hidden when the CLI has not listed a fresh, non-ended file for two polls in a
 * row, and when a session the CLI does not list has no transcript at all.
 */
export function isPhantom(s: AdmiralSession, listed: boolean, misses: number, now = Date.now()) {
  if (listed) return false;
  if (s.hasTranscript === false) return true;
  const fresh = now - s.updatedAt < STALE_MS;
  return fresh && s.status !== "ended" && misses >= 2;
}

/**
 * Old session id → the id the same process carries now. /clear gives a running
 * session a new id: the mod marks the old file `supersededBy`; for a mod that
 * predates that, a background job still listed under its first id (the short
 * id is the original session id's prefix) with another session id gives it away.
 */
export function supersededMap(sessions: AdmiralSession[], cli: CliAgent[]) {
  const map = new Map<string, string>();
  const listed = new Set(cli.map((c) => c.sessionId));
  for (const s of sessions) if (s.supersededBy) map.set(s.sessionId, s.supersededBy);
  for (const c of cli) {
    if (!c.id || c.sessionId.startsWith(c.id)) continue;
    for (const s of sessions) if (s.sessionId.startsWith(c.id) && !listed.has(s.sessionId)) map.set(s.sessionId, c.sessionId);
  }
  // Follow chains (two /clears in a row) to the live end.
  for (const [k, v] of map) {
    let end = v;
    for (let i = 0; i < 10 && map.has(end); i++) end = map.get(end)!;
    map.set(k, end);
  }
  return map;
}

export function mergeAgents(
  sessions: AdmiralSession[],
  cli: CliAgent[],
  now = Date.now(),
  names: Map<string, string> = new Map(),
  misses: Map<string, number> = new Map(),
  discovered: DiscoveredSession[] = [],
): Agent[] {
  const byId = new Map<string, Agent>();
  const cliById = new Map(cli.map((c) => [c.sessionId, c]));
  const superseded = supersededMap(sessions, cli);
  for (const s of sessions) {
    // The conversation before a /clear: the same agent lives on under its new id.
    if (superseded.has(s.sessionId)) continue;
    const c = cliById.get(s.sessionId);
    if (isPhantom(s, !!c, misses.get(s.sessionId) ?? 0, now)) continue;
    byId.set(s.sessionId, {
      id: s.sessionId,
      // A session the CLI no longer lists keeps the name it was last seen with.
      name: c?.name ?? s.name ?? names.get(s.sessionId) ?? s.project,
      project: s.project || basename(s.cwd),
      cwd: s.cwd,
      attachable: c ? c.kind !== "interactive" : false,
      live: !!c || now - s.updatedAt < STALE_MS,
      status: statusOf(s, c, now),
      session: s,
      cli: c,
    });
  }
  for (const c of cli) {
    if (byId.has(c.sessionId)) continue;
    byId.set(c.sessionId, {
      id: c.sessionId,
      name: c.name ?? basename(c.cwd),
      project: basename(c.cwd),
      cwd: c.cwd,
      attachable: c.kind !== "interactive",
      live: true,
      status: statusOf(undefined, c, now),
      cli: c,
    });
  }
  // Running without the plugin: what its transcript says, read-only.
  for (const d of discovered) {
    if (byId.has(d.sessionId)) continue;
    byId.set(d.sessionId, {
      id: d.sessionId,
      name: d.project,
      project: d.project,
      cwd: d.cwd,
      attachable: false,
      live: true,
      status: d.status,
      session: {
        v: 1,
        sessionId: d.sessionId,
        cwd: d.cwd,
        project: d.project,
        branch: d.branch ?? undefined,
        status: d.status,
        // The transcript's clock can be ahead of this one (it ticks every 5 s): never in the future.
        turn: d.status === "working" && d.lastPrompt ? { startedAt: Math.min(d.updatedAt, now), prompt: d.lastPrompt } : undefined,
        lastReply: d.lastReply ?? undefined,
        startedAt: Math.min(d.updatedAt, now),
        updatedAt: now,
      } as AdmiralSession,
      unplugged: { via: d.via },
    });
  }
  // Claude Code names sessions after their folder plus two characters of their id, so
  // a folder with many sessions repeats names: tell those apart by a longer piece of the id.
  const named = new Map<string, number>();
  for (const a of byId.values()) named.set(a.name, (named.get(a.name) ?? 0) + 1);
  for (const a of byId.values()) if ((named.get(a.name) ?? 0) > 1) a.twin = a.id.slice(0, 4);
  const order: Record<AgentStatus, number> = { waiting: 0, working: 1, starting: 2, idle: 3, ended: 4 };
  return [...byId.values()].sort(
    (a, b) => order[a.status] - order[b.status] || a.project.localeCompare(b.project) || a.name.localeCompare(b.name),
  );
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notifications are a nicety; a refusal changes nothing else.
  }
}

export function useAdmiral() {
  const [snapshot, setSnapshot] = useState<Snapshot>({ sessions: [], delegations: [] });
  const [cli, setCli] = useState<CliAgent[]>([]);
  const [cliReady, setCliReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Sessions running without the plugin, and whether the plugin is installed (every 10 s).
  const [discovery, setDiscovery] = useState<{ pluginInstalled: boolean; sessions: DiscoveredSession[] }>({ pluginInstalled: true, sessions: [] });
  useEffect(() => {
    const check = () => invoke<{ pluginInstalled: boolean; sessions: DiscoveredSession[] }>("discover_sessions").then(setDiscovery, () => {});
    check();
    const t = setInterval(check, 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    invoke<Snapshot>("load_snapshot")
      .then((s) => {
        setSnapshot(s);
        setLoaded(true);
      })
      .catch(() => {});
    invoke<CliAgent[]>("list_agents")
      .then((list) => {
        setCli(list);
        setCliReady(true);
      })
      .catch(() => {});
    const offs = [
      listen<Snapshot>("openadmiral://snapshot", (e) => setSnapshot(e.payload)),
      listen<CliAgent[]>("openadmiral://agents", (e) => {
        setCli(Array.isArray(e.payload) ? e.payload : []);
        setCliReady(true);
      }),
    ];
    // Ages and the stale rule move with the clock, not only with events.
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      offs.forEach((p) => p.then((off) => off()));
      clearInterval(tick);
    };
  }, []);

  const names = useRef(new Map<string, string>());
  for (const c of cli) if (c.name) names.current.set(c.sessionId, c.name);
  // How many CLI polls in a row have not listed each session file (see isPhantom).
  const misses = useRef(new Map<string, number>());
  useEffect(() => {
    if (!cliReady) return;
    const listed = new Set(cli.map((c) => c.sessionId));
    const next = new Map<string, number>();
    for (const s of snapshot.sessions) if (!listed.has(s.sessionId)) next.set(s.sessionId, (misses.current.get(s.sessionId) ?? 0) + 1);
    misses.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli]);
  const agents = useMemo(
    () => mergeAgents(snapshot.sessions, cli, now, names.current, cliReady ? misses.current : new Map(), discovery.sessions),
    [snapshot.sessions, cli, now, cliReady, discovery.sessions],
  );
  const superseded = useMemo(() => supersededMap(snapshot.sessions, cli), [snapshot.sessions, cli]);
  const delegations = useMemo(
    () => [...snapshot.delegations].sort((a, b) => b.updatedAt - a.updatedAt),
    [snapshot.delegations],
  );

  // Each plan window from the freshest session that has a reading of it.
  const rateLimits = useMemo(() => {
    const byKind = new Map<string, { r: NonNullable<AdmiralSession["rateLimits"]>[number]; at: number }>();
    for (const s of snapshot.sessions) {
      for (const r of s.rateLimits ?? []) {
        const seen = byKind.get(r.kind);
        if (!seen || s.updatedAt > seen.at) byKind.set(r.kind, { r, at: s.updatedAt });
      }
    }
    const order = ["five_hour", "seven_day", "seven_day_opus"];
    return [...byKind.values()].map((v) => v.r).sort((a, b) => (order.indexOf(a.kind) + 99) % 99 - (order.indexOf(b.kind) + 99) % 99);
  }, [snapshot.sessions]);

  const attention = agents.filter((a) => a.status === "waiting").length;
  useEffect(() => {
    invoke("set_attention", { count: attention }).catch(() => {});
  }, [attention]);

  // Notify on transitions only: the first snapshot is the baseline.
  const prev = useRef<{ agents: Map<string, AgentStatus>; dlg: Map<string, string>; ended: Map<string, number> } | null>(null);
  useEffect(() => {
    const agentMap = new Map(agents.map((a) => [a.id, a.status]));
    const dlgMap = new Map(delegations.map((d) => [d.id, d.status]));
    const ended = new Map(agents.flatMap((a) => (a.session?.lastTurn ? [[a.id, a.session.lastTurn.endedAt] as const] : [])));
    const before = prev.current;
    if (before) {
      for (const a of agents) {
        if (a.status === "waiting" && before.agents.get(a.id) !== "waiting") {
          const w = a.session?.waiting;
          noteAttention(a.id);
          notify(`${a.name} needs you`, w?.detail ?? (w?.reason === "permission" ? "Waiting for a permission" : "Waiting for your answer"));
        }
      }
      for (const a of agents) {
        // A long turn just ended: say how it went, so nobody has to keep checking.
        const t = a.session?.lastTurn;
        if (t && before.ended.get(a.id) !== t.endedAt && Date.now() - t.endedAt < 60_000 && t.endedAt - t.startedAt >= DONE_NOTICE_MIN_MS) {
          const took = formatElapsed(t.endedAt - t.startedAt);
          if (t.percent !== undefined && t.percent < 100) notify(`${a.name} stopped at ${t.percent}%`, `After ${took}${t.step ? ` · ${t.step}` : ""}`);
          else notify(`${a.name} is done`, `Finished in ${took}`);
        }
      }
      for (const d of delegations) {
        const was = before.dlg.get(d.id);
        if (was !== d.status && (d.status === "done" || d.status === "blocked")) {
          notify(d.status === "done" ? `Done: ${d.title}` : `Blocked: ${d.title}`, `${d.to.project ?? d.to.address} → ${d.from.project}`);
        }
      }
    }
    if (agents.length || delegations.length) prev.current = { agents: agentMap, dlg: dlgMap, ended };
  }, [agents, delegations]);

  return { agents, delegations, rateLimits, attention, now, superseded, cliReady, queues: snapshot.queues ?? {}, artifacts: snapshot.artifacts ?? [], requests: snapshot.requests ?? {}, loaded, pluginInstalled: discovery.pluginInstalled, hasData: snapshot.sessions.length > 0 || cli.length > 0 };
}
