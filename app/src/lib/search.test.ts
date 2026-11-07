import { describe, expect, it } from "vitest";
import { collect, fold, search, windowHits } from "./search";
import type { Agent } from "./types";

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
const hits = collect(agents, [], { a1: { queue: { v: 1, paused: false, items: [{ id: "q1", text: "Run the e2e suite" } as never] } } }, [{ key: "/x/app", label: "app" }]);

describe("search", () => {
  it("folds case and accents", () => {
    expect(fold("Añade el BOTÓN")).toBe("anade el boton");
    expect(search(hits, "boton apple").map((h) => h.section)).toEqual(["Prompts"]);
  });

  it("finds agents, queued prompts and actions", () => {
    expect(search(hits, "rate")[0]).toMatchObject({ section: "Agents", title: "rate-limits" });
    expect(search(hits, "e2e")[0]).toMatchObject({ section: "Up next", detail: "checkout-redesign" });
    expect(search(hits, "new agent app").find((h) => h.section === "Actions")).toMatchObject({ target: { kind: "new-agent", cwd: "/x/app" } });
    expect(search(hits, "costs")[0]).toMatchObject({ target: { kind: "view", view: "costs" } });
  });

  it("needs every word", () => {
    expect(search(hits, "rate apple")).toEqual([]);
  });

  it("puts running agents before the actions", () => {
    const sections = search(hits, "app").map((h) => h.section);
    expect(sections[0]).toBe("Agents");
    expect(sections.at(-1)).toBe("Actions");
  });

  it("shows the agents and a few actions before any typing", () => {
    const empty = search(hits, "");
    expect(empty.filter((h) => h.section === "Agents")).toHaveLength(2);
    expect(empty.every((h) => h.section === "Agents" || h.section === "Actions")).toBe(true);
  });
});

describe("windowHits", () => {
  const agents = [{ id: "a1", name: "orders-api", project: "api", status: "working" }, { id: "a2", name: "docs", project: "docs", status: "waiting" }] as unknown as Agent[];
  const wins = [
    { label: "main", id: null, focused: false },
    { label: "float-a1", id: "a1", focused: true },
    { label: "float-view-costs", id: "view-costs", focused: false },
  ];
  it("lists every window in a fixed order, marking this one", () => {
    const h = windowHits(wins, agents, "float-a1");
    expect(h.map((x) => x.title)).toEqual(["Main window", "orders-api", "Costs"]);
    expect(h[1].win).toMatchObject({ here: true, status: "working", project: "api" });
    expect(h[0].win?.main).toBe(true);
  });
  it("shows nothing with only one window", () => expect(windowHits(wins.slice(0, 1), agents, "main")).toEqual([]));
  it("keeps windows first and in their order whatever the query", () => {
    const hits = [...windowHits(wins, agents, "main")];
    expect(search(hits, "").map((x) => x.key)).toEqual(["window:main", "window:float-a1", "window:float-view-costs"]);
    expect(search(hits, "orders").map((x) => x.key)).toEqual(["window:float-a1"]);
  });
});
