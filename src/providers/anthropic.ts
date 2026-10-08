import type { DailySpend, FetchFn, FetchWindow } from "../types.js";
import { ProviderError, parseJson, request, toNumber } from "./http.js";

const NAME = "anthropic";
const MAX_PAGES = 10;

interface CostReportPage {
  data?: Array<{ starting_at?: string; results?: Array<{ amount?: unknown }> }>;
  has_more?: boolean;
  next_page?: string | null;
}

/**
 * Adds one page of GET /v1/organizations/cost_report into `into`.
 * `amount` is a decimal string in cents ("123.45" = $1.23), converted here to USD.
 */
export function parseAnthropicCostReport(page: unknown, into: DailySpend): CostReportPage {
  const p = page as CostReportPage;
  if (!p || !Array.isArray(p.data)) throw new ProviderError(NAME, "unexpected response shape (no data array)");
  for (const bucket of p.data) {
    if (typeof bucket.starting_at !== "string") continue;
    const key = bucket.starting_at.slice(0, 10);
    let cents = 0;
    for (const r of bucket.results ?? []) cents += toNumber(r.amount);
    into.set(key, (into.get(key) ?? 0) + cents / 100);
  }
  return p;
}

export async function fetchAnthropic(apiKey: string, window: FetchWindow, fetchFn: FetchFn = fetch): Promise<DailySpend> {
  const daily: DailySpend = new Map();
  const base = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  base.searchParams.set("starting_at", window.start.toISOString());
  base.searchParams.set("ending_at", window.end.toISOString());
  base.searchParams.set("bucket_width", "1d");
  base.searchParams.set("limit", "31");

  let cursor: string | null | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(base);
    if (cursor) url.searchParams.set("page", cursor);
    const body = await request(NAME, fetchFn, url.toString(), {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    });
    const page = parseAnthropicCostReport(parseJson(NAME, body), daily);
    if (!page.has_more || !page.next_page) break;
    cursor = page.next_page;
  }
  return daily;
}
