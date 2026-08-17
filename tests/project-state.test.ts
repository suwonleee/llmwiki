// Engine-held per-project state: identity, isolation, migration, and the two ways it must fail.
//
// The behaviours pinned here are the ones that decide whether moving derived state out of the
// repository was safe. Each of them broke at least once while it was being built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiIndex } from "../src/engine/db.ts";
import {
  DURABLE_ENTRIES,
  LEGACY_STATE_DIR,
  REGENERABLE_ENTRIES,
  evictRegenerable,
  listProjectStates,
  projectStatePath,
  resetProjectStateCache,
  resolveProjectStateLocation,
  writeProjectState,
  readProjectState,
} from "../src/engine/project-state.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

let stateRoot: string;
const made: string[] = [];

function seedWiki(repo: string): void {
  const dir = join(repo, "docs", "wiki", "3_decision");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "page.md"),
    "---\ntitle: Page\n---\n" + "the deployment pipeline gates each rollout stage. ".repeat(10),
  );
}

function newRepo(prefix = "llmwiki-ps-"): string {
  const repo = enrollRepo(makeGitRepo(tempDir(prefix)));
  made.push(repo);
  seedWiki(repo);
  return repo;
}

function sidecar(repo: string): string {
  return join(repo, ".git", "llmwiki", "index-id");
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "llmwiki-ps-state-"));
  setEffectiveStateRoot(stateRoot);
  resetProjectStateCache();
});

afterEach(() => {
  setEffectiveStateRoot(null);
  resetProjectStateCache();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("engine-held project state", () => {
  test("indexing writes nothing into the repository — the whole point of the layout", () => {
    const repo = newRepo();
    new WikiIndex(repo).indexAll();

    expect(existsSync(join(repo, LEGACY_STATE_DIR))).toBe(false);
    const location = resolveProjectStateLocation(repo)!;
    expect(location.central).toBe(true);
    expect(existsSync(join(location.dir, "index.db"))).toBe(true);
    // The id is under .git/: a clone cannot deliver it, a commit cannot carry it.
    expect(existsSync(sidecar(repo))).toBe(true);
  });

  test("the store is private even though the repository is not", () => {
    const repo = newRepo();
    new WikiIndex(repo).indexAll();
    const location = resolveProjectStateLocation(repo)!;

    expect(statSync(location.dir).mode & 0o077).toBe(0);
    expect(statSync(sidecar(repo)).mode & 0o077).toBe(0);
  });

  test("a MOVED project keeps its state; meta follows the new path", () => {
    const repo = newRepo();
    new WikiIndex(repo).indexAll();
    const before = readFileSync(sidecar(repo), "utf-8").trim();

    const moved = `${repo}-moved`;
    renameSync(repo, moved);
    made.push(moved);
    resetProjectStateCache();
    new WikiIndex(moved).indexAll();

    expect(readFileSync(sidecar(moved), "utf-8").trim()).toBe(before);
    const meta = JSON.parse(readFileSync(join(projectStatePath(moved), "meta.json"), "utf-8"));
    expect(meta.worktree).toBe(realpathSync(moved));
  });

  test("a COPIED project gets its own state — two worktrees never share one index", () => {
    const repo = newRepo();
    new WikiIndex(repo).indexAll();
    const originalId = readFileSync(sidecar(repo), "utf-8").trim();

    const copy = `${repo}-copy`;
    cpSync(repo, copy, { recursive: true });
    made.push(copy);
    resetProjectStateCache();
    new WikiIndex(copy).indexAll();

    expect(readFileSync(sidecar(copy), "utf-8").trim()).not.toBe(originalId);
    expect(listProjectStates().length).toBe(2);
  });

  test("a legacy .llmwiki/ migrates: durable files move, regenerable ones rebuild", () => {
    const repo = newRepo();
    const legacy = join(repo, LEGACY_STATE_DIR);
    mkdirSync(join(legacy, "recovery"), { recursive: true });
    writeFileSync(join(legacy, "gap-queue-state.json"), '{"version":1,"resolved":[]}');
    writeFileSync(join(legacy, "recovery", "old.bak"), "snapshot");
    writeFileSync(join(legacy, "index.db"), "not-really-a-database");

    new WikiIndex(repo).indexAll();

    expect(existsSync(legacy)).toBe(false); // nothing left behind in the repository
    const dir = projectStatePath(repo);
    expect(readFileSync(join(dir, "gap-queue-state.json"), "utf-8")).toContain('"version":1');
    expect(readFileSync(join(dir, "recovery", "old.bak"), "utf-8")).toBe("snapshot");
    // The stale index was NOT carried over; a real one was built in its place.
    expect(readFileSync(join(dir, "index.db"))).not.toContain("not-really-a-database");
  });

  test("an unrecognized file in a legacy directory is never touched", () => {
    const repo = newRepo();
    const legacy = join(repo, LEGACY_STATE_DIR);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "someone-elses.txt"), "keep me");

    new WikiIndex(repo).indexAll();

    expect(readFileSync(join(legacy, "someone-elses.txt"), "utf-8")).toBe("keep me");
  });

  test("eviction drops only what can be rebuilt", () => {
    const repo = newRepo();
    new WikiIndex(repo).indexAll();
    writeProjectState(repo, "review-state.json", '{"date":"2026-08-01"}');
    const dir = projectStatePath(repo);

    const freed = evictRegenerable(dir);

    expect(freed).toBeGreaterThan(0);
    for (const name of REGENERABLE_ENTRIES) expect(existsSync(join(dir, name))).toBe(false);
    expect(readProjectState(repo, "review-state.json")).toContain("2026-08-01");
    // …and the index comes back on demand, which is what makes eviction safe.
    new WikiIndex(repo).indexAll();
    expect(existsSync(join(dir, "index.db"))).toBe(true);
  });

  test("a project whose worktree is gone reads as an orphan; a live one never does", () => {
    const live = newRepo();
    new WikiIndex(live).indexAll();
    const gone = newRepo();
    new WikiIndex(gone).indexAll();
    rmSync(gone, { recursive: true, force: true });
    resetProjectStateCache();

    const entries = listProjectStates();
    const liveEntry = entries.find((e) => e.worktree === realpathSync(live));
    expect(liveEntry?.orphaned).toBe(false);
    expect(entries.filter((e) => e.orphaned).length).toBe(1);
  });

  test("probing for state creates none — a silent turn must stay silent", () => {
    const repo = newRepo();

    expect(resolveProjectStateLocation(repo)).toBeNull();
    const probed = projectStatePath(repo, "index.db");

    expect(existsSync(probed)).toBe(false);
    expect(existsSync(sidecar(repo))).toBe(false); // no identity minted by asking
    expect(listProjectStates().length).toBe(0);
  });

  test("a non-git directory keeps the legacy in-repo layout", () => {
    const plain = mkdtempSync(join(tmpdir(), "llmwiki-ps-nogit-"));
    made.push(plain);
    seedWiki(plain);

    const location = resolveProjectStateLocation(plain)!;

    expect(location.central).toBe(false);
    expect(location.dir).toBe(join(realpathSync(plain), LEGACY_STATE_DIR));
  });

  test("the durable and regenerable lists do not overlap", () => {
    const overlap = DURABLE_ENTRIES.filter((n) => (REGENERABLE_ENTRIES as readonly string[]).includes(n));
    expect(overlap).toEqual([]);
  });
});

describe("state root override", () => {
  test("is visible to child processes, or a parent's index is invisible to its own CLI", () => {
    // Regression: setEffectiveStateRoot used to be process-local. Once the index moved under the
    // state root, a parent that overrode it wrote where its subprocess could not look, and the
    // subprocess answered "no index" — silence indistinguishable from having nothing to say.
    setEffectiveStateRoot(null); // start from no override — this setter has one save slot, not a stack
    const before = process.env.LLMWIKI_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-ps-env-"));
    try {
      setEffectiveStateRoot(dir);
      expect(process.env.LLMWIKI_STATE_DIR).toBe(dir);
    } finally {
      setEffectiveStateRoot(null);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(process.env.LLMWIKI_STATE_DIR).toBe(before); // restored, not clobbered
    setEffectiveStateRoot(stateRoot); // put the suite's own override back for afterEach
  });

  test("clearing an override that was never installed leaves the environment alone", () => {
    // Regression, measured: a full `bun test` run wrote 10 project directories into the
    // developer's real ~/.local/share/llmwiki. Several suites clear the override in an
    // afterAll without having set one in that flow; clearing used to DELETE the variable,
    // which removed the temp root tests/support/preload.ts pins. Every later test file — and
    // every subprocess inheriting the env — then resolved the machine default and wrote there.
    // Nothing was saved, so there is nothing to undo: the variable must survive untouched.
    setEffectiveStateRoot(null); // drain the single save slot so nothing of ours is pending
    const pinned = mkdtempSync(join(tmpdir(), "llmwiki-ps-pinned-"));
    made.push(pinned);
    const before = process.env.LLMWIKI_STATE_DIR;
    process.env.LLMWIKI_STATE_DIR = pinned;
    try {
      setEffectiveStateRoot(null);
      expect(process.env.LLMWIKI_STATE_DIR).toBe(pinned);
    } finally {
      if (before === undefined) delete process.env.LLMWIKI_STATE_DIR;
      else process.env.LLMWIKI_STATE_DIR = before;
    }
    setEffectiveStateRoot(stateRoot); // put the suite's own override back for afterEach
  });
});
