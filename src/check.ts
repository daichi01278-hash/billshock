import { appendFileSync } from "node:fs";
import type { Config, ProviderConfig } from "./config.js";
import { addDays, dateKey, startOfUtcMonth } from "./dates.js";
import { notify } from "./notify.js";
import { fetchAnthropic } from "./providers/anthropic.js";
import { fetchCursor } from "./providers/cursor.js";
import { fetchOpenAI } from "./providers/openai.js";
import { fetchVercel } from "./providers/vercel.js";
import { DEFAULT_RULES, evaluate, monthToDate, projectMonthEnd, spendOn, sumDaily, trailingAverage, usd } from "./rules.js";
import { loadState, saveState } from "./state.js";
import type { Alert, DailySpend, FetchFn, FetchWindow, Rules } from "./types.js";

export interface CheckOptions {
  config: Config;
  statePath: string;
  dryRun?: boolean;
  now?: Date;
  fetchFn?: FetchFn;
  log?: (line: string) => void;
}

export interface SummaryRow {
  scope: string;
  today: number;
  yesterday: number;
  baseline: number;
  monthToDate: number;
  projected: number;
}

export interface CheckResult {
  /** 0 = ok, 1 = new alerts, 2 = errors (fetch, notify) without new alerts. */
  exitCode: number;
  alerts: Alert[];
  newAlerts: Alert[];
  errors: string[];
  summary: SummaryRow[];
}

export function fetchWindow(config: Config, now: Date): FetchWindow {
  const allRules: Rules[] = [...config.providers.map((p) => p.rules), ...(config.total ? [config.total] : [])];
  const baselineDays = Math.max(...allRules.map((r) => r.spikeBaselineDays ?? DEFAULT_RULES.spikeBaselineDays));
  const today = dateKey(now);
  // Yesterday's baseline reaches back baselineDays before yesterday.
  const baselineStart = new Date(`${addDays(today, -(baselineDays + 1))}T00:00:00Z`);
  const monthStart = startOfUtcMonth(now);
  return {
    start: baselineStart < monthStart ? baselineStart : monthStart,
    end: new Date(`${addDays(today, 1)}T00:00:00Z`),
  };
}

function fetchProvider(p: ProviderConfig, window: FetchWindow, fetchFn: FetchFn, now: Date): Promise<DailySpend> {
  switch (p.name) {
    case "openai":
      return fetchOpenAI(p.credential, window, fetchFn);
    case "anthropic":
      return fetchAnthropic(p.credential, window, fetchFn);
    case "vercel":
      return fetchVercel(p.credential, p.teamId, window, fetchFn, now);
    case "cursor":
      return fetchCursor(p.credential, window, fetchFn, now);
  }
}

function summarize(scope: string, daily: DailySpend, rules: Rules, now: Date): SummaryRow {
  const today = dateKey(now);
  const yesterday = addDays(today, -1);
  return {
    scope,
    today: spendOn(daily, today),
    yesterday: spendOn(daily, yesterday),
    baseline: trailingAverage(daily, yesterday, rules.spikeBaselineDays ?? DEFAULT_RULES.spikeBaselineDays),
    monthToDate: monthToDate(daily, now),
    projected: projectMonthEnd(daily, now),
  };
}

export function formatSummary(rows: SummaryRow[]): string {
  const header = ["scope", "today", "yesterday", "7d avg", "month-to-date", "projected"];
  const body = rows.map((r) => [r.scope, usd(r.today), usd(r.yesterday), usd(r.baseline), usd(r.monthToDate), usd(r.projected)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [fmt(header), ...body.map(fmt)].join("\n");
}

function writeStepSummary(result: CheckResult): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  const lines = ["## billshock", "", "| scope | today | yesterday | 7d avg | month-to-date | projected |", "|---|--:|--:|--:|--:|--:|"];
  for (const r of result.summary) lines.push(`| ${r.scope} | ${usd(r.today)} | ${usd(r.yesterday)} | ${usd(r.baseline)} | ${usd(r.monthToDate)} | ${usd(r.projected)} |`);
  if (result.alerts.length) lines.push("", "### Alerts", ...result.alerts.map((a) => `- ${a.message}`));
  if (result.errors.length) lines.push("", "### Errors", ...result.errors.map((e) => `- ${e}`));
  try {
    appendFileSync(path, `${lines.join("\n")}\n`);
  } catch {
    // The step summary is a convenience; never fail the check over it.
  }
}

export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const { config, statePath } = opts;
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((line: string) => console.log(line));
  const errors: string[] = [];

  const active = config.providers.filter((p) => {
    if (p.credential) return true;
    log(`skipping ${p.name}: no ${p.name === "vercel" ? "token" : "apiKey"} set`);
    return false;
  });
  if (active.length === 0) {
    errors.push("no provider has credentials; set the env vars referenced in your config");
  }

  const window = fetchWindow(config, now);
  const settled = await Promise.allSettled(active.map((p) => fetchProvider(p, window, fetchFn, now)));

  const alerts: Alert[] = [];
  const summary: SummaryRow[] = [];
  const fetched: DailySpend[] = [];
  settled.forEach((s, i) => {
    const p = active[i]!;
    if (s.status === "rejected") {
      errors.push((s.reason as Error).message);
      return;
    }
    fetched.push(s.value);
    alerts.push(...evaluate(p.name, s.value, p.rules, now));
    summary.push(summarize(p.name, s.value, p.rules, now));
  });

  if (config.total && fetched.length > 0) {
    const total = sumDaily(fetched);
    alerts.push(...evaluate("total", total, config.total, now));
    summary.push(summarize("total", total, config.total, now));
  }

  const state = loadState(statePath);
  const newAlerts = alerts.filter((a) => !state.sent[a.key]);

  if (summary.length) log(formatSummary(summary));
  for (const a of alerts) log(`${state.sent[a.key] ? "  (already sent) " : "ALERT "}${a.message}`);
  for (const e of errors) log(`ERROR ${e}`);

  if (newAlerts.length && !opts.dryRun) {
    const channels = config.notify.discordWebhook || config.notify.slackWebhook;
    let delivered = true;
    if (channels) {
      try {
        const sent = await notify(config.notify, newAlerts, fetchFn);
        log(`notified: ${sent.join(", ")}`);
      } catch (err) {
        delivered = false;
        errors.push(`notify failed: ${(err as Error).message}`);
        log(`ERROR notify failed: ${(err as Error).message}`);
      }
    }
    // Without webhooks the non-zero exit code is the notification (GitHub emails on failed runs).
    if (delivered) {
      const at = now.toISOString();
      for (const a of newAlerts) state.sent[a.key] = at;
      saveState(statePath, state, now);
    }
  }

  const result: CheckResult = {
    exitCode: newAlerts.length ? 1 : errors.length ? 2 : 0,
    alerts,
    newAlerts,
    errors,
    summary,
  };
  writeStepSummary(result);
  return result;
}
