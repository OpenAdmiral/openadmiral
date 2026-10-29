import { describe, expect, it } from "vitest";
import { relayout, show, SINGLE } from "./split";

describe("split panes", () => {
  it("puts a picked agent in the active pane, or focuses the pane that has it", () => {
    const s = relayout({ ...SINGLE, panes: ["a"] }, "2v", ["a", "b", "c"]);
    expect(s.panes).toEqual(["a", "b"]);
    expect(show(s, "b").active).toBe(1);
    expect(show(s, "c")).toMatchObject({ panes: ["c", "b"], active: 0 });
  });

  it("keeps panes in order across layouts and fills new ones with the next agents", () => {
    const four = relayout({ ...SINGLE, panes: ["b"] }, "4", ["a", "b", "c"]);
    expect(four.panes).toEqual(["b", "a", "c", null]);
    const two = relayout({ ...four, active: 3 }, "2h", []);
    expect(two).toMatchObject({ panes: ["b", "a"], active: 1, last: "2h" });
    expect(relayout(two, "1", []).last).toBe("2h");
  });
});
