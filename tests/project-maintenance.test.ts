// The maintenance pass the old layout could not have: compaction, eviction and orphan collection
// over every project the engine holds. Each assertion here is a "never do this" as much as a
// "do this" — the pass runs unattended from the daemon, so declining is the default.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiIndex } from "../src/engine/db.ts";
import {
  DEFAULT_EVICT_AFTER_DAYS,
  DEFAULT_ORPHAN_GRACE_DAYS,
  INDEX_STORE_POLICY,
  mayBeOnDetachedVolume,
  orphanGraceDays,
  runProjectMaintenance,
  summarizeProjectStore,
} from "../src/engine/project-maintenance.ts";
import { DEFAULT_DB_COMPACTION_POLICY } from "../src/engine/db-maintenance.ts";
import {
  listProjectStates,
  projectStatePath,
  resetProjectStateCache,
  writeProjectState,
} from "../src/engine/project-state.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

let stateRoot: string;
const made: string[] = [];
const DAY = 86_400_000;

function newIndexedRepo(): string {
  const repo = enrollRepo(makeGitRepo(tempDir("llmwiki-pm-")));
  made.push(repo);
  const dir = join(repo, "docs", "wiki", "3_decision");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "page.md"), "---\ntitle: P\n---\n" + "rollout pipeline stages. ".repeat(10));
  new WikiIndex(repo).indexAll();
  return repo;
}

/** A project directory as the engine leaves it, recording a worktree that may or may not exist. */
function fakeProjectState(worktree: string | null, lastUsed = new Date(Date.now() - 30 * DAY)): string {
  const dir = join(stateRoot, "projects", randomUUID().replace(/-/g, ""));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.db"), "x".repeat(4096));
  if (worktree !== null) {
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ version: 1, worktree, lastUsed: lastUsed.toISOString() }) + "\n",
    );
  }
  return dir;
}

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "llmwiki-pm-state-"));
  setEffectiveStateRoot(stateRoot);
  resetProjectStateCache();
});

afterEach(() => {
  setEffectiveStateRoot(null);
  resetProjectStateCache();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("project store maintenance", () => {
  test("the index-store policy actually fires where the shared default never would", () => {
    // The shared 30 MiB floor is why scattered indexes accumulated a third of their file in free
    // pages and stayed "not eligible" forever. A store policy that inherited it would change nothing.
    expect(INDEX_STORE_POLICY.minimumDatabaseBytes).toBeLessThan(
      DEFAULT_DB_COMPACTION_POLICY.minimumDatabaseBytes,
    );
  });

  test("a freshly used project is left completely alone", () => {
    const repo = newIndexedRepo();
    const dir = projectStatePath(repo);

    const outcome = runProjectMaintenance();

    expect(outcome.evicted).toBe(0);
    expect(outcome.collected).toBe(0);
    expect(existsSync(join(dir, "index.db"))).toBe(true);
  });

  test("an idle project loses its index but keeps its watermarks", () => {
    const repo = newIndexedRepo();
    writeProjectState(repo, "review-state.json", '{"date":"2026-01-01"}');
    const dir = projectStatePath(repo);

    const outcome = runProjectMaintenance({ now: Date.now() + (DEFAULT_EVICT_AFTER_DAYS + 1) * DAY });

    expect(outcome.evicted).toBe(1);
    expect(existsSync(join(dir, "index.db"))).toBe(false);
    expect(existsSync(join(dir, "review-state.json"))).toBe(true);
    expect(existsSync(dir)).toBe(true); // the project is still known, just not indexed
  });

  test("an orphan inside the grace period is NOT collected", () => {
    const repo = newIndexedRepo();
    const dir = projectStatePath(repo);
    rmSync(repo, { recursive: true, force: true });
    resetProjectStateCache();

    const outcome = runProjectMaintenance({ now: Date.now() + (DEFAULT_ORPHAN_GRACE_DAYS - 1) * DAY });

    expect(outcome.collected).toBe(0);
    expect(existsSync(dir)).toBe(true); // an unmounted volume must not read as a deleted project
  });

  test("an orphan past the grace period is collected whole", () => {
    const repo = newIndexedRepo();
    const dir = projectStatePath(repo);
    rmSync(repo, { recursive: true, force: true });
    resetProjectStateCache();

    const outcome = runProjectMaintenance({ now: Date.now() + (DEFAULT_ORPHAN_GRACE_DAYS + 1) * DAY });

    expect(outcome.collected).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(listProjectStates().length).toBe(0);
  });

  test("a dry run reports without touching anything", () => {
    const repo = newIndexedRepo();
    const dir = projectStatePath(repo);
    rmSync(repo, { recursive: true, force: true });
    resetProjectStateCache();

    const outcome = runProjectMaintenance({
      now: Date.now() + (DEFAULT_ORPHAN_GRACE_DAYS + 1) * DAY,
      commit: false,
    });

    expect(outcome.collected).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("the summary answers the question the old layout could not", () => {
    newIndexedRepo();
    const summary = summarizeProjectStore();

    expect(summary.projects).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(summary.orphans).toBe(0);
  });

  test("a worktree on a volume that is not mounted is never collected", () => {
    const dir = fakeProjectState(`/Volumes/llmwiki-absent-volume-${randomUUID()}/repo`);

    const outcome = runProjectMaintenance({ now: Date.now() + 365 * DAY });

    expect(outcome.collected).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("a directory without a recorded worktree is never collected", () => {
    const dir = fakeProjectState(null);

    expect(runProjectMaintenance({ now: Date.now() + 365 * DAY }).collected).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("a gone worktree is collected only after the configured window", () => {
    const parent = mkdtempSync(join(tmpdir(), "llmwiki-pm-gone-"));
    made.push(parent);
    const dir = fakeProjectState(join(parent, "deleted-worktree"), new Date(Date.now() - 3 * DAY));

    expect(runProjectMaintenance({ orphanGraceDays: 7 }).collected).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(runProjectMaintenance({ orphanGraceDays: 2 }).collected).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("the detached-volume guard reads the nearest existing ancestor", () => {
    expect(mayBeOnDetachedVolume(`/Volumes/llmwiki-absent-${randomUUID()}/a/b`)).toBe(true);
    expect(mayBeOnDetachedVolume(`/llmwiki-absent-top-${randomUUID()}/repo`)).toBe(true);
    expect(mayBeOnDetachedVolume(join(tmpdir(), `llmwiki-absent-${randomUUID()}`, "repo"))).toBe(false);
  });

  test("the grace window is configurable and falls back on nonsense", () => {
    expect(orphanGraceDays({})).toBe(DEFAULT_ORPHAN_GRACE_DAYS);
    expect(orphanGraceDays({ LLMWIKI_ORPHAN_GRACE_DAYS: "3" })).toBe(3);
    expect(orphanGraceDays({ LLMWIKI_ORPHAN_GRACE_DAYS: "-1" })).toBe(DEFAULT_ORPHAN_GRACE_DAYS);
    expect(orphanGraceDays({ LLMWIKI_ORPHAN_GRACE_DAYS: "soon" })).toBe(DEFAULT_ORPHAN_GRACE_DAYS);
  });

  test("purge-state --orphans reports by default and deletes only with --confirm", () => {
    const live = projectStatePath(newIndexedRepo()); // first: it claims the fresh state root
    const parent = mkdtempSync(join(tmpdir(), "llmwiki-pm-cli-"));
    made.push(parent);
    const gone = fakeProjectState(join(parent, "deleted-worktree"));
    const fresh = fakeProjectState(join(parent, "deleted-today"), new Date());
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, CLI, "purge-state", "--orphans", ...args], {
        env: { ...process.env, LLMWIKI_STATE_DIR: stateRoot },
        stdout: "pipe",
        stderr: "pipe",
      });

    const report = run();
    expect(report.exitCode).toBe(0);
    expect(report.stdout.toString()).toContain("would remove");
    expect(report.stdout.toString()).toContain("1 orphaned project state dir(s)");
    expect(existsSync(gone)).toBe(true);

    const confirmed = run("--confirm");
    expect(confirmed.exitCode).toBe(0);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // inside the window
    expect(existsSync(live)).toBe(true); // its worktree exists
  });
});
