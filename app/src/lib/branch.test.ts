import { describe, expect, it } from "vitest";
import { branchTone } from "./utils";

describe("branchTone", () => {
  it("colors branches by how careful to be on them", () => {
    expect(branchTone("main")).toContain("red");
    expect(branchTone("master")).toContain("red");
    expect(branchTone("sandbox")).toContain("orange");
    expect(branchTone("quality")).toContain("orange");
    expect(branchTone("develop")).toContain("blue");
    expect(branchTone("dev")).toContain("blue");
    expect(branchTone("Main")).toContain("red");
    expect(branchTone("feat/x")).toBe("");
    expect(branchTone(undefined)).toBe("");
  });
});

import { contextUsed, fillTone } from "./utils";

describe("context and fill tones", () => {
  it("prefers the usable-context share, like the statusline", () => {
    expect(contextUsed({ percent: 63, usablePercent: 75 })).toBe(75);
    expect(contextUsed({ percent: 63 })).toBe(63);
    expect(contextUsed(undefined)).toBeUndefined();
  });
  it("is blue below 60, orange from 60, red from 80", () => {
    expect(fillTone(59)).toBe("ok");
    expect(fillTone(60)).toBe("warn");
    expect(fillTone(79)).toBe("warn");
    expect(fillTone(80)).toBe("high");
  });
});
