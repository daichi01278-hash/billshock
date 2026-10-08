import { addDays, dateKey, daysInUtcMonth, elapsedMonthDays, startOfUtcMonth } from "./dates.js";
import type { Alert, DailySpend, Rules } from "./types.js";

export const DEFAULT_RULES: Required<Pick<Rules, "spikeMultiplier" | "spikeMinAmount" | "spikeBaselineDays">> = {
  spikeMultiplier: 3,
  spikeMinAmount: 5,
  spikeBaselineDays: 7,
};

/** Projections are too noisy before this many days into the month; only hard overruns alert. */
const MIN_PROJECTION_DAYS = 3;

export const usd = (n: number) => `$${n.toFixed(2)}`;

export function spendOn(daily: DailySpend, key: string): number {
  return daily.get(key) ?? 0;
}

export function trailingAverage(daily: DailySpend, beforeKey: string, days: number): number {
  let sum = 0;
  for (let i = 1; i <= days; i++) sum += spendOn(daily, addDays(beforeKey, -i));
  return sum / days;
}

export function monthToDate(daily: DailySpend, now: Date): number {
  const from = dateKey(startOfUtcMonth(now));
  const to = dateKey(now);
  let sum = 0;
  for (const [k, v] of daily) if (k >= from && k <= to) sum += v;
  return sum;
}

export function projectMonthEnd(daily: DailySpend, now: Date): number {
  const elapsed = Math.max(elapsedMonthDays(now), 1);
  return (monthToDate(daily, now) / elapsed) * daysInUtcMonth(now);
}

/**
 * Evaluate rules for one scope (a provider, or "total").
 * Checks yesterday (the last complete day) and today (partial, provider data may lag).
 */
export function evaluate(scope: string, daily: DailySpend, rules: Rules, now: Date): Alert[] {
  const alerts: Alert[] = [];
  const today = dateKey(now);
  const days = [addDays(today, -1), today];

  if (rules.dailyCap !== undefined) {
    for (const d of days) {
      const spent = spendOn(daily, d);
      if (spent > rules.dailyCap) {
        alerts.push({
          key: `${scope}:dailyCap:${d}`,
          scope,
          rule: "dailyCap",
          message: `${scope}: ${usd(spent)} spent on ${d}${d === today ? " (so far)" : ""}, over the daily cap of ${usd(rules.dailyCap)}`,
        });
      }
    }
  }

  if (rules.spikeMultiplier !== undefined) {
    const baselineDays = rules.spikeBaselineDays ?? DEFAULT_RULES.spikeBaselineDays;
    const minAmount = rules.spikeMinAmount ?? DEFAULT_RULES.spikeMinAmount;
    for (const d of days) {
      const spent = spendOn(daily, d);
      const baseline = trailingAverage(daily, d, baselineDays);
      if (spent >= minAmount && spent > baseline * rules.spikeMultiplier) {
        const ratio = baseline > 0 ? `${(spent / baseline).toFixed(1)}x` : "up from $0";
        alerts.push({
          key: `${scope}:spike:${d}`,
          scope,
          rule: "spike",
          message: `${scope}: ${usd(spent)} spent on ${d}${d === today ? " (so far)" : ""}, ${ratio} the ${baselineDays}-day average of ${usd(baseline)}`,
        });
      }
    }
  }

  if (rules.monthlyBudget !== undefined) {
    const month = today.slice(0, 7);
    const mtd = monthToDate(daily, now);
    if (mtd > rules.monthlyBudget) {
      alerts.push({
        key: `${scope}:monthlyBudget:${month}:exceeded`,
        scope,
        rule: "monthlyBudget",
        message: `${scope}: ${usd(mtd)} spent so far in ${month}, over the monthly budget of ${usd(rules.monthlyBudget)}`,
      });
    } else if (elapsedMonthDays(now) >= MIN_PROJECTION_DAYS) {
      const projected = projectMonthEnd(daily, now);
      if (projected > rules.monthlyBudget) {
        alerts.push({
          key: `${scope}:monthlyBudget:${month}:projected`,
          scope,
          rule: "monthlyBudget",
          message: `${scope}: on pace for ${usd(projected)} in ${month} (${usd(mtd)} so far), over the monthly budget of ${usd(rules.monthlyBudget)}`,
        });
      }
    }
  }

  return alerts;
}

export function sumDaily(all: DailySpend[]): DailySpend {
  const out: DailySpend = new Map();
  for (const daily of all) for (const [k, v] of daily) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}
