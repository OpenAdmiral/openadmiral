import { describe, expect, it } from "vitest";
import { agentLinks, DAY, delegationLinks, messageLinks, parseSent, resolveAddress, sharedCheckout, waitLinks } from "./agentLinks";
import type { Agent, AdmiralDelegation, AdmiralSession } from "./types";
import type { QueueEntry } from "./queue";

const NOW = 1_800_000_000_000;

function agent(id: string, name: string, over: Partial<Agent> = {}, session: Partial<AdmiralSession> = {}): Agent {
  return {
    id,
    name,
    project: over.project ?? "proj",
    cwd: "/r/proj",
    attachable: true,
    live: true,
    status: "idle",
    session: { v: 1, sessionId: id, cwd: "/r/proj", project: "proj", status: "idle", startedAt: 0, updatedAt: NOW, ...session },
    ...over,
  };
}

function dlg(id: string, over: Partial<AdmiralDelegation> = {}): AdmiralDelegation {
  return {
    v: 1,
    id,
    title: `Task ${id}`,
    detail: "",
    from: { sessionId: "s-a", project: "proj" },
    to: { address: "beta" },
    status: "sent",
    notes: [],
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...over,
  };
}

const A = agent("s-a1234567", "alpha");
const B = agent("s-b1234567", "beta", { project: "other" });
const OLD_B = agent("s-b0000000", "beta", { status: "ended" });

describe("resolveAddress", () => {
  it("matches ids, id prefixes, names and projects; live agents first", () => {
    const agents = [A, OLD_B, B];
    expect(resolveAddress("s-a1234567", agents)?.id).toBe(A.id);
    expect(resolveAddress("s-a12345", agents)?.id).toBe(A.id);
    expect(resolveAddress("beta", agents)?.id).toBe(B.id);
    expect(resolveAddress("@Beta", agents)?.id).toBe(B.id);
    expect(resolveAddress("other", agents)?.id).toBe(B.id);
    expect(resolveAddress("nobody", agents)).toBeUndefined();
    expect(resolveAddress("", agents)).toBeUndefined();
  });
});

describe("delegationLinks", () => {
  const agents = [{ ...A, id: "s-a" }, B];

  it("uses to.sessionId when the recipient accepted, else the address", () => {
    const [byId] = delegationLinks([dlg("dlg_1", { to: { address: "whatever", sessionId: B.id } })], agents, NOW);
    expect(byId).toMatchObject({ kind: "delegation", from: "s-a", to: B.id, title: "Task dlg_1" });
    const [byAddress] = delegationLinks([dlg("dlg_2", { to: { address: "beta" } })], agents, NOW);
    expect(byAddress).toMatchObject({ from: "s-a", to: B.id });
  });

  it("drops unresolvable, self and settled-for-a-day delegations", () => {
    const links = delegationLinks(
      [
        dlg("dlg_x", { to: { address: "nobody" } }),
        dlg("dlg_self", { to: { address: "x", sessionId: "s-a" } }),
        dlg("dlg_old", { status: "done", updatedAt: NOW - DAY - 1 }),
        dlg("dlg_new", { status: "done", updatedAt: NOW - 60_000 }),
      ],
      agents,
      NOW,
    );
    expect(links.map((l) => l.id)).toEqual(["dlg:dlg_new"]);
    expect(links[0]).toMatchObject({ settled: true });
  });

  it("carries queued prompts that wait on the delegation", () => {
    const queues: Record<string, QueueEntry> = {
      "s-a": { queue: { v: 1, paused: false, items: [{ id: "q1", text: "merge it", createdAt: 1, after: { kind: "delegation", id: "dlg_1", status: ["done"] } }] } },
    };
    const [l] = delegationLinks([dlg("dlg_1")], agents, NOW, queues);
    expect(l.kind === "delegation" && l.conditions).toEqual([{ agentId: "s-a", text: "merge it", statuses: ["done"] }]);
  });
});

describe("parseSent", () => {
  it("reads the mod's SendMessage line and ignores delegation lines", () => {
    expect(parseSent("→ beta: Please review the PR")).toEqual({ to: "beta", text: "Please review the PR" });
    expect(parseSent("→ acme-mcp-server: Heads-up: my edits")).toEqual({ to: "acme-mcp-server", text: "Heads-up: my edits" });
    expect(parseSent("⇢ beta: Add scopes")).toBeNull();
    expect(parseSent("dlg_abc12345 → done")).toBeNull();
    expect(parseSent("hello")).toBeNull();
  });
});

describe("messageLinks", () => {
  it("dedupes per direction, keeps the latest text, and skips old, unknown and own-subagent messages", () => {
    const a = agent("s-a1234567", "alpha", {}, {
      subagents: [{ id: "a1b2c3", status: "running", startedAt: 0 }],
      activity: [
        { at: NOW - 5000, kind: "sent", text: "→ beta: first" },
        { at: NOW - 1000, kind: "sent", text: "→ beta: second" },
        { at: NOW - 4 * 3600_000, kind: "sent", text: "→ beta: ancient" },
        { at: NOW - 1000, kind: "sent", text: "→ a1b2c3: to my subagent" },
        { at: NOW - 1000, kind: "sent", text: "→ ghost: nobody" },
        { at: NOW - 1000, kind: "received", text: "→ beta: not mine" },
      ],
    });
    const b = agent("s-b1234567", "beta", {}, { activity: [{ at: NOW - 2000, kind: "sent", text: "→ alpha: back" }] });
    const links = messageLinks([a, b], NOW);
    expect(links).toHaveLength(2);
    expect(links.find((l) => l.from === a.id)).toMatchObject({ to: b.id, text: "second", count: 2, at: NOW - 1000 });
    expect(links.find((l) => l.from === b.id)).toMatchObject({ to: a.id, text: "back", count: 1 });
  });

  it("reaches another session through one of its subagents' ids", () => {
    const a = agent("s-a1234567", "alpha", {}, { activity: [{ at: NOW, kind: "sent", text: "→ zz99: hi" }] });
    const b = agent("s-b1234567", "beta", {}, { subagents: [{ id: "zz99", status: "running", startedAt: 0 }] });
    expect(messageLinks([a, b], NOW)[0]).toMatchObject({ from: a.id, to: b.id });
  });
});

describe("waitLinks", () => {
  it("draws pending session-idle conditions only", () => {
    const queues: Record<string, QueueEntry> = {
      [A.id]: {
        queue: {
          v: 1,
          paused: false,
          items: [
            { id: "q1", text: "go on", createdAt: 5, after: { kind: "session-idle", sessionId: B.id } },
            { id: "q2", text: "already sent", createdAt: 6, after: { kind: "session-idle", sessionId: B.id } },
            { id: "q3", text: "plain", createdAt: 7 },
          ],
        },
        sent: { v: 1, sent: [{ id: "q2", at: 9 }] },
      },
    };
    expect(waitLinks(queues, [A, B])).toEqual([{ kind: "wait", id: `wait:${A.id}>${B.id}`, from: A.id, to: B.id, text: "go on", at: 5, count: 1 }]);
  });
});

describe("agentLinks", () => {
  it("keeps only links between agents on the map", () => {
    const a = agent("s-a1234567", "alpha", {}, { activity: [{ at: NOW, kind: "sent", text: "→ beta: hi" }] });
    expect(agentLinks({ agents: [a, B], shown: [a, B], delegations: [], queues: {}, now: NOW })).toHaveLength(1);
    expect(agentLinks({ agents: [a, B], shown: [a], delegations: [], queues: {}, now: NOW })).toHaveLength(0);
  });
});

describe("sharedCheckout", () => {
  const repo = { root: "/r/proj", remote: null };
  it("notes agents of one repo on different branches or worktrees", () => {
    const x = agent("1", "x", {}, { repo, branch: "main" });
    const y = agent("2", "y", { cwd: "/r/proj-wt" }, { repo, branch: "feat", worktree: true });
    expect(sharedCheckout([x, y])).toEqual({ agents: 2, worktrees: 1, branches: ["main", "feat"] });
    expect(sharedCheckout([x, agent("3", "z", {}, { repo, branch: "main" })])).toBeNull();
    expect(sharedCheckout([x])).toBeNull();
  });
});
