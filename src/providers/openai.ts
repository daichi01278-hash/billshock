import { dateKey } from "../dates.js";
import type { DailySpend, FetchFn, FetchWindow } from "../types.js";
import { ProviderError, parseJson, request, toNumber } from "./http.js";

const NAME = "openai";
const MAX_PAGES = 10;

interface CostsPage {
  data?: Array<{
    start_time?: number;
    results?: Array<{ amount?: { value?: unknown; currency?: string } }>;
    result?: Array<{ amount?: { value?: unknown; currency?: string } }>;
  }>;
  has_more?: boolean;
  next_page?: string | null;
}

/** Adds one page of GET /v1/organization/costs into `into`. Amounts are in USD. */
export function parseOpenAICosts(page: unknown, into: DailySpend): CostsPage {
  const p = page as CostsPage;
  if (!p || !Array.isArray(p.data)) throw new ProviderError(NAME, "unexpected response shape (no data array)");
  for (const bucket of p.data) {
    if (typeof bucket.start_time !== "number") continue;
    const key = dateKey(new Date(bucket.start_time * 1000));
    const results = bucket.results ?? bucket.result ?? [];
    let sum = 0;
    for (const r of results) sum += toNumber(r.amount?.value);
    into.set(key, (into.get(key) ?? 0) + sum);
  }
  return p;
}

export async function fetchOpenAI(apiKey: string, window: FetchWindow, fetchFn: FetchFn = fetch): Promise<DailySpend> {
  const daily: DailySpend = new Map();
  const base = new URL("https://api.openai.com/v1/organization/costs");
  base.searchParams.set("start_time", String(Math.floor(window.start.getTime() / 1000)));
  base.searchParams.set("end_time", String(Math.floor(window.end.getTime() / 1000)));
  base.searchParams.set("bucket_width", "1d");
  base.searchParams.set("limit", "180");

  let cursor: string | null | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(base);
    if (cursor) url.searchParams.set("page", cursor);
    const body = await request(NAME, fetchFn, url.toString(), { Authorization: `Bearer ${apiKey}` });
    const page = parseOpenAICosts(parseJson(NAME, body), daily);
    if (!page.has_more || !page.next_page) break;
    cursor = page.next_page;
  }
  return daily;
}
