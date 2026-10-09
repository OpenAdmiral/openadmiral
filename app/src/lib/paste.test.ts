import { describe, expect, it } from "vitest";
import { pasteAction, pathsText, shellEscape } from "./paste";

describe("pasting into an agent terminal", () => {
  it("escapes paths like Terminal.app", () => {
    expect(shellEscape("/Users/alex/Desktop/Screenshot 2026-10-08 at 02.26.17.png")).toBe("/Users/alex/Desktop/Screenshot\\ 2026-10-08\\ at\\ 02.26.17.png");
    expect(shellEscape("/tmp/a (1)&b's.png")).toBe("/tmp/a\\ \\(1\\)\\&b\\'s.png");
  });

  it("a Finder copy pastes the files' paths, never their icon", () => {
    expect(pasteAction({ kind: "files", paths: ["/a b.png", "/c.pdf"] }, "a b.png")).toEqual({ type: "text", data: "/a\\ b.png /c.pdf " });
  });

  it("raw image data sends Ctrl+V so Claude Code reads the clipboard image", () => {
    expect(pasteAction({ kind: "image" }, "")).toEqual({ type: "raw", data: "\x16" });
  });

  it("text pastes as text", () => {
    expect(pasteAction({ kind: "text" }, "hello")).toEqual({ type: "text", data: "hello" });
    expect(pasteAction({ kind: "empty" }, "")).toBeNull();
    expect(pathsText([])).toBe("");
  });
});
