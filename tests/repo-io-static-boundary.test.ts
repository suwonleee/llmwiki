// A boundary is only worth as much as the code that actually uses it.
//
// Every repository read and write is supposed to go through repo-write.ts, but nothing stops the
// next change from calling writeFileSync directly on a path built from a repository root — and
// that is precisely how the leaf-symlink-only check survived for months. This test is the drift
// guard: any file that touches the filesystem API directly must appear in the allowlist below
// with a reason, so adding one is a review decision rather than an accident.
//
// It is deliberately dumb (text scan, no AST): a rename or a re-export cannot slip past it, and
// the failure message tells the next person exactly what to do.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

const MUTATORS = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "rmSync",
  "unlinkSync",
  "symlinkSync",
  "copyFileSync",
  "chmodSync",
] as const;
const READERS = ["readFileSync", "readdirSync", "openSync", "existsSync", "statSync", "lstatSync"] as const;

// Why each file is allowed to call the filesystem directly. "repository content" NEVER appears
// here — that is the whole point: repository content goes through repo-write.ts.
const ALLOWED_MUTATORS: Record<string, string> = {
  "engine/repo-write.ts": "IS the repository boundary — the one place that may write repo content",
  "engine/enrollment.ts": "writes the enrollment marker under .git/, which is not repository content",
  "engine/state-dir.ts": "owns the machine-local state root (ownership marker, private modes, purge)",
  "engine/capture.ts": "removes expired transcript exports from the machine-local state root",
  "engine/sources/opencode.ts": "materializes OpenCode exports into the machine-local state root",
  "engine/turncontext.ts": "per-session scratch state in the OS temp dir, not in any repository",
  "engine/update-check.ts": "records the daily origin check in the machine-local state root; reads the engine clone's own package.json — never repository content",
  "engine/claude.ts": "creates and removes the throwaway cwd for a generative subprocess",
  "engine/doctor.ts": "repairs HARNESS configuration (~/.claude, ~/.codex), never a repository",
  "engine/bench.ts": "engine-development benchmark writing its own report next to the corpus",
  "engine/compare.ts": "engine-development A/B harness building disposable temp workspaces",
  "daemon/wire.ts": "installs/removes Claude Code hooks and commands in the user's harness config",
  "daemon/wire-codex.ts": "installs/removes Codex hooks, skills and launcher in the harness config",
  "daemon/wire-opencode.ts": "installs/removes the OpenCode plugin, commands and launcher",
};

const ALLOWED_READERS: Record<string, string> = {
  ...ALLOWED_MUTATORS,
  "cli.ts": "reads the optional team git-conventions doc from the engine clone",
  "engine/config.ts": "reads trusted engine-clone config templates, never repository content",
  "engine/db.ts": "reads the trusted engine-bundled schema.sql; repository indexing uses repo-write",
  "engine/consolidate.ts": "stats machine-local transcript files from the capture ledger",
  "engine/reconcile.ts": "stats machine-local transcript files after repository citations are read safely",
  "engine/context.ts": "stats machine-local transcript files for display metadata",
  "engine/lint.ts": "checks machine-local citation transcript paths; repository link probes use repo-write",
  "daemon/list-pending-repos.ts": "stats machine-local transcript files from the capture ledger",
  "daemon/watch.ts": "stats machine-local transcript files while routing capture work",
  "engine/session-lang.ts": "reads harness transcripts to detect the session language",
  "engine/distill.ts": "reads the two snapshots handed to distill-verify explicitly",
  "engine/extract.ts": "reads machine-local transcripts",
  "engine/sources/claude.ts": "reads machine-local Claude transcripts",
  "engine/sources/codex.ts": "reads machine-local Codex rollouts",
  "engine/sources/plain.ts": "reads the file an explicit `ingest` names",
  "engine/sources/routing.ts": "bounded routing reads over machine-local transcripts",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function callsIn(text: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(text));
}

function scan(names: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path).replace(/\\/g, "/");
    const calls = callsIn(readFileSync(path, "utf-8"), names);
    if (calls.length) found.set(rel, calls);
  }
  return found;
}

describe("repository I/O boundary (static)", () => {
  test("no unreviewed module writes to the filesystem directly", () => {
    const offenders: string[] = [];
    for (const [file, calls] of scan(MUTATORS)) {
      if (file in ALLOWED_MUTATORS) continue;
      offenders.push(`${file} calls ${calls.join(", ")}`);
    }
    expect(
      offenders,
      "Repository content must be written through src/engine/repo-write.ts (writeRepoFile / " +
        "appendRepoFile / ensureRepoDir / removeRepoFile / renameRepoPath), which validates the " +
        "canonical root, refuses leaf AND ancestor symlinks, and replaces atomically. If this " +
        "file genuinely writes machine-local state instead, add it to ALLOWED_MUTATORS with the " +
        "reason.",
    ).toEqual([]);
  });

  test("no unreviewed module reads from the filesystem directly", () => {
    const offenders: string[] = [];
    for (const [file, calls] of scan(READERS)) {
      if (file in ALLOWED_READERS) continue;
      offenders.push(`${file} calls ${calls.join(", ")}`);
    }
    expect(
      offenders,
      "Repository content must be read through src/engine/repo-write.ts (readRepoFile / " +
        "readRepoDir / repoFileExists), so a symlinked page reads as absent instead of copying " +
        "someone else's file into the wiki. Add machine-local readers to ALLOWED_READERS with a reason.",
    ).toEqual([]);
  });

  test("the allowlists carry no stale entries", () => {
    const mutating = scan(MUTATORS);
    const reading = scan(READERS);
    const stale = Object.keys(ALLOWED_MUTATORS).filter((f) => !mutating.has(f));
    const staleReaders = Object.keys(ALLOWED_READERS).filter((f) => !mutating.has(f) && !reading.has(f));
    // A stale entry is an allowance nobody needs any more — remove it so the list keeps meaning
    // "these were reviewed", not "these were reviewed at some point in the past".
    expect({ stale, staleReaders }).toEqual({ stale: [], staleReaders: [] });
  });

  test("the automatic entry points are gated on enrollment", () => {
    // A grep-level guard for the ordering the plan turns on: the cold start must consult
    // enrollment BEFORE it resolves per-repo config (which reads repository files).
    const context = readFileSync(join(SRC, "engine", "context.ts"), "utf-8");
    const gate = context.indexOf("isEnrolled(repo)");
    const config = context.indexOf("getConfig(proj)");
    expect(gate).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(config);

    // …and the daemon must decide enrollment between routing and materialization.
    const watch = readFileSync(join(SRC, "daemon", "watch.ts"), "utf-8");
    expect(watch.indexOf("isEnrolled(route.repo)")).toBeGreaterThan(-1);
    expect(watch.indexOf("isEnrolled(route.repo)")).toBeLessThan(watch.indexOf("s.materialize(route)"));
  });
});

// A test may redirect HOME; it cannot redirect the developer's launchd session or process table.
// `setup.sh --uninstall` then does exactly what it promises — removes the per-user job and stops
// this clone's daemon — except the clone is the developer's checkout, so running the suite
// uninstalled their own capture loop. It passed green every time; the damage was only visible days
// later as "nothing has been captured". Any test that drives those scripts must neutralize the
// supervisor first, so the shape of that requirement is checked here rather than remembered.
describe("tests cannot reach the developer's supervisor", () => {
  test("every test that runs setup.sh or daemon/install.sh neutralizes launchctl", () => {
    const dir = join(import.meta.dir);
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
      const src = readFileSync(join(dir, file), "utf-8");
      const runsInstaller = /spawnSync\(\[[^\]]*(setup\.sh|install\.sh)/s.test(src) || /"setup\.sh"|"install\.sh"/.test(src);
      if (!runsInstaller) continue;
      // "mentions launchctl at all" is the heuristic: every neutralization in this suite defines a
      // shim by that name, whether as an object key, a tuple, or the shared helper.
      const neutralized = src.includes("inertSupervisorBin") || src.includes("launchctl");
      if (!neutralized) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
