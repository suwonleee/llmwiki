// capture-prune: dead pending rows (transcript rotated away) leave the queue; everything
// that can still condense — or is merely too recently gone — stays.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";

describe("capture prune", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-prune-"));
    capture.setStateDir(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a live pending row survives even with a zero-day guard", () => {
    const t = join(dir, "alive.jsonl");
    writeFileSync(t, "x\n");
    capture.enqueue(t, "s1", "/repo/a", 1);

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1 });
    expect(capture.stats()["pending"]).toBe(1);
  });

  test("a dead pending row inside the age guard is kept", () => {
    capture.enqueue(join(dir, "gone.jsonl"), "s1", "/repo/a", 1);

    expect(capture.prune(30)).toEqual({ removed: 0, kept: 1 });
    expect(capture.stats()["pending"]).toBe(1);
  });

  test("a dead pending row past the age guard is removed", () => {
    capture.enqueue(join(dir, "gone.jsonl"), "s1", "/repo/a", 1);

    expect(capture.prune(0)).toEqual({ removed: 1, kept: 0 });
    expect(capture.stats()["pending"]).toBeUndefined();
  });

  test("a compressed-in-place transcript (.zst sibling) still counts as alive", () => {
    const t = join(dir, "rolled.jsonl");
    capture.enqueue(t, "s1", "/repo/a", 1);
    writeFileSync(`${t}.zst`, "z");

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 1 });
  });

  test("distilled rows are the ledger — never pruned, file or no file", () => {
    const t = join(dir, "filed.jsonl");
    capture.enqueue(t, "s1", "/repo/a", 1);
    capture.mark(t, 100, "distilled");

    expect(capture.prune(0)).toEqual({ removed: 0, kept: 0 });
    expect(capture.stats()["distilled"]).toBe(1);
  });
});
