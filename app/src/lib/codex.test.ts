import { describe, expect, it } from "vitest";
import { codexAgent, type CodexRow } from "./codex";

const row = (over: Partial<CodexRow> = {}): CodexRow => ({
  id: "codex-1",
  name: "refactor",
  cwd: "/r/app",
  createdAt: 1000,
  status: "working",
  running: true,
  updatedAt: 2000,
  lastReply: null,
  waiting: null,
  argv: ["codex", "-c", "x"],
  ...over,
});

describe("codexAgent", () => {
  it("is drawn like any agent, with its terminal's command", () => {
    const a = codexAgent(row(), 5000);
    expect(a).toMatchObject({ id: "codex-1", project: "app", status: "working", attachable: true, codex: { argv: ["codex", "-c", "x"], running: true } });
  });
  it("waits on you with what it asks", () => {
    expect(codexAgent(row({ status: "waiting", waiting: "Run npm install" }), 5000).session?.waiting).toMatchObject({ reason: "permission", detail: "Run npm install" });
  });
  it("reads as idle once stopped", () => expect(codexAgent(row({ status: "ended", running: false }), 5000).status).toBe("idle"));
});
