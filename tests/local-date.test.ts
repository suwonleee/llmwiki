// Dates the reader compares against their own calendar must follow the reader's calendar.
//
// Run in a subprocess per timezone: Bun reads TZ once at startup, so mutating process.env.TZ
// mid-test changes nothing. Each case fixes the instant too, so the assertion is about the
// timezone rule and never about when the suite happens to run.
import { test, expect, describe } from "bun:test";
import { spawnSync } from "bun";
import { join } from "node:path";

const TODAY_TS = join(import.meta.dir, "..", "src", "engine", "today.ts");

function todayIn(tz: string, instant: string): string {
  const script = `const { today } = await import(${JSON.stringify(TODAY_TS)});\nconsole.log(today(new Date(${JSON.stringify(instant)})));`;
  const r = spawnSync([process.execPath, "-e", script], { env: { ...process.env, TZ: tz } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

const utcDate = (instant: string) => new Date(instant).toISOString().slice(0, 10);

describe("local calendar date", () => {
  test("a UTC+12 morning is today, not yesterday", () => {
    // 08:00 Auckland on the 26th. UTC still says the 25th — most of an Auckland workday.
    const instant = "2026-07-25T20:00:00Z";
    expect(utcDate(instant)).toBe("2026-07-25");
    expect(todayIn("Pacific/Auckland", instant)).toBe("2026-07-26");
  });

  test("a UTC+9 morning is today, not yesterday", () => {
    // 08:00 Seoul / Tokyo on the 26th.
    const instant = "2026-07-25T23:00:00Z";
    expect(utcDate(instant)).toBe("2026-07-25");
    expect(todayIn("Asia/Seoul", instant)).toBe("2026-07-26");
    expect(todayIn("Asia/Tokyo", instant)).toBe("2026-07-26");
  });

  test("a UTC-7 evening is today, not tomorrow", () => {
    // 23:00 Los Angeles on the 24th, which UTC already calls the 25th.
    const instant = "2026-07-25T06:00:00Z";
    expect(utcDate(instant)).toBe("2026-07-25");
    expect(todayIn("America/Los_Angeles", instant)).toBe("2026-07-24");
  });

  test("UTC itself is unchanged", () => {
    const instant = "2026-07-25T12:00:00Z";
    expect(todayIn("UTC", instant)).toBe(utcDate(instant));
  });

  test("single-digit months and days are zero-padded", () => {
    expect(todayIn("UTC", "2026-01-05T12:00:00Z")).toBe("2026-01-05");
  });
});

describe("addDays", () => {
  test("is exact calendar arithmetic across month and DST boundaries", () => {
    const { addDays } = require("../src/engine/today.ts") as typeof import("../src/engine/today.ts");
    expect(addDays("2026-07-25", 7)).toBe("2026-08-01");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08"); // US DST start — no 23-hour drift
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});
