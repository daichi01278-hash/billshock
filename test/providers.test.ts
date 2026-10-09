import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchAnthropic, parseAnthropicCostReport } from "../src/providers/anthropic.js";
import { fetchCursor, parseCursorUsageEvents } from "../src/providers/cursor.js";
import { fetchOpenAI, parseOpenAICosts } from "../src/providers/openai.js";
import { fetchVercel, parseVercelCharges } from "../src/providers/vercel.js";
import type { DailySpend, FetchFn } from "../src/types.js";

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const window = { start: new Date("2025-10-01T00:00:00Z"), end: new Date("2025-10-09T00:00:00Z") };

function fakeFetch(responses: Array<{ status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; method?: string; body?: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string>, method: init?.method, body: init?.body as string | undefined });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(r.body, { status: r.status ?? 200 });
  }) as unknown as FetchFn;
  return { fn, calls };
}

describe("openai", () => {
  it("sums cost results per daily bucket in USD", () => {
    const daily: DailySpend = new Map();
    parseOpenAICosts(json("openai_costs.json"), daily);
    expect(daily.get("2025-10-06")).toBeCloseTo(1.75);
    expect(daily.get("2025-10-07")).toBeCloseTo(42.1);
    expect(daily.get("2025-10-08")).toBe(0);
  });

  it("rejects unexpected shapes", () => {
    expect(() => parseOpenAICosts({ error: "x" }, new Map())).toThrow(/unexpected response shape/);
  });

  it("calls the costs endpoint with an admin bearer key", async () => {
    const { fn, calls } = fakeFetch([{ body: fixture("openai_costs.json") }]);
    const daily = await fetchOpenAI("sk-admin-test", window, fn);
    expect(daily.size).toBe(3);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/organization/costs");
    expect(url.searchParams.get("start_time")).toBe("1759276800");
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-admin-test");
  });

  it("explains 401s", async () => {
    const { fn } = fakeFetch([{ status: 401, body: '{"error":"invalid key"}' }]);
    await expect(fetchOpenAI("bad", window, fn)).rejects.toThrow(/openai: HTTP 401 \(check the key; an \*admin\* key/);
  });
});

describe("anthropic", () => {
  it("converts cent-denominated decimal strings to USD", () => {
    const daily: DailySpend = new Map();
    parseAnthropicCostReport(json("anthropic_cost_report_p1.json"), daily);
    expect(daily.get("2025-10-06")).toBeCloseTo(1.2378912);
  });

  it("follows pagination and sends admin headers", async () => {
    const { fn, calls } = fakeFetch([
      { body: fixture("anthropic_cost_report_p1.json") },
      { body: fixture("anthropic_cost_report_p2.json") },
    ]);
    const daily = await fetchAnthropic("sk-ant-admin-test", window, fn);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("page_MjAyNS0xMC0wN1QwMDowMDowMFo=");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-admin-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(daily.get("2025-10-07")).toBeCloseTo(52.505);
    expect(daily.get("2025-10-08")).toBe(0);
  });
});

describe("vercel", () => {
  it("sums only Usage charges per day, accepting string or number costs", () => {
    const daily = parseVercelCharges(fixture("vercel_charges.jsonl"));
    expect(daily.get("2025-10-06")).toBeCloseTo(0.42);
    expect(daily.get("2025-10-07")).toBeCloseTo(659.08);
    expect(daily.has("2025-10-01")).toBe(false); // Purchase excluded
  });

  it("reports the line of malformed JSONL", () => {
    expect(() => parseVercelCharges('{"ChargeCategory":"Usage"}\nnot json')).toThrow(/line 2/);
  });

  it("passes the date range and team id", async () => {
    const { fn, calls } = fakeFetch([{ body: fixture("vercel_charges.jsonl") }]);
    await fetchVercel("vc_token", "team_123", window, fn);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/billing/charges");
    expect(url.searchParams.get("from")).toBe("2025-10-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2025-10-09T00:00:00.000Z");
    expect(url.searchParams.get("teamId")).toBe("team_123");
  });

  it("never sends a `to` in the future", async () => {
    const { fn, calls } = fakeFetch([{ body: "" }]);
    const now = new Date("2025-10-08T09:30:00.000Z"); // before window.end (Oct 9 00:00)
    await fetchVercel("vc_token", undefined, window, fn, now);
    expect(new URL(calls[0]!.url).searchParams.get("to")).toBe("2025-10-08T09:30:00.000Z");
  });
});

describe("cursor", () => {
  it("sums chargeable events per UTC day in USD and skips included usage", () => {
    const daily: DailySpend = new Map();
    parseCursorUsageEvents(json("cursor_usage_events_p1.json"), daily);
    parseCursorUsageEvents(json("cursor_usage_events_p2.json"), daily);
    // 2025-10-07: 21.36232 + 100 cents.
    expect(daily.get("2025-10-07")).toBeCloseTo(1.2136232);
    // The only 2025-10-06 event is "Included in Business" (isChargeable: false).
    expect(daily.has("2025-10-06")).toBe(false);
    // 1759881600000 is exactly 2025-10-08T00:00:00Z.
    expect(daily.get("2025-10-08")).toBeCloseTo(0.3733);
  });

  it("rejects unexpected shapes", () => {
    expect(() => parseCursorUsageEvents({ error: "x" }, new Map())).toThrow(/unexpected response shape/);
  });

  it("POSTs inclusive epoch-ms bounds with Basic auth and follows pages", async () => {
    const { fn, calls } = fakeFetch([
      { body: fixture("cursor_usage_events_p1.json") },
      { body: fixture("cursor_usage_events_p2.json") },
    ]);
    const now = new Date("2025-10-08T09:30:00.000Z");
    const daily = await fetchCursor("key_test", window, fn, now);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.cursor.com/teams/filtered-usage-events");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("key_test:").toString("base64")}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ startDate: 1759276800000, endDate: now.getTime() - 1, page: 1, pageSize: 1000 });
    expect(JSON.parse(calls[1]!.body!).page).toBe(2);
    expect(daily.get("2025-10-08")).toBeCloseTo(0.3733);
  });

  it("splits windows longer than 30 days", async () => {
    const empty = JSON.stringify({ usageEvents: [], pagination: { hasNextPage: false } });
    const { fn, calls } = fakeFetch([{ body: empty }, { body: empty }]);
    const long = { start: new Date("2025-09-01T00:00:00Z"), end: new Date("2025-10-09T00:00:00Z") };
    await fetchCursor("k", long, fn, new Date("2025-10-10T00:00:00Z"));
    const bodies = calls.map((c) => JSON.parse(c.body!));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].endDate - bodies[0].startDate).toBe(30 * 86_400_000 - 1);
    expect(bodies[1].startDate).toBe(bodies[0].endDate + 1);
    expect(bodies[1].endDate).toBe(long.end.getTime() - 1);
  });

  it("explains 401s", async () => {
    const { fn } = fakeFetch([{ status: 401, body: '{"error":"unauthorized"}' }]);
    await expect(fetchCursor("bad", window, fn, new Date("2025-10-08T00:00:00Z"))).rejects.toThrow(/cursor: HTTP 401/);
  });
});
