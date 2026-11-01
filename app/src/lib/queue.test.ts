import { describe, expect, it } from "vitest";
import { conditionLabel, conditionUnmet, type QueueCondition } from "./queue";
import { centralGroup } from "./schedule";

describe("a condition kind that no longer exists", () => {
  const retired = { kind: "retired", id: "x", status: ["done"] } as unknown as QueueCondition;

  it("counts as no condition: nothing waits, nothing is drawn, nothing throws", () => {
    expect(conditionUnmet(retired, [])).toBeNull();
    expect(conditionLabel(retired, [])).toBe("");
    expect(centralGroup({ id: "q", text: "x", createdAt: 0, after: retired }, true)).toBe("ready");
  });
});
