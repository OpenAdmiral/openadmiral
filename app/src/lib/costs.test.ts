import { describe, expect, it } from "vitest";
import { bucketDays, computeCosts, escapePath, friendlyProject, localDate, money, type CcReport, type CcRow, type DayCost } from "./costs";

// A fixed "today" so the fixtures don't drift with the real clock.
const NOW = new Date(2026, 9, 21); // Oct 21, 2026

const day = (daysAgo: number) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  return localDate(d);
};
const row = (daysAgo: number, cost: number, tokens = 0, models?: { modelName: string; cost: number }[]): CcRow => ({
  date: day(daysAgo),
  totalCost: cost,
  totalTokens: tokens,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  modelBreakdowns: models,
});
const report = (projects: Record<string, CcRow[]>): CcReport => ({ fetchedAt: 0, data: { projects } });

// alpha works this month; beta spent most of its money 40 days ago, beyond a 30-day range.
const FIXTURE = report({
  "-Users-x-dev-alpha": [row(0, 2, 100, [{ modelName: "claude-fable-5", cost: 2 }]), row(3, 5, 200), row(10, 3, 300)],
  "-Users-x-dev-beta": [row(5, 20, 50), row(40, 50, 1000)],
});

describe("computeCosts over a 30-day range", () => {
  const costs = computeCosts(FIXTURE, [], 30, NOW)!;

  it("builds 30 zero-filled days ending today", () => {
    expect(costs.rangeDays).toBe(30);
    expect(costs.allTime).toBe(false);
    expect(costs.days).toHaveLength(30);
    expect(costs.days[29].date).toBe(day(0));
    expect(costs.days[0].date).toBe(day(29));
    expect(costs.days[28].total).toBe(0); // a day with no rows stays zero
  });

  it("splits each project into in-range and all-time cost", () => {
    const beta = costs.projects.find((p) => p.name === "beta")!;
    expect(beta.inRange).toBe(20); // the 40-days-ago row is outside the range…
    expect(beta.total).toBe(70); // …but still counts toward the all-time total
    expect(beta.tokensInRange).toBe(50);
    const alpha = costs.projects.find((p) => p.name === "alpha")!;
    expect(alpha.inRange).toBe(10);
    expect(alpha.total).toBe(10);
  });

  it("ranks projects by in-range cost and sums the headline numbers", () => {
    expect(costs.projects.map((p) => p.name)).toEqual(["beta", "alpha"]);
    expect(costs.rangeTotal).toBe(30);
    expect(costs.today).toBe(2);
    expect(costs.last7).toBe(27); // today + 3 and 5 days ago; the 10-days-ago row is out
    expect(costs.dailyAvg).toBeCloseTo(1);
  });

  it("sums this month and projects it to the month's end", () => {
    expect(costs.month).toBe(30); // all fixture rows but the 40-days-ago one are in October
    expect(costs.monthProjection).toBeCloseTo((30 / 21) * 31);
  });

  it("names the top model from the breakdowns", () => {
    const alpha = costs.projects.find((p) => p.name === "alpha")!;
    expect(alpha.topModel).toBe("Fable 5");
    expect(costs.models).toEqual(["Fable 5"]);
  });

  it("drops projects that never cost anything", () => {
    const c = computeCosts(report({ "-Users-x-dev-idle": [row(2, 0)], "-Users-x-dev-alpha": [row(0, 1)] }), [], 30, NOW)!;
    expect(c.projects.map((p) => p.name)).toEqual(["alpha"]);
  });
});

describe("computeCosts over all time", () => {
  it("reaches back to the first recorded day", () => {
    const costs = computeCosts(FIXTURE, [], 0, NOW)!;
    expect(costs.allTime).toBe(true);
    expect(costs.rangeDays).toBe(41); // the beta row 40 days ago, plus today
    expect(costs.days[0].date).toBe(day(40));
    const beta = costs.projects.find((p) => p.name === "beta")!;
    expect(beta.inRange).toBe(beta.total);
    expect(costs.rangeTotal).toBe(80);
  });

  it("never shrinks under 30 days", () => {
    const costs = computeCosts(report({ "-Users-x-dev-alpha": [row(2, 1)] }), [], 0, NOW)!;
    expect(costs.rangeDays).toBe(30);
  });
});

describe("project naming", () => {
  it("escapes paths the way ccusage does", () => {
    expect(escapePath("/Users/x/dev/alpha")).toBe("-Users-x-dev-alpha");
  });

  it("prefers a known session's project name, else the path's tail", () => {
    const known = new Map([["-Users-x-dev-alpha", "Alpha App"]]);
    expect(friendlyProject("-Users-x-dev-alpha", known)).toBe("Alpha App");
    expect(friendlyProject("-Users-x-dev-beta", known)).toBe("beta");
  });
});

describe("bucketDays", () => {
  const days: DayCost[] = Array.from({ length: 10 }, (_, i) => ({
    date: day(9 - i),
    total: i + 1,
    byProject: { p: i + 1 },
    byModel: { m: i + 1 },
  }));

  it("keeps daily bars for size 1", () => {
    expect(bucketDays(days, 1)).toBe(days);
  });

  it("merges whole buckets aligned to the last day, leaving the remainder first", () => {
    const out = bucketDays(days, 7);
    expect(out).toHaveLength(2);
    expect(out[0].total).toBe(1 + 2 + 3); // the leftover days land in the first, shorter bar
    expect(out[1].total).toBe(4 + 5 + 6 + 7 + 8 + 9 + 10);
    expect(out[1].date).toBe(day(6)); // each bar is labeled by its first day
    expect(out[1].byProject.p).toBe(49);
    expect(out[1].byModel.m).toBe(49);
  });
});

describe("money", () => {
  it("keeps cents under $100 and rounds above", () => {
    expect(money(3.456)).toBe("$3.46");
    expect(money(1234.5)).toBe("$1,235");
    expect(money(1234.5, true)).toBe("$1234.50");
  });
});
