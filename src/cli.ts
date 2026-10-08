import { parseArgs } from "node:util";
import { runCheck } from "./check.js";
import { ConfigError, loadConfig } from "./config.js";
import { runInit } from "./init.js";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const HELP = `billshock — get alerted before a surprise OpenAI / Anthropic / Vercel bill

Usage:
  billshock init [--force]       Create billshock.yml and a GitHub Actions workflow
  billshock check [options]      Fetch spend, evaluate rules, send new alerts

Check options:
  -c, --config <path>   Config file (default: billshock.yml)
  -s, --state <path>    Sent-alert state file (default: .billshock/state.json)
      --dry-run         Print alerts without notifying or updating state
      --json            Print the result as JSON

Exit codes: 0 ok, 1 new alerts, 2 errors (bad config, fetch or notify failure)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "billshock.yml" },
      state: { type: "string", short: "s", default: ".billshock/state.json" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 2;
  }

  switch (command) {
    case "init":
      return runInit(process.cwd(), values.force);
    case "check": {
      const config = loadConfig(values.config!);
      const quiet = values.json;
      const result = await runCheck({
        config,
        statePath: values.state!,
        dryRun: values["dry-run"],
        log: quiet ? () => {} : undefined,
      });
      if (quiet) console.log(JSON.stringify(result, null, 2));
      return result.exitCode;
    }
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof ConfigError ? `config error: ${err.message}` : err);
    process.exitCode = 2;
  },
);
