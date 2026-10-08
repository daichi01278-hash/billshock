import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DAY_MS } from "./dates.js";

/** Remembers which alerts were already delivered so an hourly cron doesn't repeat them. */
export interface State {
  version: 1;
  sent: Record<string, string>;
}

const RETENTION_DAYS = 62;

export function loadState(path: string): State {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as State;
    if (s && s.version === 1 && typeof s.sent === "object") return s;
  } catch {
    // Missing or corrupt state: start fresh. Worst case, an alert repeats once.
  }
  return { version: 1, sent: {} };
}

export function saveState(path: string, state: State, now: Date): void {
  const cutoff = now.getTime() - RETENTION_DAYS * DAY_MS;
  const sent = Object.fromEntries(Object.entries(state.sent).filter(([, at]) => Date.parse(at) >= cutoff));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 1, sent }, null, 2)}\n`);
}
