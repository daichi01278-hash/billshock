import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./check.js";
import { parseConfig } from "./config.js";
import { addDays, dateKey } from "./dates.js";
import type { FetchFn } from "./types.js";

/**
 * Runs `check` against generated sample data served in each provider's real response format,
 * so the demo exercises the same parsers and rules as a real run. No network, no keys.
 */

const DEMO_CONFIG = `
providers:
  openai: { apiKey: demo }
  anthropic: { apiKey: demo }
  vercel: { token: demo }
  cursor: { apiKey: demo }
total:
  monthlyBudget: 1000
`;

/** Deterministic noise so the demo prints the same story every time. */
function wobble(key: string, provider: string): number {
  let h = 0;
  for (const c of key + provider) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 0.8 + (h % 400) / 1000; // 0.8 .. 1.2
}

/** Normal spend with a runaway day yesterday on OpenAI and Vercel. */
export function demoSpend(provider: "openai" | "anthropic" | "vercel" | "cursor", key: string, today: string): number {
  const yesterday = addDays(today, -1);
  const base = { openai: 4.9, anthropic: 5.7, vercel: 0.42, cursor: 3.1 }[provider];
  if (key === yesterday && provider === "openai") return 41.2;
  if (key === yesterday && provider === "vercel") return 659.08;
  const partial = key === today ? 0.35 : 1; // today is still in progress
  return Math.round(base * wobble(key, provider) * partial * 100) / 100;
}

function days(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

export function demoFetch(now: Date): FetchFn {
  const today = dateKey(now);
  return (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.hostname === "api.openai.com") {
      const start = dateKey(new Date(Number(url.searchParams.get("start_time")) * 1000));
      const end = dateKey(new Date(Number(url.searchParams.get("end_time")) * 1000));
      const data = days(start, end).map((d) => ({
        object: "bucket",
        start_time: Date.parse(`${d}T00:00:00Z`) / 1000,
        end_time: Date.parse(`${addDays(d, 1)}T00:00:00Z`) / 1000,
        results: [{ object: "organization.costs.result", amount: { value: demoSpend("openai", d, today), currency: "usd" } }],
      }));
      return new Response(JSON.stringify({ object: "page", data, has_more: false, next_page: null }));
    }
    if (url.hostname === "api.anthropic.com") {
      const start = url.searchParams.get("starting_at")!.slice(0, 10);
      const end = url.searchParams.get("ending_at")!.slice(0, 10);
      const data = days(start, end).map((d) => ({
        starting_at: `${d}T00:00:00Z`,
        ending_at: `${addDays(d, 1)}T00:00:00Z`,
        results: [{ amount: String(Math.round(demoSpend("anthropic", d, today) * 100)), currency: "USD" }],
      }));
      return new Response(JSON.stringify({ data, has_more: false, next_page: null }));
    }
    if (url.hostname === "api.vercel.com") {
      const start = url.searchParams.get("from")!.slice(0, 10);
      const end = addDays(url.searchParams.get("to")!.slice(0, 10), 1);
      const lines = days(start, end).map((d) =>
        JSON.stringify({
          BilledCost: demoSpend("vercel", d, today),
          BillingCurrency: "USD",
          ChargeCategory: "Usage",
          ChargePeriodStart: `${d}T00:00:00.000Z`,
          ChargePeriodEnd: `${addDays(d, 1)}T00:00:00.000Z`,
          ServiceName: "Build Minutes",
        }),
      );
      return new Response(lines.join("\n"));
    }
    if (url.hostname === "api.cursor.com") {
      const { startDate, endDate } = JSON.parse(String(init?.body)) as { startDate: number; endDate: number };
      // One chargeable event per day at 12:00 UTC, inside the requested inclusive range.
      const usageEvents = days(dateKey(new Date(startDate)), addDays(dateKey(new Date(endDate)), 1))
        .map((d) => ({ timestamp: String(Date.parse(`${d}T12:00:00Z`)), isChargeable: true, chargedCents: Math.round(demoSpend("cursor", d, today) * 100) }))
        .filter((e) => Number(e.timestamp) >= startDate && Number(e.timestamp) <= endDate);
      return new Response(JSON.stringify({ usageEvents, pagination: { hasNextPage: false } }));
    }
    throw new Error(`demo: unexpected request to ${url.hostname}`);
  }) as unknown as FetchFn;
}

export async function runDemo(log: (line: string) => void = console.log, now: Date = new Date()): Promise<number> {
  log("billshock demo: sample data, no API keys, nothing is sent.\n");
  await runCheck({
    config: parseConfig(DEMO_CONFIG, {}),
    statePath: join(mkdtempSync(join(tmpdir(), "billshock-demo-")), "state.json"),
    dryRun: true,
    now,
    fetchFn: demoFetch(now),
    log,
  });
  log("\nOn a real run, new alerts go to Slack/Discord once and the run exits 1.");
  log("Set it up for your own accounts: npx billshock init");
  return 0;
}
