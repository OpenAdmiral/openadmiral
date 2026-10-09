import { describe, expect, it } from "vitest";
import { noteAttention, takeAttention } from "./attention";

describe("opening the agent a notification was about", () => {
  it("returns it once, while it still waits", () => {
    noteAttention("s1", 1000);
    expect(takeAttention(() => true, 2000)).toBe("s1");
    expect(takeAttention(() => true, 2000)).toBeNull();
  });
  it("ignores old notifications and agents no longer waiting", () => {
    noteAttention("s1", 0);
    expect(takeAttention(() => true, 11 * 60_000)).toBeNull();
    noteAttention("s2", 0);
    expect(takeAttention(() => false, 1)).toBeNull();
  });
});
