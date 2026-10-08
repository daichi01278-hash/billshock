import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates.js";
import { evaluate, projectMonthEnd, sumDaily } from "../src/rules.js";
import type { DailySpend } from "../src/types.js";

const NOW = new Date("2025-10-15T12:00:00Z");
const TODAY = "2025-10-15";

/** `values[0]` is today, `values[1]` yesterday, and so on. */
function history(values: number[]): DailySpend {
  return new Map(values.map((v, i) => [addDays(TODAY, -i), v]));
}

const rulesOf = (alerts: { rule: string; key: string }[]) => alerts.map((a) => a.key);

describe("dailyCap", () => {
  it("flags yesterday and today separately", () => {
    const alerts = evaluate("openai", history([60, 55, 10]), { dailyCap: 50 }, NOW);
    expect(rulesOf(alerts)).toEqual(["openai:dailyCap:2025-10-14", "openai:dailyCap:2025-10-15"]);
    expect(alerts[1]!.message).toContain("(so far)");
  });

  it("does not flag spend equal to the cap", () => {
    expect(evaluate("openai", history([50, 50]), { dailyCap: 50 }, NOW)).toEqual([]);
  });
});

describe("spike", () => {
  const rules = { spikeMultiplier: 3, spikeMinAmount: 5, spikeBaselineDays: 7 };

  it("flags a day above multiplier x trailing average", () => {
    // yesterday $40 vs 7 prior days of $10.
    const alerts = evaluate("anthropic", history([0, 40, 10, 10, 10, 10, 10, 10, 10]), rules, NOW);
    expect(rulesOf(alerts)).toEqual(["anthropic:spike:2025-10-14"]);
    expect(alerts[0]!.message).toContain("4.0x the 7-day average of $10.00");
  });

  it("ignores normal variation", () => {
    expect(evaluate("anthropic", history([12, 25, 10, 10, 10, 10, 10, 10, 10]), rules, NOW)).toEqual([]);
  });

  it("ignores tiny absolute spikes below spikeMinAmount", () => {
    expect(evaluate("anthropic", history([0, 4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]), rules, NOW)).toEqual([]);
  });

  it("flags new spend from a $0 baseline", () => {
    const alerts = evaluate("vercel", history([0, 659]), rules, NOW);
    expect(alerts[0]!.message).toContain("up from $0");
  });

  it("flags today's partial spend already above the multiplier", () => {
    const alerts = evaluate("openai", history([100, 10, 10, 10, 10, 10, 10, 10, 10]), rules, NOW);
    expect(rulesOf(alerts)).toEqual(["openai:spike:2025-10-15"]);
  });
});

describe("monthlyBudget", () => {
  it("flags month-to-date spend over budget", () => {
    const alerts = evaluate("total", history(Array(15).fill(40)), { monthlyBudget: 500 }, NOW);
    expect(rulesOf(alerts)).toEqual(["total:monthlyBudget:2025-10:exceeded"]);
  });

  it("flags a projected overrun", () => {
    // $20/day over 14.5 days = $300 MTD -> ~$641 projected for 31 days.
    const daily = history(Array(15).fill(20));
    expect(projectMonthEnd(daily, NOW)).toBeCloseTo((300 / 14.5) * 31);
    const alerts = evaluate("total", daily, { monthlyBudget: 500 }, NOW);
    expect(rulesOf(alerts)).toEqual(["total:monthlyBudget:2025-10:projected"]);
  });

  it("ignores spend from the previous month", () => {
    const daily = history(Array(30).fill(20)); // 15 days in Sep, 15 in Oct
    const alerts = evaluate("total", daily, { monthlyBudget: 1000 }, NOW);
    expect(alerts).toEqual([]);
  });

  it("does not project in the first days of the month", () => {
    const early = new Date("2025-10-02T06:00:00Z");
    const daily: DailySpend = new Map([["2025-10-01", 30], ["2025-10-02", 5]]);
    expect(evaluate("total", daily, { monthlyBudget: 500 }, early)).toEqual([]);
  });
});

describe("sumDaily", () => {
  it("adds providers per day", () => {
    const total = sumDaily([new Map([["a", 1], ["b", 2]]), new Map([["b", 3]])]);
    expect(Object.fromEntries(total)).toEqual({ a: 1, b: 5 });
  });
});
