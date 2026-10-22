import { describe, expect, it } from "vitest";
import { collect, fold, search } from "./search";
import type { Agent, AdmiralDelegation } from "./types";

const agent = (id: string, name: string, project: string, prompts: string[] = []): Agent =>
  ({
    id,
    name,
    project,
    cwd: `/x/${project}`,
    attachable: true,
    live: true,
    status: "idle",
    session: { v: 1, sessionId: id, cwd: `/x/${project}`, project, status: "idle", startedAt: 0, updatedAt: 10, branch: "main", activity: prompts.map((text, i) => ({ at: i + 1, kind: "prompt", text })) },
  }) as Agent;

const agents = [agent("a1", "checkout-redesign", "app", ["Añade el botón de Apple Pay"]), agent("b2", "rate-limits", "api", ["Per-key rate limiting"])];
const delegations = [{ v: 1, id: "dlg_ab12cd34", title: "Return 429 with Retry-After", detail: "", from: { sessionId: "b2", project: "api" }, to: { address: "app", project: "app" }, status: "done", notes: [], createdAt: 1, updatedAt: 5 }] as AdmiralDelegation[];
const hits = collect(agents, delegations, [], { a1: { queue: { v: 1, paused: false, items: [{ id: "q1", text: "Run the e2e suite" } as never] } } }, [{ key: "/x/app", label: "app" }]);

describe("search", () => {
  it("folds case and accents", () => {
    expect(fold("Añade el BOTÓN")).toBe("anade el boton");
    expect(search(hits, "boton apple").map((h) => h.section)).toEqual(["Prompts"]);
  });

  it("finds agents, delegations, queued prompts and actions", () => {
    expect(search(hits, "rate")[0]).toMatchObject({ section: "Agents", title: "rate-limits" });
    expect(search(hits, "429")[0]).toMatchObject({ section: "Delegations", target: { kind: "view", view: "delegations" } });
    expect(search(hits, "e2e")[0]).toMatchObject({ section: "Up next", detail: "checkout-redesign" });
    expect(search(hits, "new agent app")[0]).toMatchObject({ section: "Actions", target: { kind: "new-agent", cwd: "/x/app" } });
    expect(search(hits, "costs")[0]).toMatchObject({ target: { kind: "view", view: "costs" } });
  });

  it("needs every word", () => {
    expect(search(hits, "rate apple")).toEqual([]);
  });

  it("shows the agents and a few actions before any typing", () => {
    const empty = search(hits, "");
    expect(empty.filter((h) => h.section === "Agents")).toHaveLength(2);
    expect(empty.every((h) => h.section === "Agents" || h.section === "Actions")).toBe(true);
  });
});
