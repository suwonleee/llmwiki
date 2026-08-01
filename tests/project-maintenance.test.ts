// The maintenance pass the old layout could not have: compaction, eviction and orphan collection
// over every project the engine holds. Each assertion here is a "never do this" as much as a
// "do this" — the pass runs unattended from the daemon, so declining is the default.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiIndex } from "../src/engine/db.ts";
import {
  DEFAULT_EVICT_AFTER_DAYS,
  DEFAULT_ORPHAN_GRACE_DAYS,
  INDEX_STORE_POLICY,
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
});
