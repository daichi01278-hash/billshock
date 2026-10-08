import type { FetchFn } from "../types.js";

export class ProviderError extends Error {
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
  }
}

const HINTS: Record<number, string> = {
  401: "check the key; an *admin* key is required, not a regular API key",
  403: "the key/token is invalid or lacks permission to read billing or cost data",
  404: "endpoint not found; check the team/organization id",
  429: "rate limited; run less often",
};

export async function request(provider: string, fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new ProviderError(provider, `request failed: ${(err as Error).message}`);
  }
  const body = await res.text();
  if (!res.ok) {
    const hint = HINTS[res.status] ? ` (${HINTS[res.status]})` : "";
    throw new ProviderError(provider, `HTTP ${res.status}${hint}: ${body.slice(0, 300)}`);
  }
  return body;
}

export function parseJson(provider: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError(provider, `unexpected non-JSON response: ${body.slice(0, 200)}`);
  }
}

/** Parses amounts that APIs return as either numbers or decimal strings. */
export function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}
