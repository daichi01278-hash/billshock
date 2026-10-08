# billshock

**Get alerted before a surprise OpenAI, Anthropic, or Vercel bill.**

billshock checks your provider billing APIs every hour from your own GitHub Actions. When spend spikes, crosses a daily cap, or is on pace to blow your monthly budget, it posts to Discord or Slack.

- **Zero-trust:** your admin keys stay in your repo's secrets. No third-party service ever sees them.
- **Free:** runs on the GitHub Actions free tier. One config file, no server.
- **Anomaly detection, not just caps:** "yesterday was 8× your 7-day average" catches a runaway loop or a misconfigured build days before a monthly threshold would.
- **Cross-provider:** one place for per-provider rules plus a combined budget.

```
scope      today  yesterday  7d avg  month-to-date  projected
openai     $3.10     $41.20   $4.95         $79.80    $261.90
anthropic  $0.80      $6.10   $5.70         $41.00    $134.40
vercel     $0.00    $659.08   $0.42        $661.60   $2171.60
total      $3.90    $706.38  $11.07        $782.40   $2567.90
ALERT openai: $41.20 spent on 2025-10-07, 8.3x the 7-day average of $4.95
ALERT vercel: $659.08 spent on 2025-10-07, 1569.2x the 7-day average of $0.42
ALERT total: $706.38 spent on 2025-10-07, 63.8x the 7-day average of $11.07
ALERT total: on pace for $2567.90 in 2025-10 ($782.40 so far), over the monthly budget of $500.00
```

## Quick start

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
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## CLI

```
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

Provider cost data can lag by a few hours, so "today" is a lower bound.

v0.1 parsers follow each provider's documented schema. If `billshock check --dry-run` shows numbers that don't match your dashboard, please open an issue with the provider name and the (redacted) response shape.

## License

MIT
