// Observability for the half of this engine that fails silently.
//
// Both capture failures found in the field kept every existing check green: a router that resolved
// 22 of 2,687 sessions, and a state root the engine refused to adopt. The daemon stayed up, cold
// start kept injecting, doctor reported ✅ across the board — and nothing was being recorded. What
// follows are the read-only probes that make those states visible, so the next one is a line of
// output rather than an archaeology session.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { probeStateRoot, setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { claudeRetentionDays, CLAUDE_DEFAULT_RETENTION_DAYS } from "../src/engine/sources/claude.ts";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix = "llmwiki-health-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  setEffectiveStateRoot(null); // back to the real root for the next file
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("probeStateRoot — answers without touching anything", () => {
  test("an absent root reads as usable and is NOT created", () => {
    const root = join(scratch(), "state");
    const probe = probeStateRoot(root);
    expect(probe.usable).toBe(true);
    expect(existsSync(root)).toBe(false); // observing an installation must not initialize it
  });

  test("a directory llmwiki does not own is reported unusable, and the blocker is named", () => {
    const root = join(scratch(), "someone-elses");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "important.txt"), "NOT-OURS\n");

    const probe = probeStateRoot(root);

    expect(probe.usable).toBe(false);
    expect(probe.detail).toContain("does not own");
    expect(existsSync(join(root, ".llmwiki-state-v1.json"))).toBe(false); // no marker written
  });

  test("a root capture already owns reads as usable", () => {
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    capture.enqueue(join(scratch(), "t.jsonl"), "s1", "/repo/x", 60);
    expect(probeStateRoot(root).usable).toBe(true);
  });
});

describe("capture health — read-only", () => {
  test("no queue yet reads as no history, without creating one", () => {
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    expect(capture.healthReadOnly()).toBeNull();
    expect(existsSync(join(root, "capture.db"))).toBe(false);
  });

  test("rows are grouped per source adapter, so a dead harness is visible", () => {
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    capture.enqueue(join(scratch(), "a.jsonl"), "s-a", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(join(scratch(), "b.jsonl"), "s-b", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(join(scratch(), "c.jsonl"), "s-c", "/repo/b", 60, "codex");

    const health = capture.healthReadOnly();

    expect(health).not.toBeNull();
    expect(health!.repos.sort()).toEqual(["/repo/a", "/repo/b"]);
    const byKind = Object.fromEntries(health!.byKind.map((k) => [k.kind, k.rows]));
    expect(byKind["claude-jsonl"]).toBe(2);
    expect(byKind["codex"]).toBe(1);
    expect(health!.lastSeen).not.toBeNull();
  });

  test("the band with a deadline is counted separately from the band without one", () => {
    // A backlog count stops meaning anything once the reader is used to it. "Three of these
    // disappear this week" is the sentence that can be acted on — and the one that stops being
    // true if it is ignored. Measured on this author's machine before the warning existed:
    // 33 pending sessions had already evaporated, and nothing had said so in time.
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    const dir = scratch();
    const soon = join(dir, "soon.jsonl");
    const fresh = join(dir, "fresh.jsonl");
    for (const p of [soon, fresh]) writeFileSync(p, '{"a":1}\n', "utf-8");
    capture.enqueue(soon, "s-soon", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(fresh, "s-fresh", "/repo/a", 60, "claude-jsonl");
    const db = new Database(capture.getDbPath());
    // 25 days old against a 30-day window: inside it, but the deadline lands in 5 days.
    db.run("UPDATE capture_queue SET first_seen = datetime('now','-25 days') WHERE transcript_path = ?", [soon]);
    db.close();

    expect(capture.pendingPastRetentionReadOnly(30, "claude-jsonl")).toEqual({
      expiringSoon: 1,
      atRisk: 0,
      lost: 0,
    });
    // The same rows, counted from a caller's own list (what cold start does per repository).
    const rows = capture.pending("/repo/a");
    expect(capture.expiringWithin(rows, 30)).toBe(1);
    // A retention window we do not know is never given a deadline.
    expect(capture.expiringWithin(rows, 30, "codex")).toBe(0);
  });

  test("pending sessions past the retention window are split by whether the evidence survives", () => {
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    const dir = scratch();
    const alive = join(dir, "old.jsonl");
    const deleted = join(dir, "gone.jsonl");
    for (const p of [alive, deleted, join(dir, "new.jsonl"), join(dir, "cx.jsonl")]) {
      writeFileSync(p, '{"a":1}\n', "utf-8");
    }
    capture.enqueue(alive, "s-old", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(deleted, "s-gone", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(join(dir, "new.jsonl"), "s-new", "/repo/a", 60, "claude-jsonl");
    capture.enqueue(join(dir, "cx.jsonl"), "s-cx", "/repo/a", 60, "codex");
    // Age two rows past the window the harness would delete them in…
    const db = new Database(capture.getDbPath());
    db.run("UPDATE capture_queue SET first_seen = datetime('now','-45 days') WHERE transcript_path IN (?, ?)", [
      alive,
      deleted,
    ]);
    db.close();
    rmSync(deleted); // …and let the harness have actually deleted one of them.

    // Age says both are overdue; only one can still be condensed. Reporting them as one number
    // turns a deadline into a nag that never clears, because the dead row stays `pending` forever.
    expect(capture.pendingPastRetentionReadOnly(30, "claude-jsonl")).toEqual({ expiringSoon: 0, atRisk: 1, lost: 1 });
    // A 60-day window puts the same 45-day-old rows INSIDE it, with the deadline 15 days out —
    // past the 7-day warning band, so they are not yet anyone's problem.
    expect(capture.pendingPastRetentionReadOnly(60, "claude-jsonl")).toEqual({ expiringSoon: 0, atRisk: 0, lost: 0 });
    expect(capture.pendingPastRetentionReadOnly(30, "codex")).toEqual({ expiringSoon: 0, atRisk: 0, lost: 0 });
  });
});

describe("Claude retention is read, not assumed", () => {
  test("with no setting, the documented default applies", () => {
    const home = scratch();
    mkdirSync(join(home, ".claude"), { recursive: true });
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));

    expect(claudeRetentionDays()).toEqual({ days: CLAUDE_DEFAULT_RETENTION_DAYS, configured: false });
  });

  test("the shortest configured period across profiles wins — it is the first deadline", () => {
    const home = scratch();
    for (const [name, days] of [
      [".claude", 30],
      [".claude-work", 7],
    ] as const) {
      mkdirSync(join(home, name), { recursive: true });
      writeFileSync(join(home, name, "settings.json"), JSON.stringify({ cleanupPeriodDays: days }));
    }
    setEnv("HOME", home);

    expect(claudeRetentionDays()).toEqual({ days: 7, configured: true });
  });

  test("an unparsable settings file is not treated as a retention claim", () => {
    const home = scratch();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));

    expect(claudeRetentionDays().configured).toBe(false);
  });
});
