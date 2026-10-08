import type { Config } from "./config.js";
import type { Alert, FetchFn } from "./types.js";

const DISCORD_LIMIT = 2000;
const SLACK_LIMIT = 3900;

export function formatAlerts(alerts: Alert[]): string {
  const title = `🚨 billshock: ${alerts.length} spend alert${alerts.length === 1 ? "" : "s"}`;
  return [title, ...alerts.map((a) => `• ${a.message}`)].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 2)}\n…`;
}

async function post(fetchFn: FetchFn, channel: string, url: string, payload: unknown): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${channel} webhook returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Sends to every configured channel. Throws if any channel fails so the alerts are retried next run. */
export async function notify(notifyCfg: Config["notify"], alerts: Alert[], fetchFn: FetchFn = fetch): Promise<string[]> {
  const text = formatAlerts(alerts);
  const sent: string[] = [];
  const errors: string[] = [];
  const jobs: Array<[string, () => Promise<void>]> = [];
  if (notifyCfg.discordWebhook) {
    const url = notifyCfg.discordWebhook;
    jobs.push(["discord", () => post(fetchFn, "discord", url, { content: truncate(text, DISCORD_LIMIT) })]);
  }
  if (notifyCfg.slackWebhook) {
    const url = notifyCfg.slackWebhook;
    jobs.push(["slack", () => post(fetchFn, "slack", url, { text: truncate(text, SLACK_LIMIT) })]);
  }
  for (const [name, job] of jobs) {
    try {
      await job();
      sent.push(name);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return sent;
}
