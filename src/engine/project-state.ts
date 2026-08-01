// Per-project DERIVED state, held by the engine instead of by the project.
//
// Everything under a repository's old `.llmwiki/` — the search index, its cache, the review and
// consolidation watermarks, the gap-queue state, recovery and distill snapshots — is state ABOUT
// a project, not content OF it. Keeping it inside the worktree cost three things at once:
//
//   1. It could be committed. The `.gitignore` line the skeleton seeds is a convention, and a
//      convention has holes: `llmwiki index` on a repository whose skeleton never ran created
//      `.llmwiki/` anyway, unignored, and `git add -A` staged a multi-megabyte binary. One
//      teammate doing that gives everyone binary merge conflicts in a file that cannot merge.
//   2. Nobody owned its lifecycle. The engine had no way to enumerate indexes it had created, so
//      the daemon could not compact or evict them; the only maintenance path was a human running
//      /wiki-deep inside that specific repository, which for most repositories never happens.
//      Measured on the author's machine: four indexes, live indexed bytes 5–16% of file size,
//      one of them 8.9MB and untouched for days, and the compaction policy's 30 MiB floor meant
//      none of them would ever become eligible.
//   3. It inherited the worktree's permissions (0755), while the index stores real source text.
//
// So derived state moves to `$STATE/projects/<id>/`, one directory per worktree, never merged:
// physical isolation between projects is what makes a scope bug in search impossible rather than
// unlikely, and one file per project keeps writers off each other.
//
// IDENTITY. The id lives in a SIDECAR file next to the enrollment marker
// (`<worktree-git-dir>/llmwiki/index-id`) — deliberately NOT inside the marker itself. The marker
// is the consent gate and its validator rejects unknown keys ("an extra key — is disabled"), so
// adding a field there would make every OLDER engine read the repository as un-enrolled and stop
// capturing it, silently, until every clone and every running daemon had been upgraded together.
// A separate file is invisible to those versions. Living under `.git/` gives the id the two
// properties it needs and nothing else does: `git clone` cannot deliver it (a teammate gets their
// own index), and `mv` carries it (a moved project keeps its state).
//
// NON-GIT DIRECTORIES keep the legacy in-repo layout. The central store exists to keep derived
// state out of git and to give the engine something it can enumerate; a directory with no git has
// nothing to pollute, no place to put a sidecar, and is nearly always a test fixture or a scratch
// checkout. One contract, stated plainly: git worktrees get engine-held state.
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { MARKER_DIR, worktreeGitDir } from "./enrollment.ts";
import { canonicalRoot, ensureRepoDir, readRepoFile, writeRepoFile } from "./repo-write.ts";
import { ensureOwnedStateRoot, effectiveStateRoot, PROJECTS_DIR_NAME } from "./state-dir.ts";

/** The id sidecar, next to the enrollment marker but never inside it. */
export const INDEX_ID_BASENAME = "index-id";
/** Per-project self-description: which worktree this directory belongs to, and when it was used. */
export const PROJECT_META_BASENAME = "meta.json";
export const PROJECT_META_VERSION = 1;
/** 32 lowercase hex characters. Not a path, cannot traverse, cannot collide by accident. */
const ID_RE = /^[0-9a-f]{32}$/;
const ID_MAX_BYTES = 64;
const META_MAX_BYTES = 4096;
/** The legacy in-repo directory, still used by non-git directories and read during migration. */
export const LEGACY_STATE_DIR = ".llmwiki";

const POSIX = process.platform !== "win32";

/**
 * Regenerable from the repository at any time — safe for the daemon to evict. `refs.ts` re-registers
 * cited transcripts on every index build, so even provenance survives a deleted index.
 */
export const REGENERABLE_ENTRIES = ["index.db", "index.db-wal", "index.db-shm", "cache"] as const;
/**
 * Durable: watermarks and cooldowns that cannot be recomputed from the repository. Migrated, never
 * evicted; removed only when the project itself is gone.
 */
export const DURABLE_ENTRIES = [
  "gap-queue-state.json",
  "maintenance-state.json",
  "review-state.json",
  "consolidated.json",
  "recovery",
  "distill",
  "bench",
] as const;

export type ProjectMeta = {
  readonly version: number;
  readonly worktree: string;
  readonly lastUsed: string;
};

export type ProjectStateEntry = {
  readonly id: string;
  readonly dir: string;
  readonly worktree: string | null;
  readonly lastUsed: string | null;
  /** The recorded worktree no longer exists or no longer claims this id. */
  readonly orphaned: boolean;
  readonly bytes: number;
};

/** Resolving state must never be mistaken for "not a git worktree". */
export class ProjectStateError extends Error {}

// `git rev-parse` costs a process spawn; state paths are resolved many times per command.
const gitDirCache = new Map<string, string | null>();
const migrated = new Set<string>();

/**
 * The worktree-specific git directory, WITHOUT spawning git in the common case.
 *
 * This is deliberately not just `worktreeGitDir()`. That function answers null both for "this is
 * not a git worktree" and for "git could not be run", and here those must not be the same answer:
 * treating a transient spawn failure as "no git" silently relocates every project's state to the
 * legacy in-repo path, so an index that exists appears to have vanished. That is precisely the
 * silent-failure shape this engine exists to avoid, and it reproduced under load — a full test
 * run spawns git often enough that one failure made a subprocess look at the wrong directory and
 * find no index at all.
 *
 * A normal repository answers from a single lstat: `.git` as a directory IS the git dir. Only a
 * linked worktree (where `.git` is a file pointing elsewhere) needs git, and there a failure to
 * run it throws rather than guessing.
 */
function cachedGitDir(worktree: string): string | null {
  const hit = gitDirCache.get(worktree);
  if (hit !== undefined) return hit;
  const dotGit = join(worktree, ".git");
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    gitDirCache.set(worktree, null); // genuinely not a worktree root
    return null;
  }
  let dir: string | null;
  if (st.isDirectory()) {
    dir = dotGit;
  } else {
    dir = worktreeGitDir(worktree);
    if (dir === null) {
      throw new ProjectStateError(
        `cannot resolve the git directory for ${worktree}: \`.git\` exists but git could not be run. ` +
          `Refusing to fall back to the legacy in-repo layout, which would hide this project's index.`,
      );
    }
  }
  gitDirCache.set(worktree, dir);
  return dir;
}

/** Test/embedded-process reset; production never needs it. */
export function resetProjectStateCache(): void {
  gitDirCache.clear();
  migrated.clear();
}

// ---- primitive private I/O ---------------------------------------------------------------
// The state root is machine-local, so repo-write.ts (which enforces repository containment) does
// not apply. The guarantees it would have given are re-established here: no symlink is written
// through, directories are 0700, files are 0600, and every write is atomic.

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort on exotic filesystems */
    }
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function readPrivateFile(path: string, maxBytes: number): string | null {
  try {
    if (!isRegularFile(path)) return null; // a symlink where a file belongs is never ours
    const st = statSync(path);
    if (st.size > maxBytes) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* leave nothing behind on failure */
    }
    throw err;
  }
}

// ---- identity ------------------------------------------------------------------------------

function sidecarPath(gitDir: string): string {
  return join(gitDir, MARKER_DIR, INDEX_ID_BASENAME);
}

function readSidecarId(gitDir: string): string | null {
  const raw = readPrivateFile(sidecarPath(gitDir), ID_MAX_BYTES);
  if (raw === null) return null;
  const id = raw.trim();
  return ID_RE.test(id) ? id : null;
}

function writeSidecarId(gitDir: string, id: string): void {
  const dir = join(gitDir, MARKER_DIR);
  mkdirPrivate(dir);
  writePrivateFile(sidecarPath(gitDir), `${id}\n`);
}

function newId(): string {
  return randomUUID().replace(/-/g, "");
}

function projectsRoot(): string {
  return join(effectiveStateRoot(), PROJECTS_DIR_NAME);
}

function dirForId(id: string): string {
  return join(projectsRoot(), id);
}

function readMeta(dir: string): ProjectMeta | null {
  const raw = readPrivateFile(join(dir, PROJECT_META_BASENAME), META_MAX_BYTES);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" && value !== null &&
      "version" in value && value.version === PROJECT_META_VERSION &&
      "worktree" in value && typeof value.worktree === "string" &&
      "lastUsed" in value && typeof value.lastUsed === "string"
    ) {
      return value as ProjectMeta;
    }
  } catch {
    return null;
  }
  return null;
}

function writeMeta(dir: string, worktree: string, now = new Date()): void {
  writePrivateFile(
    join(dir, PROJECT_META_BASENAME),
    JSON.stringify({ version: PROJECT_META_VERSION, worktree, lastUsed: now.toISOString() }) + "\n",
  );
}

/**
 * Does another live worktree still claim this id? Then this one is a COPY (`cp -r` carries `.git/`)
 * and must not share the original's state — two worktrees writing one index interleaves two
 * projects' documents. A recorded worktree that is simply GONE is a move, and a move keeps its
 * state. Positive evidence of the original still holding the id, never absence of evidence.
 */
function idIsHeldElsewhere(id: string, recordedWorktree: string, currentWorktree: string): boolean {
  if (recordedWorktree === currentWorktree) return false;
  let otherGitDir: string | null;
  try {
    otherGitDir = cachedGitDir(recordedWorktree);
  } catch {
    return true; // cannot prove the original released the id → do not take it over
  }
  if (otherGitDir === null) return false; // recorded path is gone or no longer a worktree → moved
  return readSidecarId(otherGitDir) === id;
}

// ---- resolution ----------------------------------------------------------------------------

export type ProjectStateLocation = {
  /** Absolute directory holding this project's derived state. */
  readonly dir: string;
  /** null for a non-git directory, which keeps the legacy in-repo layout. */
  readonly id: string | null;
  readonly central: boolean;
};

/**
 * Where this worktree's derived state lives — PURE. Returns null for a git worktree that has no
 * identity yet, because minting one writes a sidecar, and several callers (turncontext's "no index
 * yet → stay silent, never create state") depend on asking without creating.
 */
export function resolveProjectStateLocation(root: string): ProjectStateLocation | null {
  const worktree = canonicalRoot(root);
  const gitDir = cachedGitDir(worktree);
  if (gitDir === null) {
    return { dir: join(worktree, LEGACY_STATE_DIR), id: null, central: false };
  }
  const id = readSidecarId(gitDir);
  if (id === null) return null;
  const meta = readMeta(dirForId(id));
  // A copy (`cp -r` carries `.git/`) must not read the original's state either.
  if (meta !== null && idIsHeldElsewhere(id, meta.worktree, worktree)) return null;
  return { dir: dirForId(id), id, central: true };
}

/** Where this worktree's derived state lives, MINTING an identity when it has none. */
export function projectStateLocation(root: string): ProjectStateLocation {
  const existing = resolveProjectStateLocation(root);
  if (existing !== null) return existing;
  const worktree = canonicalRoot(root);
  const gitDir = cachedGitDir(worktree);
  if (gitDir === null) {
    return { dir: join(worktree, LEGACY_STATE_DIR), id: null, central: false };
  }
  // A lost sidecar (re-clone, deleted .git/llmwiki) should reclaim its own directory rather than
  // orphan it. Only on the mint path, so the common case stays a single small file read.
  const id = adoptExistingStateFor(worktree) ?? newId();
  writeSidecarId(gitDir, id);
  return { dir: dirForId(id), id, central: true };
}

function adoptExistingStateFor(worktree: string): string | null {
  for (const entry of listProjectStates()) {
    if (entry.worktree === worktree) return entry.id;
  }
  return null;
}

/**
 * The directory, created and stamped. Migrates a legacy in-repo directory on first use.
 *
 * The legacy branch still goes through repo-write: that path IS inside the user's repository, so
 * the containment and symlink refusals it enforces still have to apply — a `.llmwiki` symlink
 * planted by someone else's commit must not be written through just because this module also
 * knows how to write privately.
 */
export function ensureProjectStateDir(root: string, ...relative: string[]): string {
  const location = projectStateLocation(root);
  if (!location.central) {
    ensureRepoDir(root, LEGACY_STATE_DIR);
    return ensureRepoDir(root, join(LEGACY_STATE_DIR, ...relative));
  }
  // The ownership contract first, ALWAYS: creating projects/ in a directory that has no marker
  // yet turns the state root into something the next `ensureOwnedStateRoot` refuses to adopt —
  // a foreign entry of our own making, and capture stops with it.
  ensureOwnedStateRoot(effectiveStateRoot());
  mkdirPrivate(location.dir);
  migrateLegacyState(root, location.dir);
  writeMeta(location.dir, canonicalRoot(root));
  const target = relative.length > 0 ? join(location.dir, ...relative) : location.dir;
  mkdirPrivate(target);
  return target;
}

/**
 * Absolute path of a derived-state entry, creating NOTHING. Before an identity exists the answer
 * is the legacy in-repo location: either it holds the state (about to be migrated) or it does not
 * exist, and "does not exist" is exactly what a caller probing for an index should see.
 */
export function projectStatePath(root: string, ...relative: string[]): string {
  const location = resolveProjectStateLocation(root);
  const dir = location?.dir ?? join(canonicalRoot(root), LEGACY_STATE_DIR);
  return relative.length > 0 ? join(dir, ...relative) : dir;
}

/** Absolute path with the directory created and the identity minted. For writers. */
export function ensureProjectStatePath(root: string, ...relative: string[]): string {
  ensureProjectStateDir(root);
  const { dir } = projectStateLocation(root);
  return relative.length > 0 ? join(dir, ...relative) : dir;
}

export function readProjectState(root: string, name: string, maxBytes = 8 * 1024 * 1024): string | null {
  const location = resolveProjectStateLocation(root);
  if (location === null) return readRepoFile(root, join(LEGACY_STATE_DIR, name)); // pre-migration
  if (!location.central) return readRepoFile(root, join(LEGACY_STATE_DIR, name));
  return readPrivateFile(join(location.dir, name), maxBytes);
}

export function writeProjectState(root: string, name: string, content: string): void {
  const location = projectStateLocation(root);
  if (!location.central) {
    ensureRepoDir(root, LEGACY_STATE_DIR);
    writeRepoFile(root, join(LEGACY_STATE_DIR, name), content);
    return;
  }
  ensureProjectStateDir(root);
  writePrivateFile(join(location.dir, name), content);
}

export function projectStateExists(root: string, ...relative: string[]): boolean {
  try {
    lstatSync(projectStatePath(root, ...relative));
    return true;
  } catch {
    return false;
  }
}

/** Touch `lastUsed` so eviction measures activity, not creation. Cheap and idempotent. */
export function markProjectUsed(root: string, now = new Date()): void {
  const location = resolveProjectStateLocation(root);
  if (location === null || !location.central) return;
  try {
    mkdirPrivate(location.dir);
    writeMeta(location.dir, canonicalRoot(root), now);
  } catch {
    /* bookkeeping must never break a command */
  }
}

// ---- legacy migration ------------------------------------------------------------------------

/**
 * Move a repository's old `.llmwiki/` into the engine-held directory: durable files are MOVED,
 * regenerable ones are dropped (rebuilding an index costs seconds and is the only fully verified
 * path — copying a live SQLite file with its WAL is not). Failure leaves the legacy directory
 * exactly as it was; a half-migrated project is worse than an un-migrated one.
 */
export function migrateLegacyState(root: string, centralDir: string): boolean {
  const worktree = canonicalRoot(root);
  if (migrated.has(worktree)) return false;
  migrated.add(worktree);
  const legacy = join(worktree, LEGACY_STATE_DIR);
  let names: string[];
  try {
    if (!lstatSync(legacy).isDirectory()) return false;
    names = readdirSync(legacy);
  } catch {
    return false;
  }
  let moved = 0;
  for (const name of names) {
    const from = join(legacy, name);
    if ((REGENERABLE_ENTRIES as readonly string[]).includes(name)) {
      try {
        rmSync(from, { recursive: true, force: true });
      } catch {
        /* leave it; the directory simply is not removed below */
      }
      continue;
    }
    if (!(DURABLE_ENTRIES as readonly string[]).includes(name)) continue; // foreign: never touch
    const to = join(centralDir, name);
    try {
      if (lstatSync(to)) continue; // already migrated: the central copy wins
    } catch {
      /* absent, proceed */
    }
    try {
      renameSync(from, to);
      moved += 1;
    } catch {
      /* cross-device or racing writer: leave the legacy copy in place */
    }
  }
  try {
    rmdirSync(legacy); // empty-only by construction: anything unrecognized stays, and so does it
  } catch {
    /* something unrecognized remains — correct to keep it */
  }
  return moved > 0;
}

// ---- enumeration (what makes maintenance possible at all) --------------------------------------

function dirBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isDirectory()) total += dirBytes(path);
      else if (st.isFile()) total += st.size;
    } catch {
      /* vanished mid-scan */
    }
  }
  return total;
}

/** Every project directory the engine holds. The registry IS the directory — no second source. */
export function listProjectStates(): ProjectStateEntry[] {
  const root = projectsRoot();
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const out: ProjectStateEntry[] = [];
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const dir = join(root, id);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readMeta(dir);
    const worktree = meta?.worktree ?? null;
    let orphaned = true;
    if (worktree !== null) {
      try {
        const gitDir = cachedGitDir(worktree);
        orphaned = gitDir === null || readSidecarId(gitDir) !== id;
      } catch {
        orphaned = false; // unresolvable is not the same as gone; never collect on doubt
      }
    }
    out.push({ id, dir, worktree, lastUsed: meta?.lastUsed ?? null, orphaned, bytes: dirBytes(dir) });
  }
  return out;
}

/**
 * Set a corrupt index aside instead of deleting it: rebuilding is cheap, but the quarantined file
 * is the only copy of whatever the last pass saw. Returns the paths actually moved.
 */
export function quarantineProjectState(root: string, names: readonly string[], stamp: string): string[] {
  const recovery = ensureProjectStateDir(root, "recovery");
  const moved: string[] = [];
  for (const name of names) {
    const from = projectStatePath(root, name);
    if (!isRegularFile(from)) continue;
    const to = join(recovery, `${name}.${stamp}.bak`);
    try {
      renameSync(from, to);
      moved.push(to);
    } catch {
      /* busy or vanished: leave it, the caller rebuilds regardless */
    }
  }
  return moved;
}

/** Drop only the regenerable entries. The project keeps its watermarks and recovery snapshots. */
export function evictRegenerable(dir: string): number {
  let freed = 0;
  for (const name of REGENERABLE_ENTRIES) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      freed += st.isDirectory() ? dirBytes(path) : st.size;
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* absent */
    }
  }
  return freed;
}

/** Remove a whole project directory. Callers must have established that it is an orphan. */
export function removeProjectState(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
