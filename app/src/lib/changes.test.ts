import { describe, expect, it } from "vitest";
import { diffRows, prPrompt, reviewPrompt } from "@/lib/changes";

describe("diffRows", () => {
  it("numbers each side", () => {
    const rows = diffRows("@@ -10,3 +10,3 @@ fn x\n keep\n-old\n+new\n same\n\\ No newline at end of file");
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ fn x" },
      { kind: "ctx", text: "keep", old: 10, new: 10 },
      { kind: "del", text: "old", old: 11, new: null },
      { kind: "add", text: "new", old: null, new: 11 },
      { kind: "ctx", text: "same", old: 12, new: 12 },
      { kind: "note", text: "No newline at end of file" },
    ]);
  });
});

describe("reviewPrompt", () => {
  it("groups notes by file, in line order", () => {
    const p = reviewPrompt([
      { id: "2", path: "a.ts", line: 9, side: "new", code: "  return x;", text: "Handle null" },
      { id: "1", path: "a.ts", line: 3, side: "new", code: "import y", text: "Unused" },
      { id: "3", path: "b.ts", line: 1, side: "old", code: "gone()", text: "Keep this" },
    ]);
    expect(p).toContain("a.ts:\n- Line 3: Unused\n  > import y\n- Line 9: Handle null\n  > return x;");
    expect(p).toContain("b.ts:\n- Line 1 (removed line): Keep this");
  });
});

describe("prPrompt", () => {
  it("targets the default branch by its short name", () => expect(prPrompt({ branch: "feat/x", base: "origin/main" })).toContain("against main"));
});
