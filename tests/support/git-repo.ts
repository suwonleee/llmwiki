// Shared fixtures for the enrollment boundary.
//
// Automatic integration is git-only and per-worktree, so almost every security test needs a
// REAL temporary git worktree rather than a bare mkdtemp directory. Keeping that here means one
// place decides how a fixture repo is built (isolated identity, no global config leakage, an
// initial commit so `git worktree add` works).
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enroll, resetEnrollmentCache } from "../../src/engine/enrollment.ts";

export function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr ?? ""}`);
}

/** A temp dir whose path is already canonical (macOS /var → /private/var), like the engine sees it. */
export function tempDir(prefix = "llmwiki-t-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** An initialized git worktree with a deterministic identity and one empty commit. */
export function makeGitRepo(dir: string): string {
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr ?? ""}`);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "llmwiki fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // Isolate from the developer's global hooks: a machine-level `core.hooksPath` (a commit-message
  // policy, a linter) would otherwise decide whether these fixtures can be built at all. Local
  // config, so it also covers linked worktrees and any git the engine runs inside this fixture.
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "root"]);
  return dir;
}

/** A git worktree that has been through `llmwiki init`'s enrollment step. */
export function enrollRepo(dir: string): string {
  const result = enroll(dir);
  if (!result.ok) throw new Error(`enroll failed: ${result.error}`);
  resetEnrollmentCache();
  return dir;
}

/** The common case: temp dir → git worktree → enrolled. */
export function makeEnrolledRepo(prefix = "llmwiki-repo-"): string {
  return enrollRepo(makeGitRepo(tempDir(prefix)));
}
