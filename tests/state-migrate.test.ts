// Moving the state root off a disposable engine clone. Every guard here protects data the user
// would not want moved behind their back, so the decisions matter more than the mechanics.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapStateRoot,
  hasOwnershipMarker,
  migrateStateRoot,
  planStateMigration,
  setEffectiveStateRoot,
} from "../src/engine/state-dir.ts";

let base: string;
let from: string;
let to: string;
let savedEnv: string | undefined;

beforeEach(() => {
  // realpath: the ownership marker records the canonical path, and on macOS /var is a symlink.
  base = realpathSync(mkdtempSync(join(tmpdir(), "llmwiki-mig-")));
  from = join(base, "clone", ".state");
  to = join(base, "home", ".local", "share", "llmwiki");
  mkdirSync(join(base, "clone"), { recursive: true });
  savedEnv = process.env.LLMWIKI_STATE_DIR;
  delete process.env.LLMWIKI_STATE_DIR; // the offer only applies to the clone-local DEFAULT
});

afterEach(() => {
  setEffectiveStateRoot(null);
  if (savedEnv === undefined) delete process.env.LLMWIKI_STATE_DIR;
  else process.env.LLMWIKI_STATE_DIR = savedEnv;
  rmSync(base, { recursive: true, force: true });
});

/** A clone-local root as a v0.10 install would have left it. */
function seedLegacyRoot(): void {
  setEffectiveStateRoot(from);
  bootstrapStateRoot(from);
  // bootstrap creates the marker and the log; the queue appears on first capture. A placeholder
  // stands in for it here — this test moves bytes, it does not validate the schema.
  writeFileSync(join(from, "capture.db"), "queue-placeholder");
  mkdirSync(join(from, "projects", "0".repeat(32)), { recursive: true });
  writeFileSync(join(from, "projects", "0".repeat(32), "meta.json"), JSON.stringify({ version: 1, worktree: "/gone", lastUsed: "2026-01-01T00:00:00.000Z" }));
  setEffectiveStateRoot(null);
}

describe("state root migration", () => {
  test("an explicitly named root is never offered — that is the user's choice", () => {
    seedLegacyRoot();
    process.env.LLMWIKI_STATE_DIR = from;

    const plan = planStateMigration(false, { from, to });

    expect(plan.needed).toBe(false);
    expect(plan.reason).toContain("LLMWIKI_STATE_DIR");
  });

  test("a directory that is not one of ours is never offered", () => {
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "someone-elses.txt"), "hi");

    const plan = planStateMigration(false, { from, to });

    expect(plan.needed).toBe(false);
  });

  test("a running daemon blocks the move — capture.db is open for writing", () => {
    seedLegacyRoot();

    const plan = planStateMigration(true, { from, to });

    expect(plan.needed).toBe(true);
    expect(plan.blockers.join(" ")).toContain("daemon");
    expect(migrateStateRoot(true, true, { from, to }).kind).toBe("blocked");
    expect(existsSync(join(from, "capture.db"))).toBe(true); // untouched
  });

  test("a non-empty destination blocks the move", () => {
    seedLegacyRoot();
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "occupied"), "x");

    expect(migrateStateRoot(false, true, { from, to }).kind).toBe("blocked");
    expect(existsSync(join(from, "capture.db"))).toBe(true);
  });

  test("a dry run changes nothing", () => {
    seedLegacyRoot();

    const result = migrateStateRoot(false, false, { from, to });

    expect(result.kind).toBe("dry-run");
    expect(existsSync(to)).toBe(false);
    expect(existsSync(join(from, "capture.db"))).toBe(true);
  });

  test("a commit moves everything, re-stamps ownership, and leaves nothing behind", () => {
    seedLegacyRoot();
    const projectId = "0".repeat(32);

    const result = migrateStateRoot(false, true, { from, to });

    expect(result.kind).toBe("moved");
    expect(existsSync(from)).toBe(false);
    expect(existsSync(join(to, "capture.db"))).toBe(true);
    expect(existsSync(join(to, "projects", projectId, "meta.json"))).toBe(true);
    // The marker records the path it was written for; a moved root that kept the old one would
    // read as un-owned and every later command would refuse it.
    expect(hasOwnershipMarker(to)).toBe(true);
    expect(JSON.parse(readFileSync(join(to, ".llmwiki-state-v1.json"), "utf-8")).root).toBe(to);
    expect(statSync(to).mode & 0o077).toBe(0);
  });

  test("running it again reports nothing to do", () => {
    seedLegacyRoot();
    migrateStateRoot(false, true, { from, to });

    const again = planStateMigration(false, { from, to });

    expect(again.needed).toBe(false);
  });
});
