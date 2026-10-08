/** UTC date ("YYYY-MM-DD") -> spend in USD. Missing days count as $0. */
export type DailySpend = Map<string, number>;

export interface Rules {
  /** Alert when a single UTC day exceeds this many USD. */
  dailyCap?: number;
  /** Alert when a day exceeds this multiple of the trailing average. */
  spikeMultiplier?: number;
  /** Ignore spikes below this many USD (avoids $0.10 -> $0.50 noise). */
  spikeMinAmount?: number;
  /** Number of preceding days averaged for the spike baseline. */
  spikeBaselineDays?: number;
  /** Alert when month-to-date spend, or its month-end projection, exceeds this many USD. */
  monthlyBudget?: number;
}

export type RuleName = "dailyCap" | "spike" | "monthlyBudget";

export interface Alert {
  /** Stable id used to avoid re-sending the same alert on every run. */
  key: string;
  scope: string;
  rule: RuleName;
  message: string;
}

export type FetchFn = typeof fetch;

export interface FetchWindow {
  /** Inclusive, 00:00 UTC. */
  start: Date;
  /** Exclusive, 00:00 UTC. */
  end: Date;
}
