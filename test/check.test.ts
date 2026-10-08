import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchWindow, runCheck } from "../src/check.js";
import { ConfigError, parseConfig } from "../src/config.js";
import type { FetchFn } from "../src/types.js";

const NOW = new Date("2025-10-08T09:00:00Z");

const CONFIG = `
providers:
  openai:
    apiKey: \${OPENAI_ADMIN_KEY}
  anthropic:
    apiKey: \${ANTHROPIC_ADMIN_KEY}
    rules:
      dailyCap: 20
  vercel:
    token: \${VERCEL_TOKEN}
rules:
  spikeMultiplier: 3
total:
  monthlyBudget: 1000
notify:
  discordWebhook: \${DISCORD_WEBHOOK_URL}
`;

const ENV = { OPENAI_ADMIN_KEY: "sk-admin", ANTHROPIC_ADMIN_KEY: "sk-ant-admin", DISCORD_WEBHOOK_URL: "https://discord.test/hook" };

function openaiPage(days: Record<string, number>) {
  return JSON.stringify({
    object: "page",
    data: Object.entries(days).map(([d, v]) => ({
      object: "bucket",
      start_time: Date.parse(`${d}T00:00:00Z`) / 1000,
      results: [{ amount: { value: v, currency: "usd" } }],
    })),
    has_more: false,
    next_page: null,
  });
}

function anthropicPage(days: Record<string, number>) {
  return JSON.stringify({
    data: Object.entries(days).map(([d, v]) => ({ starting_at: `${d}T00:00:00Z`, results: [{ amount: String(v * 100), currency: "USD" }] })),
    has_more: false,
    next_page: null,
  });
}

interface Server {
  fetchFn: FetchFn;
  posts: Array<{ url: string; body: unknown }>;
  openai: string;
  anthropic: string | number;
  discordStatus: number;
}

function server(): Server {
  const s: Server = {
    posts: [],
    // Steady $20/day on OpenAI keeps the total's baseline high enough that only Anthropic spikes.
    openai: openaiPage(Object.fromEntries(["09-30", "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07"].map((d) => [`2025-${d}`, 20]))),
    anthropic: anthropicPage({ "2025-10-07": 25 }),
    discordStatus: 204,
    fetchFn: (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://api.openai.com/")) return new Response(s.openai);
      if (url.startsWith("https://api.anthropic.com/")) {
        return typeof s.anthropic === "number" ? new Response("boom", { status: s.anthropic }) : new Response(s.anthropic);
      }
      if (url.startsWith("https://discord.test/")) {
        s.posts.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: s.discordStatus });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as FetchFn,
  };
  return s;
}

describe("parseConfig", () => {
  it("interpolates env vars and merges rule defaults", () => {
    const cfg = parseConfig(CONFIG, ENV);
    const anthropic = cfg.providers.find((p) => p.name === "anthropic")!;
    expect(anthropic.credential).toBe("sk-ant-admin");
    expect(anthropic.rules).toMatchObject({ dailyCap: 20, spikeMultiplier: 3, spikeMinAmount: 5, spikeBaselineDays: 7 });
    expect(cfg.providers.find((p) => p.name === "vercel")!.credential).toBe("");
    expect(cfg.total).toMatchObject({ monthlyBudget: 1000 });
    expect(cfg.notify.discordWebhook).toBe("https://discord.test/hook");
    expect(cfg.notify.slackWebhook).toBeUndefined();
  });

  it("rejects unknown providers, unknown rules and bad numbers", () => {
    expect(() => parseConfig("providers:\n  aws: {}\n", {})).toThrow(ConfigError);
    expect(() => parseConfig("providers:\n  openai: {}\nrules:\n  dailycap: 5\n", {})).toThrow(/not a known rule/);
    expect(() => parseConfig("providers:\n  openai: {}\nrules:\n  dailyCap: lots\n", {})).toThrow(/non-negative number/);
    expect(() => parseConfig("rules: {}\n", {})).toThrow(/no providers/);
  });
});

describe("fetchWindow", () => {
  it("covers the month start and the spike baseline", () => {
    const w = fetchWindow(parseConfig(CONFIG, ENV), NOW);
    expect(w.start.toISOString()).toBe("2025-09-30T00:00:00.000Z"); // 8 days before today
    expect(w.end.toISOString()).toBe("2025-10-09T00:00:00.000Z");
  });
});

describe("runCheck", () => {
  let statePath: string;
  let s: Server;
  const logs: string[] = [];
  const run = (opts: { dryRun?: boolean; env?: Record<string, string> } = {}) =>
    runCheck({ config: parseConfig(CONFIG, opts.env ?? ENV), statePath, now: NOW, fetchFn: s.fetchFn, dryRun: opts.dryRun, log: (l) => logs.push(l) });

  beforeEach(() => {
    statePath = join(mkdtempSync(join(tmpdir(), "billshock-")), "state.json");
    s = server();
    logs.length = 0;
  });

  it("alerts once, notifies Discord, and dedupes on the next run", async () => {
    const first = await run();
    expect(first.exitCode).toBe(1);
    expect(first.newAlerts.map((a) => a.key)).toEqual(["anthropic:dailyCap:2025-10-07", "anthropic:spike:2025-10-07"]);
    expect(s.posts).toHaveLength(1);
    expect((s.posts[0]!.body as { content: string }).content).toMatch(/^🚨 billshock: 2 spend alerts\n• anthropic: \$25\.00 spent on 2025-10-07/);
    expect(logs).toContain("skipping vercel: no token set");
    expect(logs[1]).toMatch(/^scope\s+today/);
    expect(JSON.parse(readFileSync(statePath, "utf8")).sent).toHaveProperty(["anthropic:dailyCap:2025-10-07"]);

    const second = await run();
    expect(second.exitCode).toBe(0);
    expect(second.alerts).toHaveLength(2);
    expect(second.newAlerts).toHaveLength(0);
    expect(s.posts).toHaveLength(1);
  });

  it("does not notify or record state on --dry-run", async () => {
    const result = await run({ dryRun: true });
    expect(result.exitCode).toBe(1);
    expect(s.posts).toHaveLength(0);
    expect(() => readFileSync(statePath)).toThrow();
  });

  it("keeps alerts pending when the webhook fails so they retry", async () => {
    s.discordStatus = 500;
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toMatch(/notify failed: discord webhook returned HTTP 500/);
    expect(() => readFileSync(statePath)).toThrow();
  });

  it("reports a failing provider but still checks the others", async () => {
    s.anthropic = 401;
    s.openai = openaiPage({ "2025-10-01": 1, "2025-10-07": 30 });
    const result = await run();
    expect(result.errors).toEqual([expect.stringMatching(/^anthropic: HTTP 401/)]);
    expect(result.newAlerts.map((a) => a.key)).toEqual(["openai:spike:2025-10-07", "total:spike:2025-10-07"]);
    expect(result.exitCode).toBe(1);
  });

  it("exits 2 on errors without alerts", async () => {
    s.anthropic = 500;
    expect((await run()).exitCode).toBe(2);
  });

  it("exits 2 when no provider has credentials", async () => {
    const result = await run({ env: {} });
    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toMatch(/no provider has credentials/);
  });
});
