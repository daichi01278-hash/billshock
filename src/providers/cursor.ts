import type { DailySpend, FetchFn, FetchWindow } from "../types.js";
import { ProviderError, parseJson, request, toNumber } from "./http.js";

const NAME = "cursor";
const URL_EVENTS = "https://api.cursor.com/teams/filtered-usage-events";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
/** The Admin API caps a single query at 30 days. */
const CHUNK_MS = 30 * 86_400_000;

interface UsageEventsPage {
  usageEvents?: Array<{ timestamp?: unknown; chargedCents?: unknown; isChargeable?: unknown }>;
  pagination?: { hasNextPage?: boolean };
}

/**
 * Adds one page of POST /teams/filtered-usage-events into `into`.
 * Only chargeable events count (spend beyond the seats' included usage).
 * `chargedCents` is in cents and `timestamp` is epoch milliseconds as a string.
 */
export function parseCursorUsageEvents(page: unknown, into: DailySpend): UsageEventsPage {
  const p = page as UsageEventsPage;
  if (!p || !Array.isArray(p.usageEvents)) throw new ProviderError(NAME, "unexpected response shape (no usageEvents array)");
  for (const e of p.usageEvents) {
    if (e.isChargeable === false) continue;
    const ms = toNumber(e.timestamp);
    if (!ms) continue;
    const key = new Date(ms).toISOString().slice(0, 10);
    into.set(key, (into.get(key) ?? 0) + toNumber(e.chargedCents) / 100);
  }
  return p;
}

export async function fetchCursor(apiKey: string, window: FetchWindow, fetchFn: FetchFn = fetch, now = new Date()): Promise<DailySpend> {
  const daily: DailySpend = new Map();
  const headers = {
    Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  // Both bounds are inclusive, so each chunk ends 1 ms before the next starts.
  const last = Math.min(window.end.getTime(), now.getTime()) - 1;
  for (let start = window.start.getTime(); start <= last; start += CHUNK_MS) {
    const end = Math.min(start + CHUNK_MS - 1, last);
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new ProviderError(NAME, `more than ${MAX_PAGES * PAGE_SIZE} usage events in 30 days; totals would be incomplete`);
      const body = await request(NAME, fetchFn, URL_EVENTS, headers, {
        method: "POST",
        body: JSON.stringify({ startDate: start, endDate: end, page, pageSize: PAGE_SIZE }),
      });
      const p = parseCursorUsageEvents(parseJson(NAME, body), daily);
      if (!p.pagination?.hasNextPage) break;
    }
  }
  return daily;
}
