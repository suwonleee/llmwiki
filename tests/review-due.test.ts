// P1-B: deterministic review cadence gate (`review --if-due`). The "~every 7 days" close-out
// rule used to live only in skill prose (enforced at the model's whim — observed re-running
// 4 days after the last review); _isDue makes the cadence an engine property. Pure day-diff
// logic — no LLM, no workspace.
import { test, expect } from "bun:test";
import { _isDue, _launchIncomplete, REVIEW_INTERVAL_DAYS } from "../src/engine/review.ts";

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

// Silent-failure detector for backgrounded commit runs: `launched` is stamped right before the
// heavy LLM call, and only a COMPLETED commit overwrites the state launch-free. "Launched with
// no completion on/after it" = a run died without a trace (or is still running — the message
// wording covers both). Backgrounding review without this check would trade a visible stall for
// an invisible death — the "success-looking failure" class.
test("no launch marker → not incomplete", () => {
  expect(_launchIncomplete({})).toBe(false);
  expect(_launchIncomplete({ date: "2026-07-14" })).toBe(false);
});

test("launched but never committed → incomplete", () => {
  expect(_launchIncomplete({ launched: "2026-07-21" })).toBe(true);
});

test("launched after the last completed commit → incomplete", () => {
  expect(_launchIncomplete({ date: "2026-07-14", launched: "2026-07-21" })).toBe(true);
});

test("commit completed on the launch day → cleared (same-day launch+commit)", () => {
  expect(_launchIncomplete({ date: "2026-07-21", launched: "2026-07-21" })).toBe(false);
});

test("completion newer than a stale marker → cleared", () => {
  expect(_launchIncomplete({ date: "2026-07-22", launched: "2026-07-21" })).toBe(false);
});
