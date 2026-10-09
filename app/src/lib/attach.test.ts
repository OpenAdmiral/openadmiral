import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentViewDetector } from "./attach";

// Captured from a real `claude attach` before and after typing /exit (names scrubbed).
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)).toString("utf8");

describe("agent view after /exit in an attached session", () => {
  it("is not seen while attached to the session", () => {
    const seen = agentViewDetector();
    expect(seen(fixture("attach-session.bin"))).toBe(false);
  });

  it("is seen once the client drops into the agent view", () => {
    const seen = agentViewDetector();
    seen(fixture("attach-session.bin"));
    expect(seen(fixture("attach-agent-view.bin"))).toBe(true);
  });

  it("is seen even when the output arrives in small pieces", () => {
    const seen = agentViewDetector();
    const text = fixture("attach-agent-view.bin");
    let hit = false;
    for (let i = 0; i < text.length; i += 17) hit = seen(text.slice(i, i + 17)) || hit;
    expect(hit).toBe(true);
  });

  it("finds the phrase with the cursor moved between words", () => {
    const seen = agentViewDetector();
    expect(seen("\x1b[3;5H describe \x1b[1Ca task\x1b[2C for a new \x1b[0msession")).toBe(true);
  });
});
