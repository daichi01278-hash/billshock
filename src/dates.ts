const DAY_MS = 86_400_000;

export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(key: string, n: number): string {
  return dateKey(new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS));
}

export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function daysInUtcMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Fractional days elapsed since the start of the UTC month. */
export function elapsedMonthDays(now: Date): number {
  return (now.getTime() - startOfUtcMonth(now).getTime()) / DAY_MS;
}

export { DAY_MS };
