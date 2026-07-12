// P1-B: deterministic review cadence gate (`review --if-due`). The "~every 7 days" close-out
// rule used to live only in skill prose (enforced at the model's whim — observed re-running
// 4 days after the last review); _isDue makes the cadence an engine property. Pure day-diff
// logic — no LLM, no workspace.
import { test, expect } from "bun:test";
import { _isDue, REVIEW_INTERVAL_DAYS } from "../src/engine/review.ts";

test("no prior committed review → due", () => {
  expect(_isDue(undefined, "2026-07-11", 7)).toBe(true);
  expect(_isDue("", "2026-07-11", 7)).toBe(true);
});

test("same day → not due", () => {
  expect(_isDue("2026-07-11", "2026-07-11", 7)).toBe(false);
});

test("younger than the interval → not due", () => {
  expect(_isDue("2026-07-05", "2026-07-11", 7)).toBe(false); // 6 days
});

test("exactly the interval → due", () => {
  expect(_isDue("2026-07-04", "2026-07-11", 7)).toBe(true); // 7 days
});

test("older than the interval → due", () => {
  expect(_isDue("2026-06-01", "2026-07-11", 7)).toBe(true);
});

test("unparseable state date fails open (a corrupt state file must never silence review)", () => {
  expect(_isDue("not-a-date", "2026-07-11", 7)).toBe(true);
});

test("interval 1 → due the next day, not the same day", () => {
  expect(_isDue("2026-07-10", "2026-07-11", 1)).toBe(true);
  expect(_isDue("2026-07-11", "2026-07-11", 1)).toBe(false);
});

test("default interval is floored and sane", () => {
  expect(REVIEW_INTERVAL_DAYS).toBeGreaterThanOrEqual(1);
});
