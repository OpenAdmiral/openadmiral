import { describe, expect, it } from "vitest";
import { resolveAddress, waitLinks } from "./agentLinks";
import type { Agent, AdmiralSession } from "./types";
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
    expect(waitLinks(queues, [A, B])).toEqual([{ id: `wait:${A.id}>${B.id}`, from: A.id, to: B.id, text: "go on", at: 5, count: 1 }]);
  });
});
