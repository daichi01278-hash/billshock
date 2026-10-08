import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SAMPLE_CONFIG = `# billshock: spend anomaly alerts. Docs: https://github.com/daichi01278-hash/billshock
# Secrets are read from env vars via \${VAR}. Providers whose key is unset are skipped.

providers:
  openai:
    apiKey: \${OPENAI_ADMIN_KEY}        # Admin key: platform.openai.com/settings/organization/admin-keys
  anthropic:
    apiKey: \${ANTHROPIC_ADMIN_KEY}     # Admin key (sk-ant-admin...): console.anthropic.com/settings/admin-keys
  vercel:
    token: \${VERCEL_TOKEN}             # vercel.com/account/tokens (needs access to the team's billing)
    teamId: \${VERCEL_TEAM_ID}
    # rules:                           # per-provider overrides
    #   dailyCap: 20

# Default rules for every provider (USD).
rules:
  spikeMultiplier: 3      # alert when a day is 3x the trailing average...
  spikeMinAmount: 5       # ...and at least $5
  spikeBaselineDays: 7
  # dailyCap: 50
  # monthlyBudget: 300

# Rules for combined spend across all providers. Remove to disable.
total:
  monthlyBudget: 500

notify:
  discordWebhook: \${DISCORD_WEBHOOK_URL}
  slackWebhook: \${SLACK_WEBHOOK_URL}
`;

export const SAMPLE_WORKFLOW = `name: billshock

on:
  schedule:
    - cron: "17 * * * *" # hourly
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4

      # Remembers which alerts were already sent so you get each one once.
      - uses: actions/cache/restore@v4
        with:
          path: .billshock
          key: billshock-state-\${{ github.run_id }}
          restore-keys: billshock-state-

      - run: npx --yes billshock@0 check
        env:
          OPENAI_ADMIN_KEY: \${{ secrets.OPENAI_ADMIN_KEY }}
          ANTHROPIC_ADMIN_KEY: \${{ secrets.ANTHROPIC_ADMIN_KEY }}
          VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
          VERCEL_TEAM_ID: \${{ vars.VERCEL_TEAM_ID }}
          DISCORD_WEBHOOK_URL: \${{ secrets.DISCORD_WEBHOOK_URL }}
          SLACK_WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}

      - uses: actions/cache/save@v4
        if: always()
        with:
          path: .billshock
          key: billshock-state-\${{ github.run_id }}
`;

export function runInit(cwd: string, force = false, log: (line: string) => void = console.log): number {
  const files: Array<[string, string]> = [
    ["billshock.yml", SAMPLE_CONFIG],
    [join(".github", "workflows", "billshock.yml"), SAMPLE_WORKFLOW],
  ];
  for (const [rel, content] of files) {
    const path = join(cwd, rel);
    if (existsSync(path) && !force) {
      log(`exists, skipped: ${rel} (use --force to overwrite)`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    log(`created: ${rel}`);
  }
  log("");
  log("Next: add OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / VERCEL_TOKEN and a webhook URL as repo secrets,");
  log("then run the workflow once from the Actions tab (or `billshock check --dry-run` locally).");
  return 0;
}
