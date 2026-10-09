import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { DEFAULT_RULES } from "./rules.js";
import type { Rules } from "./types.js";

export const PROVIDERS = ["openai", "anthropic", "vercel", "cursor"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderConfig {
  name: ProviderName;
  /** Admin API key (OpenAI / Anthropic / Cursor) or access token (Vercel). Empty when the env var is unset. */
  credential: string;
  teamId?: string;
  rules: Rules;
}

export interface Config {
  providers: ProviderConfig[];
  /** Rules for the combined spend of all providers; undefined disables the "total" scope. */
  total?: Rules;
  notify: { discordWebhook?: string; slackWebhook?: string };
}

export class ConfigError extends Error {}

const RULE_KEYS: Array<keyof Rules> = ["dailyCap", "spikeMultiplier", "spikeMinAmount", "spikeBaselineDays", "monthlyBudget"];

/** Replaces ${VAR} with the environment value (empty string if unset). */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

function str(v: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" && typeof v !== "number") throw new ConfigError(`expected a string, got ${JSON.stringify(v)}`);
  const s = interpolate(String(v), env).trim();
  return s === "" ? undefined : s;
}

function parseRules(v: unknown, where: string): Rules {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be a mapping`);
  const out: Rules = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!RULE_KEYS.includes(k as keyof Rules)) throw new ConfigError(`${where}.${k} is not a known rule (expected one of: ${RULE_KEYS.join(", ")})`);
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new ConfigError(`${where}.${k} must be a non-negative number`);
    out[k as keyof Rules] = n;
  }
  return out;
}

export function parseConfig(text: string, env: NodeJS.ProcessEnv = process.env): Config {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ConfigError(`invalid YAML: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== "object") throw new ConfigError("config is empty");
  const root = doc as Record<string, unknown>;

  const defaults: Rules = { ...DEFAULT_RULES, ...parseRules(root.rules, "rules") };

  const providersRaw = (root.providers ?? {}) as Record<string, Record<string, unknown> | null>;
  if (typeof providersRaw !== "object") throw new ConfigError("providers must be a mapping");
  const providers: ProviderConfig[] = [];
  for (const [name, block] of Object.entries(providersRaw)) {
    if (!PROVIDERS.includes(name as ProviderName)) throw new ConfigError(`unknown provider "${name}" (supported: ${PROVIDERS.join(", ")})`);
    const b = block ?? {};
    const credential = name === "vercel" ? str(b.token, env) : str(b.apiKey, env);
    providers.push({
      name: name as ProviderName,
      credential: credential ?? "",
      teamId: name === "vercel" ? str(b.teamId, env) : undefined,
      rules: { ...defaults, ...parseRules(b.rules, `providers.${name}.rules`) },
    });
  }
  if (providers.length === 0) throw new ConfigError(`no providers configured (supported: ${PROVIDERS.join(", ")})`);

  const total = root.total === undefined ? undefined : { ...defaults, ...parseRules(root.total, "total") };
  const n = (root.notify ?? {}) as Record<string, unknown>;

  return {
    providers,
    total,
    notify: { discordWebhook: str(n.discordWebhook, env), slackWebhook: str(n.slackWebhook, env) },
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`cannot read ${path} (run \`billshock init\` to create one)`);
  }
  return parseConfig(text, env);
}
