// capture-prune: dead pending rows (transcript rotated away) are tombstoned as `lost` — they
// leave the pending set but stay on the books; everything that can still condense — or is merely
// too recently gone — stays pending.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";

describe("capture prune", () => {
  let dir: string;

  beforeEach(() => {
    // The state root holds only llmwiki's own files; transcript fixtures live beside it.
    dir = mkdtempSync(join(tmpdir(), "llmwiki-prune-"));
    capture.setStateDir(join(dir, "state"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a live pending row survives even with a zero-day guard", () => {
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", "/repo/a", 1);

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
    expect(capture.stats()["pending"]).toBe(1);
  });

  test("a dead pending row inside the age guard is kept", () => {
    capture.enqueue(join(dir, "gone.jsonl"), "s1", "/repo/a", 1);

    expect(capture.prune(30)).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
    expect(capture.stats()["pending"]).toBe(1);
  });

  test("a dead pending row past the age guard becomes a lost tombstone, not a deletion", () => {
    // The transcript is gone, so this row is the ONLY evidence the session ever existed. Deleting
    // it is what the 2026-07-22 retention decision rejected: an un-filed session that expired is
    // usually one the human chose not to keep, and the ledger is how that stays auditable later.
    capture.enqueue(join(dir, "gone.jsonl"), "s1", "/repo/a", 1);

    expect(capture.prune(0)).toEqual({ removed: 1, kept: 0, skippedEphemeral: 0 });

    const stats = capture.stats();
    expect(stats["pending"]).toBeUndefined(); // it will never be condensed…
    expect(stats["lost"]).toBe(1); // …but it is still on the books
  });

  test("a compressed-in-place transcript (.zst sibling) still counts as alive", () => {
    const t = join(dir, "rolled.jsonl");
    capture.enqueue(t, "s1", "/repo/a", 1);
    writeFileSync(`${t}.zst`, "z");

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
  });

  test("distilled rows are the ledger — never pruned, file or no file", () => {
    const t = join(dir, "filed.jsonl");
    capture.enqueue(t, "s1", "/repo/a", 1);
    capture.mark(t, 100, "distilled");

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 0, skippedEphemeral: 0 });
    expect(capture.stats()["distilled"]).toBe(1);
  });

  // The ephemeral-repo rule: a worktree under the OS temp root that no longer exists is gone by
  // design (A/B fixtures, scratchpad clones), so its rows can never condense — measured at 44% of
  // the real pending queue before this rule existed. `skipped`, not `lost`: the transcript may
  // still be alive; what is gone is the wiki the session would have condensed into.

  test("a deleted temp-root repo is skipped immediately — live transcript, no age guard", () => {
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", join(dir, "deleted-fixture-repo"), 1); // dir is under tmpdir(); repo never created

    expect(capture.prune(30)).toEqual({ removed: 0, kept: 0, skippedEphemeral: 1 });
    const stats = capture.stats();
    expect(stats["pending"]).toBeUndefined();
    expect(stats["skipped"]).toBe(1); // on the books, never condensed
  });

  test("a temp-root repo that still exists is a live experiment — kept", () => {
    const repo = join(dir, "running-fixture-repo");
    mkdirSync(repo);
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", repo, 1);

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
  });

  test("a missing repo OUTSIDE the temp root is never judged — unmounted volumes look identical", () => {
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", "/Volumes/detached-disk/project", 1);

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
    expect(capture.stats()["pending"]).toBe(1);
  });

  test("macOS-only temp aliases are not generalized to other platforms", () => {
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", "/var/folders/llmwiki-deleted-fixture/repo", 1);

    const result = capture.prune(30);
    if (process.platform === "darwin") {
      expect(result).toEqual({ removed: 0, kept: 0, skippedEphemeral: 1 });
      expect(capture.stats()["skipped"]).toBe(1);
    } else {
      expect(result).toEqual({ removed: 0, kept: 1, skippedEphemeral: 0 });
      expect(capture.stats()["pending"]).toBe(1);
    }
  });
});
