import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo.js";

describe("demo", () => {
  it("runs the real parsers and rules on sample data and shows the spikes", async () => {
    const logs: string[] = [];
    // Mid-month, so the total's month-end projection rule applies.
    const code = await runDemo((l) => logs.push(l), new Date("2026-10-15T12:00:00Z"));
    const out = logs.join("\n");
    expect(code).toBe(0);
    expect(out).toMatch(/^scope\s+today\s+yesterday/m);
    for (const scope of ["openai", "anthropic", "vercel", "cursor", "total"]) expect(out).toMatch(new RegExp(`^${scope}\\s`, "m"));
    expect(out).toContain("ALERT openai: $41.20 spent on 2026-10-14");
    expect(out).toContain("ALERT vercel: $659.08 spent on 2026-10-14");
    expect(out).toMatch(/ALERT total: on pace for \$\d+\.\d{2} in 2026-10/);
    expect(out).not.toContain("ALERT anthropic");
    expect(out).not.toContain("ALERT cursor");
    expect(out).not.toContain("ERROR");
  });

  it("works on the first day of a month", async () => {
    const logs: string[] = [];
    expect(await runDemo((l) => logs.push(l), new Date("2026-11-01T03:00:00Z"))).toBe(0);
    expect(logs.join("\n")).not.toContain("ERROR");
  });
});
