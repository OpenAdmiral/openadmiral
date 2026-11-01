import { describe, expect, it } from "vitest";
import { untrustedFolder } from "./trust";

describe("a restart refused for trust", () => {
  it("asks for the folder Claude Code names", () => {
    const error = "Workspace not trusted. Run `claude` in /Users/me/my project once and accept the trust prompt, then retry.";
    expect(untrustedFolder(error, "/elsewhere")).toBe("/Users/me/my project");
  });

  it("falls back to the session's folder, and ignores other errors", () => {
    expect(untrustedFolder("Workspace not trusted.", "/x")).toBe("/x");
    expect(untrustedFolder("job not found", "/x")).toBeNull();
  });
});
