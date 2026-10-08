import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchAnthropic, parseAnthropicCostReport } from "../src/providers/anthropic.js";
import { fetchOpenAI, parseOpenAICosts } from "../src/providers/openai.js";
import { fetchVercel, parseVercelCharges } from "../src/providers/vercel.js";
import type { DailySpend, FetchFn } from "../src/types.js";

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const window = { start: new Date("2025-10-01T00:00:00Z"), end: new Date("2025-10-09T00:00:00Z") };

function fakeFetch(responses: Array<{ status?: number; body: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
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
