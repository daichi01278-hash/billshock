import type { DailySpend, FetchFn, FetchWindow } from "../types.js";
import { ProviderError, request, toNumber } from "./http.js";

const NAME = "vercel";

/**
 * Parses GET /v1/billing/charges (FOCUS v1.3, newline-delimited JSON) into daily USD.
 * Only `Usage` charges count: plan purchases, credits and tax would otherwise look like spikes.
 */
export function parseVercelCharges(jsonl: string, into: DailySpend = new Map()): DailySpend {
  const lines = jsonl.split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    let row: { ChargeCategory?: string; ChargePeriodStart?: string; BilledCost?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      throw new ProviderError(NAME, `invalid JSONL on line ${i + 1}: ${line.slice(0, 120)}`);
    }
    if (row.ChargeCategory !== "Usage" || typeof row.ChargePeriodStart !== "string") continue;
    const key = row.ChargePeriodStart.slice(0, 10);
    into.set(key, (into.get(key) ?? 0) + toNumber(row.BilledCost));
  }
  return into;
}

export async function fetchVercel(
  token: string,
  teamId: string | undefined,
  window: FetchWindow,
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
): Promise<DailySpend> {
  // Vercel's own CLI and other production clients send `to` = now; a future `to` risks a 400.
  const to = window.end < now ? window.end : now;
  const url = new URL("https://api.vercel.com/v1/billing/charges");
  url.searchParams.set("from", window.start.toISOString());
  url.searchParams.set("to", to.toISOString());
  if (teamId) url.searchParams.set("teamId", teamId);
  const body = await request(NAME, fetchFn, url.toString(), { Authorization: `Bearer ${token}` });
  return parseVercelCharges(body);
}
