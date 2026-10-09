import { describe, expect, it } from "vitest";
import { parseFocus } from "./focus";

const now = 1_000_000;
const ok = { kind: "artifact", sessionId: "s1", artifactId: "admiral-icon", version: 2, at: now - 1_000 };

describe("focus.json from Open in OpenAdmiral", () => {
  it("accepts a fresh, well-formed request", () => {
    expect(parseFocus(ok, now)).toEqual({ kind: "artifact", sessionId: "s1", artifactId: "admiral-icon", version: 2, at: now - 1_000 });
  });
  it("ignores stale or already handled requests", () => {
    expect(parseFocus({ ...ok, at: now - 30_000 }, now)).toBeNull();
    expect(parseFocus(ok, now, ok.at)).toBeNull();
  });
  it("ignores malformed ones", () => {
    expect(parseFocus(null, now)).toBeNull();
    expect(parseFocus({ ...ok, kind: "session" }, now)).toBeNull();
    expect(parseFocus({ ...ok, sessionId: "" }, now)).toBeNull();
    expect(parseFocus({ ...ok, at: "soon" }, now)).toBeNull();
  });
  it("treats a missing or bad version as the latest", () => {
    expect(parseFocus({ ...ok, version: undefined }, now)?.version).toBeUndefined();
    expect(parseFocus({ ...ok, version: 0 }, now)?.version).toBeUndefined();
  });
});
