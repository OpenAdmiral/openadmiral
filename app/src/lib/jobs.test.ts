import { describe, expect, it } from "vitest";
import { jobView, observe, parseOutput, screenLines, type Job, type Tail } from "./jobs";

const T0 = 1_800_000_000_000;

describe("parseOutput", () => {
  it("reads counts and percents from the last line that has one", () => {
    expect(parseOutput("Compiling foo\n   Building [=====>   ] 210/450: tauri\n")).toMatchObject({ done: 210, total: 450 });
    expect(parseOutput("tests/a.py ....  [ 45%]\ntests/b.py ..")).toMatchObject({ percent: 45, line: "tests/b.py .." });
    expect(parseOutput("Downloading  73%|███████   | 73/100 [00:12<00:04]")).toMatchObject({ done: 73, total: 100 });
  });

  it("keeps what a terminal would show after carriage returns and colours", () => {
    expect(screenLines("\x1b[32m 10%\r 20%\r 30%\x1b[0m\n")).toEqual(["30%"]);
    expect(parseOutput("\x1b[32m 10%\r 20%\r 30%\x1b[0m\n").percent).toBe(30);
  });

  it("ignores dates, versions, ratios above the total and percents over 100", () => {
    expect(parseOutput("Built at 2026/10/15 with node 20.1.0").percent).toBeUndefined();
    expect(parseOutput("load 5/3 done").percent).toBeUndefined();
    expect(parseOutput("coverage went up 250%").percent).toBeUndefined();
    expect(parseOutput("no numbers here")).toEqual({ line: "no numbers here" });
  });
});

describe("jobView", () => {
  const job: Job = { id: "b1", label: "cargo test", output: "/tmp/t/tasks/b1.output", startedAt: T0 - 120_000, status: "running" };
  const tail = (size: number, at: number): Tail => ({ path: job.output!, size, modifiedAt: at, tail: "" });

  it("measures the pace of the output's own count", () => {
    let seen = observe(undefined, tail(10, T0 - 60_000), { percent: 25, done: 60, total: 240 }, T0 - 60_000);
    seen = observe(seen, tail(20, T0), { percent: 50, done: 120, total: 240 }, T0);
    const v = jobView(job, { percent: 50, done: 120, total: 240, line: "test 120" }, seen, T0);
    // 25 points a minute, 50 left: 2 minutes.
    expect(v).toMatchObject({ count: "120/240", percent: 50, eta: "≈ 2 min" });
  });

  it("flags a command that has gone quiet for far longer than usual", () => {
    let seen = observe(undefined, tail(10, T0 - 400_000), {}, T0 - 400_000);
    seen = observe(seen, tail(20, T0 - 390_000), {}, T0 - 390_000);
    expect(jobView(job, {}, seen, T0).stalled).toBe("no output for 6m");
    expect(jobView(job, {}, seen, T0 - 380_000).stalled).toBeUndefined();
  });

  it("says how it failed", () => {
    expect(jobView({ ...job, status: "failed", exitCode: 101, endedAt: T0 }, undefined, undefined, T0).failed).toBe("failed (exit 101)");
    expect(jobView({ ...job, status: "killed", endedAt: T0 }, undefined, undefined, T0).failed).toBe("stopped");
  });
});
