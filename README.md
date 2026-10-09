# billshock

**Get alerted before a surprise OpenAI, Anthropic, Vercel, or Cursor bill.**

billshock checks your provider billing APIs every hour from your own GitHub Actions. When spend spikes, crosses a daily cap, or is on pace to blow your monthly budget, it posts to Discord or Slack.

- **Zero-trust:** your admin keys stay in your repo's secrets. No third-party service ever sees them.
- **Free:** runs on the GitHub Actions free tier. One config file, no server.
- **Anomaly detection, not just caps:** "yesterday was 8× your 7-day average" catches a runaway loop or a misconfigured build days before a monthly threshold would.
- **Cross-provider:** one place for per-provider rules plus a combined budget.

```
scope      today  yesterday  7d avg  month-to-date  projected
openai     $1.78     $41.20   $4.89         $77.24    $282.73
anthropic  $2.01      $5.20   $5.64         $46.72    $171.01
vercel     $0.12    $659.08   $0.42        $662.12   $2423.60
cursor     $0.00      $3.03   $3.08         $24.60     $90.04
total      $3.91    $708.51  $14.04        $810.68   $2967.38
ALERT openai: $41.20 spent on 2026-10-08, 8.4x the 7-day average of $4.89
ALERT vercel: $659.08 spent on 2026-10-08, 1580.0x the 7-day average of $0.42
ALERT total: $708.51 spent on 2026-10-08, 50.5x the 7-day average of $14.04
ALERT total: on pace for $2967.38 in 2026-10 ($810.68 so far), over the monthly budget of $1000.00
```

## Quick start

See what the alerts look like first, using sample data (no keys, no network):

```sh
npx billshock demo
```

Then set it up for your own accounts:

```sh
npx billshock init
```

This creates `billshock.yml` and `.github/workflows/billshock.yml` (an hourly schedule). Then:

1. Add repo secrets for the providers you use (any you skip are ignored):

   | Secret | Where to get it |
   |---|---|
   | `OPENAI_ADMIN_KEY` | [OpenAI admin keys](https://platform.openai.com/settings/organization/admin-keys). A regular API key will **not** work. |
   | `ANTHROPIC_ADMIN_KEY` | [Anthropic admin keys](https://console.anthropic.com/settings/admin-keys) (`sk-ant-admin…`). Requires an organization account. |
   | `VERCEL_TOKEN` | [Vercel tokens](https://vercel.com/account/tokens). The token's user needs a role that can read team billing (Owner, Member, Developer, Billing…). |
   | `CURSOR_ADMIN_KEY` | Cursor team admin API key: [cursor.com/dashboard](https://cursor.com/dashboard) → API Keys. Teams and Enterprise plans only. |
   | `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` | Channel settings → Integrations → Webhooks / [Slack incoming webhooks](https://api.slack.com/messaging/webhooks) |

   Add `VERCEL_TEAM_ID` as a repo **variable** if your project belongs to a team.

2. Commit, then run the workflow once from the Actions tab to confirm it works.

Without a webhook, billshock still fails the workflow run on new alerts, so GitHub's own "run failed" email reaches you.

## Rules

All amounts are USD and days are UTC. Each rule checks **yesterday** (the last complete day) and **today so far**.

| Rule | Default | Fires when |
|---|---|---|
| `spikeMultiplier` | `3` | the day's spend is more than N× the average of the previous `spikeBaselineDays` days |
| `spikeMinAmount` | `5` | (spikes smaller than this are ignored) |
| `spikeBaselineDays` | `7` | |
| `dailyCap` | off | the day's spend exceeds this amount |
| `monthlyBudget` | off | month-to-date spend exceeds it, or (from day 3) the linear month-end projection does |

Set defaults under `rules:`, override per provider under `providers.<name>.rules:`, and set rules for the combined spend under `total:`.

```yaml
providers:
  openai:
    apiKey: ${OPENAI_ADMIN_KEY}
    rules:
      dailyCap: 50
  anthropic:
    apiKey: ${ANTHROPIC_ADMIN_KEY}
  vercel:
    token: ${VERCEL_TOKEN}
    teamId: ${VERCEL_TEAM_ID}
  cursor:
    apiKey: ${CURSOR_ADMIN_KEY}

rules:
  spikeMultiplier: 3
  spikeMinAmount: 5

total:
  monthlyBudget: 500

notify:
  discordWebhook: ${DISCORD_WEBHOOK_URL}
  slackWebhook: ${SLACK_WEBHOOK_URL}
```

Each alert is sent once. Sent alerts are remembered in `.billshock/state.json`, which the workflow persists with `actions/cache`.

## Use as a GitHub Action

Instead of the generated `npx` workflow, you can call the Action directly. It restores and saves the sent-alert state for you:

```yaml
on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

jobs:
  billshock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: daichi01278-hash/billshock@v0
        with:
          config: billshock.yml   # default
        env:
          OPENAI_ADMIN_KEY: ${{ secrets.OPENAI_ADMIN_KEY }}
          ANTHROPIC_ADMIN_KEY: ${{ secrets.ANTHROPIC_ADMIN_KEY }}
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
          VERCEL_TEAM_ID: ${{ vars.VERCEL_TEAM_ID }}
          CURSOR_ADMIN_KEY: ${{ secrets.CURSOR_ADMIN_KEY }}
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## CLI

```
billshock demo
billshock init [--force]
billshock check [--config billshock.yml] [--state .billshock/state.json] [--dry-run] [--json]
```

Exit codes: `0` ok · `1` new alerts · `2` errors (bad config, provider or webhook failure).

Run locally with `OPENAI_ADMIN_KEY=… npx billshock check --dry-run`.

## Data sources

| Provider | Endpoint | Notes |
|---|---|---|
| OpenAI | `GET /v1/organization/costs` | Daily buckets, all projects |
| Anthropic | `GET /v1/organizations/cost_report` | Daily buckets, all workspaces |
| Vercel | `GET /v1/billing/charges` (FOCUS 1.3) | Counts only `Usage` charges. Plan purchases, credits and tax are excluded. |
| Cursor | `POST /teams/filtered-usage-events` (Admin API) | Sums `chargedCents` of chargeable events, i.e. on-demand spend beyond the seats' included usage. Seat fees are not included. Queried in 30-day chunks; very large teams (>100k events per 30 days) get an error rather than a partial total. |

Provider cost data can lag by a few hours, so "today" is a lower bound.

Parsers follow each provider's documented schema. If `billshock check --dry-run` shows numbers that don't match your dashboard, please [report it](https://github.com/daichi01278-hash/billshock/issues/new?template=numbers-mismatch.yml) with the provider name and the (redacted) response shape.

## Hosted version

Don't want to manage admin keys in CI? A hosted billshock (no workflow, spend history, email/SMS, more providers) is in the works. [Join the waitlist](https://billshock-1el.pages.dev/#waitlist).

## License

MIT
