// update-done evidence gate: a filed (non-skipped) watermark must be the exact new_offset the last
// update-next issued for that transcript — the one proof an extract existed for the range being
// closed. Zero-offset completion of nonempty transcripts must not silently re-pend them as "grew".
import { test, expect, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as capture from "../src/engine/capture.ts";
import * as update from "../src/engine/update.ts";

const tmps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function queued(): { repo: string; t: string } {
  capture.setStateDir(tmp("llmwiki-gate-state-"));
  const repo = join(tmp("llmwiki-gate-repo-"), "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"], {});
  const t = join(tmp("llmwiki-gate-t-"), "s.jsonl");
  const row = { type: "user", timestamp: "2026-09-23T10:00:00Z", cwd: repo, message: { role: "user", content: "결정: A 채택" } };
  writeFileSync(t, JSON.stringify(row) + "\n");
  capture.enqueue(t, "s-gate", repo, 60, "claude-jsonl");
  return { repo, t };
}

test("a filed mark without an issued extract is refused with the update-next instruction", () => {
  const { repo, t } = queued();
  const size = statSync(t).size;
  expect(() => update.markUpdated(repo, t, size)).toThrow(/no update-next extract.*llmwiki update-next/);
  expect(capture.stats()).toEqual({ pending: 1 });
});

test("the issued new_offset is accepted; 0, a mismatch and past-the-end are refused", () => {
  const { repo, t } = queued();
  const inc = update.nextIncrement(repo, t);
  expect(inc.newOffset).toBe(statSync(t).size);

  expect(() => update.markUpdated(repo, t, 0)).toThrow(/offset 0 on a non-empty transcript/);
  expect(() => update.markUpdated(repo, t, inc.newOffset - 1)).toThrow(/not the new_offset update-next last issued/);
  expect(() => update.markUpdated(repo, t, inc.newOffset + 1)).toThrow(/past the end/);
  expect(() => update.markUpdated(repo, t, Number.NaN)).toThrow(/non-negative integer/);
  expect(capture.stats()).toEqual({ pending: 1 });

  update.markUpdated(repo, t, inc.newOffset);
  expect(capture.stats()).toEqual({ distilled: 1 });
  expect(capture.getOffset(t)).toBe(inc.newOffset);
  // The per-bucket ledger update-status prints — what a deep pass reports instead of its own tally.
  expect(capture.stats(repo)).toEqual({ distilled: 1 });
  expect(capture.stats(join(repo, "..", "elsewhere"))).toEqual({});
});

test("growth after the extract: the issued (older) offset is still the one to close", () => {
  const { repo, t } = queued();
  const inc = update.nextIncrement(repo, t);
  appendFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "추가" } }) + "\n");
  expect(() => update.markUpdated(repo, t, statSync(t).size)).toThrow(/not the new_offset/);
  update.markUpdated(repo, t, inc.newOffset);
  expect(capture.getOffset(t)).toBe(inc.newOffset);
});

test("--skipped needs no extract but can never point past the end", () => {
  const { repo, t } = queued();
  const size = statSync(t).size;
  expect(() => update.markUpdated(repo, t, size + 1, true)).toThrow(/past the end/);
  update.markUpdated(repo, t, size, true);
  expect(capture.stats()).toEqual({ skipped: 1 });
});

test("a mark never rewinds a watermark another path already advanced", () => {
  const { repo, t } = queued();
  const first = update.nextIncrement(repo, t);
  // Reconcile/autoupdate advance the row past the issued offset while the extract is being read.
  appendFileSync(t, JSON.stringify({ type: "user", timestamp: "2026-09-23T10:05:00Z", message: { role: "user", content: "추가" } }) + "\n");
  capture.mark(t, statSync(t).size, "distilled");
  expect(() => update.markUpdated(repo, t, first.newOffset)).toThrow(/behind the current watermark/);
  expect(() => update.markUpdated(repo, t, first.newOffset, true)).toThrow(/behind the current watermark/);
  expect(capture.getOffset(t)).toBe(statSync(t).size);
});

test("an issuance is spent by the mark it vouched for", () => {
  const { repo, t } = queued();
  const inc = update.nextIncrement(repo, t);
  update.markUpdated(repo, t, inc.newOffset);
  expect(capture.issuedOffset(t)).toBeNull();
});

test("a transcript already rotated away can still be closed with --skipped", () => {
  const { repo, t } = queued();
  const inc = update.nextIncrement(repo, t);
  rmSync(t);
  expect(() => update.markUpdated(repo, t, inc.newOffset, true)).not.toThrow();
  expect(capture.stats()).toEqual({ skipped: 1 });
});
