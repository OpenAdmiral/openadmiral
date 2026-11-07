import { describe, expect, it } from "vitest";
import { gridState } from "./split";

describe("gridState", () => {
  it("fills a saved grid to its layout's panes", () => expect(gridState({ layout: "3v", panes: ["a"] })).toMatchObject({ layout: "3v", panes: ["a", null, null], active: 0 }));
  it("trims panes the layout no longer has", () => expect(gridState({ layout: "2h", panes: ["a", "b", "c"], active: 5 })).toMatchObject({ panes: ["a", "b"], active: 1 }));
  it("falls back to two side by side", () => expect(gridState({ layout: "nope" })).toMatchObject({ layout: "2v", panes: [null, null] }));
});
