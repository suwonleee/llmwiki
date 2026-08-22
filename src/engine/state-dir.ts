// Ownership, permissions and purge for the machine-local runtime state directory.
//
// `.state/` holds the capture queue (which repositories you work in, and when), the daemon log,
// and — for OpenCode — materialized plaintext transcripts. That is the most sensitive thing this
// engine keeps, and it was being created with whatever the process umask happened to be.
//
// Two rules make the rest follow:
//
//   1. WE ONLY TOUCH WHAT WE OWN. A state root is ours when it carries our ownership marker, or
//      when it is empty (nothing to be wrong about), or when it is the canonical clone-local
//      `.state` and every single entry in it validates as something this engine wrote, or when it
//      is a MOVED clone's root: a privately-moded marker of ours naming its old path, with every
//      other entry validating under the strict rules (movedCloneIsOurs — named logs only,
//      capture.db by schema, exports by content). Any other pre-existing directory someone pointed
//      LLMWIKI_STATE_DIR at is NEVER adopted, never recursively chmodded, and never purged — setup
//      and capture fail closed naming the entries that blocked adoption. Adopting it would mean
//      changing permissions on, and later deleting, files we have no reason to believe are ours.
//   2. PRIVATE BY CONSTRUCTION. An owned root and its export directory are 0700; the databases,
//      logs and exports inside are 0600. Not "usually" — enforced on every open.
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  cpSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { envValueOutsideRepoFiles } from "./env-policy.ts";

export const STATE_MARKER = ".llmwiki-state-v1.json";
export const STATE_MARKER_VERSION = 1;
export const STATE_MARKER_MAX_BYTES = 4096;

/** OpenCode exports are the only transcript BODIES this engine keeps. They expire. */
export const EXPORT_TTL_DAYS = 30;

export const EXPORT_DIR_NAME = "opencode-export";
/**
 * Per-project derived state, one subdirectory per enrolled worktree (engine/project-state.ts).
 * Like the export directory this is ours to create and ours to purge, so it belongs to the
 * ownership contract on both halves: recognized when adopting a root, removed by `--purge-data`.
 */
export const PROJECTS_DIR_NAME = "projects";
/** A project-state directory name: 32 lowercase hex characters (engine/project-state.ts). */
const PROJECT_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Everything an llmwiki-owned state root may contain — the purge allowlist, and nothing else.
 * This list is BOTH halves of the contract: an engine-written file missing from it is left behind
 * by `--purge-data` AND counts as a foreign entry when the canonical default root is adopted,
 * which is the silent-capture-death shape described just below. Adding a file here is therefore
 * part of adding a file to the state root, never a follow-up. Directories have their own entries
 * (EXPORT_DIR_NAME, PROJECTS_DIR_NAME) with content verification of their own.
 */
export const OWNED_FILES = [
  "capture.db",
  "capture.db-wal",
  "capture.db-shm",
  "daemon.log",
  "daemon.log.1",
  "update-check.json",
  "install-receipt.json",
  "harness-paths.json", // verified harness data locations (engine/harness-locate.ts)
] as const;
/**
 * Logs earlier versions of THIS engine wrote into its own clone-local `.state` (autodistill runs,
 * dry-run scans, and whatever a future pass names its log). Adoption of the canonical default has
 * to recognize them, or upgrading refuses the very directory llmwiki created: on the author's
 * machine three such files turned every sweep into `enqueued=0, failed=76` while doctor stayed
 * green. They are recognized, kept private, and left in place — never purged, since only
 * OWNED_FILES is the deletion allowlist.
 */
const LEGACY_OWNED_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.log$/;

const POSIX = process.platform !== "win32";
// A copy-truncate rotation can be killed after its private O_EXCL temp is durable but before the
// atomic rename. The strict name is part of the ownership contract: these files are tightened,
// recognized after a moved clone, and removed by --purge-data, while symlinks are never followed.
const ROTATION_TEMP_RE = /^\.daemon\.log\.1\.tmp-\d+-[a-z0-9]+$/;
let stateRootOverride: string | null = null;
/** "" means the variable was unset before the first override; undefined means no override is active. */
let savedStateDirEnv: string | undefined;

/**
 * The clone-local default every version through v0.10 used. Still honoured wherever it already
 * exists (see effectiveStateRoot) — moving somebody's live capture queue as a side effect of an
 * upgrade is exactly the kind of surprise this engine refuses to spring.
 */
export function legacyCloneStateRoot(): string {
  return join(CLONE_ROOT, ".state");
}

/**
 * The default for a NEW installation: outside the engine clone.
 *
 * The clone is meant to be disposable — people re-clone it, `git pull` it, and `git clean -xdf`
 * it — and once per-project derived state lives in the state root (project-state.ts), a disposable
 * clone would take every project's index with it. XDG_DATA_HOME is the platform's own answer to
 * "machine-local data that is not configuration".
 */
export function defaultStateRoot(): string {
  const xdg = envValueOutsideRepoFiles("XDG_DATA_HOME")?.trim();
  const base = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share");
  return join(base, "llmwiki");
}

/**
 * One process-wide state location, shared by capture, OpenCode exports, per-project state,
 * retention and purge.
 *
 * Resolution order, and why: an explicit `LLMWIKI_STATE_DIR` always wins (it is what the installed
 * service definition bakes in); otherwise an EXISTING clone-local `.state` keeps being used, so
 * upgrading never strands a queue; otherwise the new default. The sticky branch is what makes this
 * change safe to ship — the migration is offered by `doctor`, never performed behind the user.
 */
export function effectiveStateRoot(): string {
  if (stateRootOverride !== null) return stateRootOverride;
  const explicit = envValueOutsideRepoFiles("LLMWIKI_STATE_DIR")?.trim();
  if (explicit) return explicit;
  const legacy = legacyCloneStateRoot();
  if (hasOwnershipMarker(legacy)) return legacy;
  return defaultStateRoot();
}

/**
 * Test/embedded-process override. Production callers normally use LLMWIKI_STATE_DIR.
 *
 * The override is mirrored into the environment so CHILD processes resolve the same root. It used
 * to be process-local, which was harmless only as long as nothing under the state root mattered to
 * a subprocess. Per-project derived state (project-state.ts) lives there now, so a parent that
 * overrode the root wrote its index somewhere its own `llmwiki` subprocess could not see — the
 * subprocess found no index and stayed silent, which is indistinguishable from "nothing to say".
 * An override that half the processes cannot see is not an override.
 */
export function setEffectiveStateRoot(dir: string | null): void {
  stateRootOverride = dir;
  if (dir === null) {
    // `undefined` means no override was ever installed, so there is nothing of ours to undo and
    // the environment is somebody else's to keep. Deleting it here was a measured leak: several
    // suites clear the override in an afterAll, and doing so removed the variable the test
    // preload had pinned — after which every later file, and every subprocess they spawned,
    // resolved the machine default and wrote project state into the developer's real store.
    // "" is a different case: it is the sentinel for "the override replaced no variable at all",
    // and restoring that as an empty string would leave a variable resolving to nothing.
    if (savedStateDirEnv === "") delete process.env.LLMWIKI_STATE_DIR;
    else if (savedStateDirEnv !== undefined) process.env.LLMWIKI_STATE_DIR = savedStateDirEnv;
    savedStateDirEnv = undefined;
    return;
  }
  if (savedStateDirEnv === undefined) savedStateDirEnv = process.env.LLMWIKI_STATE_DIR ?? "";
  process.env.LLMWIKI_STATE_DIR = dir;
}

export function effectiveExportDir(): string {
  const root = effectiveStateRoot();
  try {
    return join(realpathSync(root), EXPORT_DIR_NAME);
  } catch {
    return join(root, EXPORT_DIR_NAME);
  }
}

export class StateRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateRootError";
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isRegular(path: string): boolean {
  const st = lstatOrNull(path);
  return st !== null && st.isFile();
}

function isRealDir(path: string): boolean {
  const st = lstatOrNull(path);
  return st !== null && st.isDirectory() && !st.isSymbolicLink();
}

function markerPath(root: string): string {
  return join(root, STATE_MARKER);
}

function markerTempName(pid: number | string, nonce: string): string {
  // The nonce makes O_EXCL collisions impossible even against a crashed peer that had our PID.
  return `.${STATE_MARKER}.tmp-${pid}-${nonce}`;
}

/**
 * The half-written marker of a CONCURRENT bootstrap, not a foreign file.
 *
 * On a fresh install the daemon, both session hooks and any `llmwiki` command can reach an empty
 * state root at the same moment. Whoever gets there second used to list the first one's exclusive
 * temp file, conclude the directory held something it could not account for, and throw — so a first
 * run under load failed for reasons that had nothing to do with the user's machine.
 *
 * Name shape alone is NOT enough to disregard an entry: a directory or symlink wearing this name
 * would otherwise make a non-empty root read as empty and get it adopted. In-flight means a regular
 * non-symlink file, written seconds ago — a bootstrap takes milliseconds, so anything older is a
 * crash leftover and counts as a real entry (the refusal then names it, which is actionable).
 */
const MARKER_TEMP_MAX_AGE_MS = 60_000;

function isMarkerTemp(root: string, name: string): boolean {
  const prefix = `.${STATE_MARKER}.tmp-`;
  if (!name.startsWith(prefix) || !/^\d+(-[a-z0-9]+)?$/.test(name.slice(prefix.length))) return false;
  const st = lstatOrNull(join(root, name));
  return (
    st !== null && st.isFile() && !st.isSymbolicLink() && Date.now() - st.mtimeMs < MARKER_TEMP_MAX_AGE_MS
  );
}

/** Entries that decide emptiness — a peer's in-flight marker write does not count. */
function settledEntries(root: string): string[] {
  return readdirSync(root).filter((name) => !isMarkerTemp(root, name));
}

export function stateMarkerBytes(root: string): string {
  return `{"version":${STATE_MARKER_VERSION},"root":${JSON.stringify(root)}}\n`;
}

function readBounded(path: string, cap: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (POSIX ? fsConstants.O_NOFOLLOW : 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > cap) return null;
    const buf = Buffer.alloc(cap);
    const n = readSync(fd, buf, 0, cap, 0);
    return buf.toString("utf-8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Is this root marked as one we created (and is the mark actually about THIS path)? */
export function hasOwnershipMarker(root: string): boolean {
  const path = markerPath(root);
  const st = lstatOrNull(path);
  if (st === null || !st.isFile() || st.isSymbolicLink()) return false;
  if (POSIX && (st.mode & 0o077) !== 0) return false;
  const text = readBounded(path, STATE_MARKER_MAX_BYTES);
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed as Record<string, unknown>).sort();
    if (keys.length !== 2 || keys[0] !== "root" || keys[1] !== "version") return false;
    const { version, root: recorded } = parsed as { version: unknown; root: unknown };
    return version === STATE_MARKER_VERSION && recorded === root;
  } catch {
    return false;
  }
}

function writeOwnershipMarker(root: string): void {
  const target = markerPath(root);
  const temp = join(root, markerTempName(process.pid, Date.now().toString(36)));
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    writeSync(fd, stateMarkerBytes(root));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (POSIX) chmodSync(target, 0o600);
}

function markerContentMatches(root: string): boolean {
  const path = markerPath(root);
  if (!isRegular(path)) return false;
  const text = readBounded(path, STATE_MARKER_MAX_BYTES);
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    return keys.length === 2 &&
      keys[0] === "root" &&
      keys[1] === "version" &&
      parsed.version === STATE_MARKER_VERSION &&
      parsed.root === root;
  } catch {
    return false;
  }
}

// ---- legacy adoption ----------------------------------------------------------------------
//
// Installations that predate the ownership marker have a perfectly real `.state` full of our own
// files. Refusing to run there would be a migration for no safety gain — but "it is at the
// default path" is not proof of authorship either, so every entry has to look like something
// this engine wrote before the marker is granted.

const EXPORT_NAME_RE = /^[A-Za-z0-9_.:-]+\.jsonl$/;
const META_NAME_RE = /^[A-Za-z0-9_.:-]+\.meta\.json$/;

function looksLikeOurCaptureDb(path: string): boolean {
  if (!isRegular(path)) return false;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    // The one capture.db open whose failure is NOT absorbed: `false` here becomes "capture.db is
    // foreign", which fails the whole state root. Without a busy timeout a daemon write transaction
    // during a first-run bootstrap turned a transient SQLITE_BUSY into exactly that hard refusal.
    db.exec("PRAGMA busy_timeout=5000");
    const cols = db.query("PRAGMA table_info(capture_queue)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    return names.has("transcript_path") && names.has("status") && names.has("repo");
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * A projects/ directory is ours when every entry is a hex-id directory holding our own meta file.
 * Same standard as the export directory: positive evidence of authorship, not merely the absence
 * of anything foreign.
 */
function looksLikeOurProjectsDir(dir: string): boolean {
  if (!isRealDir(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!PROJECT_ID_RE.test(name)) return false;
    const path = join(dir, name);
    if (!isRealDir(path)) return false;
    const meta = join(path, "meta.json");
    if (!isRegular(meta)) continue; // freshly created, not yet stamped
    const text = readBounded(meta, 4096);
    if (text === null) return false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed?.worktree !== "string") return false;
    } catch {
      return false;
    }
  }
  return true;
}

function looksLikeOurExportDir(dir: string): boolean {
  if (!isRealDir(dir)) return false;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!isRegular(path)) return false;
    if (META_NAME_RE.test(name)) {
      const text = readBounded(path, 64 * 1024);
      if (text === null) return false;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed?.lastSeq !== "number") return false;
      } catch {
        return false;
      }
      continue;
    }
    if (!EXPORT_NAME_RE.test(name)) return false;
    const head = readBounded(path, 64 * 1024);
    if (head === null) return false;
    try {
      const first = JSON.parse(head.split("\n", 1)[0] ?? "");
      if (first?.kind !== "opencode-meta") return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A well-formed marker of ours that names SOME root — possibly not this one.
 *
 * The distinction matters because a clone can legitimately change address: moved to another
 * directory, checked out at a different path on another machine, or bind-mounted into a container
 * at /w. In every one of those the state root is still ours and still holds only our files; only
 * the string inside the marker went stale.
 */
function markerIsWellFormed(root: string): boolean {
  const path = markerPath(root);
  const st = lstatOrNull(path);
  if (st === null || !st.isFile() || st.isSymbolicLink()) return false;
  // Same permission bar as hasOwnershipMarker: a group- or world-readable marker is one some OTHER
  // account could have written, and this function's verdict authorizes chmod and (via purge) delete.
  if (POSIX && (st.mode & 0o077) !== 0) return false;
  const text = readBounded(path, STATE_MARKER_MAX_BYTES);
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    return (
      keys.length === 2 &&
      keys[0] === "root" &&
      keys[1] === "version" &&
      parsed.version === STATE_MARKER_VERSION &&
      typeof parsed.root === "string"
    );
  } catch {
    return false;
  }
}

// Log names THIS engine has actually written, for the moved-clone path. The broad LEGACY_OWNED_FILE_RE
// (any *.log) exists for the canonical clone-local default, whose location itself is evidence; a
// moved root claims ownership by marker alone, so "some file ending in .log" must not count as ours
// there — that is exactly how a planted marker next to a victim's production.log passed adoption.
const MOVED_CLONE_LOG_RE = /^(daemon|autoupdate|autodistill[A-Za-z0-9_.-]*)\.log$/;

/**
 * Adoptable as a moved clone: our well-formed (and privately-moded) marker naming another path,
 * and every other entry validating as engine-written under the STRICT rules — named logs only,
 * capture.db checked by schema, exports checked by content. Renaming the clone directory, checking
 * out at a different path, and bind-mounting into a container all land here; a directory that
 * merely contains marker-shaped and log-shaped files does not.
 */
function movedCloneIsOurs(root: string): boolean {
  if (!markerIsWellFormed(root)) return false;
  const foreign = unownedEntries(root, { strictLogs: true });
  return foreign !== null && foreign.length === 0;
}

/** Entries of a state root that this engine is known to write. */
function unownedEntries(root: string, opts: { strictLogs?: boolean } = {}): string[] | null {
  const allowed = new Set<string>([...OWNED_FILES, EXPORT_DIR_NAME, PROJECTS_DIR_NAME]);
  // Our own marker is not a foreign file. When its recorded path is stale the caller decides what
  // to do about that — but listing it under "unrecognized" made the refusal name the one file in
  // the directory that proves the directory is ours, which sent people hunting for a foreign entry
  // that did not exist.
  if (markerIsWellFormed(root)) allowed.add(STATE_MARKER);
  const logRe = opts.strictLogs ? MOVED_CLONE_LOG_RE : LEGACY_OWNED_FILE_RE;
  let entries: string[];
  try {
    entries = settledEntries(root);
  } catch {
    return null;
  }
  const foreign: string[] = [];
  for (const name of entries) {
    const path = join(root, name);
    if (ROTATION_TEMP_RE.test(name)) {
      if (!isRegular(path)) foreign.push(name);
      continue;
    }
    if (name === EXPORT_DIR_NAME) {
      if (!looksLikeOurExportDir(path)) foreign.push(name);
      continue;
    }
    if (name === PROJECTS_DIR_NAME) {
      if (!looksLikeOurProjectsDir(path)) foreign.push(name);
      continue;
    }
    if (!allowed.has(name) && !logRe.test(name)) {
      foreign.push(name);
      continue;
    }
    if (!isRegular(path)) foreign.push(name);
  }
  if (entries.includes("capture.db") && !looksLikeOurCaptureDb(join(root, "capture.db"))) {
    foreign.push("capture.db");
  }
  return foreign;
}

/** Every entry validates as one this engine wrote. Only ever asked about the canonical default. */
function legacyDefaultIsOurs(root: string): boolean {
  const foreign = unownedEntries(root);
  return foreign !== null && foreign.length === 0;
}

function enforcePrivateModes(root: string): void {
  if (!POSIX) return;
  const tighten = (path: string, expected: number): void => {
    try {
      chmodSync(path, expected);
      const st = lstatSync(path);
      if (st.isSymbolicLink() || (st.mode & 0o777) !== expected) {
        throw new Error(`mode is ${(st.mode & 0o777).toString(8)}, expected ${expected.toString(8)}`);
      }
    } catch (error) {
      throw new StateRootError(
        `refusing to use llmwiki state without private permissions: ${path}\n  (${error})`,
      );
    }
  };
  tighten(root, 0o700);
  for (const name of [STATE_MARKER, ...OWNED_FILES]) {
    const path = join(root, name);
    if (isRegular(path)) tighten(path, 0o600);
  }
  // Older logs of ours record which repositories were swept and when — the same inventory the
  // current daemon.log holds, so they get the same private mode rather than whatever umask
  // created them years ago.
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (ROTATION_TEMP_RE.test(name)) {
      const path = join(root, name);
      if (isRegular(path)) tighten(path, 0o600);
      continue;
    }
    if (!LEGACY_OWNED_FILE_RE.test(name) || (OWNED_FILES as readonly string[]).includes(name)) continue;
    const path = join(root, name);
    if (isRegular(path)) tighten(path, 0o600);
  }
  const exportDir = join(root, EXPORT_DIR_NAME);
  if (isRealDir(exportDir)) {
    tighten(exportDir, 0o700);
    for (const artifact of validExportArtifacts(root)) {
      for (const path of [artifact.exportPath, artifact.metaPath]) {
        if (path === null) continue;
        tighten(path, 0o600);
      }
    }
  }
}

/**
 * Make `dir` usable as an llmwiki state root, or refuse. Returns the canonical root path.
 *
 * Throws StateRootError when the path exists but is not ours — the caller (capture, setup) turns
 * that into an actionable message rather than silently taking the directory over.
 */
export function ensureOwnedStateRoot(dir: string, opts: { defaultRoot?: string } = {}): string {
  const existing = lstatOrNull(dir);
  if (existing === null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const root = realpathSync(dir);
    if (POSIX) chmodSync(root, 0o700);
    writeOwnershipMarker(root);
    return root;
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new StateRootError(`llmwiki state path is not a directory: ${dir}`);
  }
  const root = realpathSync(dir);
  if (hasOwnershipMarker(root)) {
    enforcePrivateModes(root);
    return root;
  }
  // A valid marker whose permissions were loosened is repairable without adopting anything:
  // its exact content still proves this root was ours. Tighten it before touching other files.
  if (markerContentMatches(root)) {
    if (POSIX) chmodSync(markerPath(root), 0o600);
    enforcePrivateModes(root);
    return root;
  }
  const entries = settledEntries(root);
  if (entries.length === 0) {
    if (POSIX) chmodSync(root, 0o700);
    writeOwnershipMarker(root);
    return root;
  }
  // Non-empty and unmarked. Adoptable ONLY at the canonical clone-local default, and only when
  // every entry validates as ours.
  const defaultRoot = opts.defaultRoot ?? join(CLONE_ROOT, ".state");
  const isDefault = root === defaultRoot || (lstatOrNull(defaultRoot) !== null && realpathSync(defaultRoot) === root);
  if (isDefault && legacyDefaultIsOurs(root)) {
    writeOwnershipMarker(root);
    enforcePrivateModes(root);
    return root;
  }
  // Last chance before refusing: a peer that was mid-bootstrap when this process listed the
  // directory may have finished since. Re-asking costs one stat and turns a first-run race into the
  // ordinary owned-root path, which is what it always was.
  if (hasOwnershipMarker(root) || markerContentMatches(root)) {
    enforcePrivateModes(root);
    return root;
  }
  // The clone changed address. A privately-moded marker of ours naming a DIFFERENT root, in a
  // directory where every other entry validates as engine-written under the STRICT rules, means
  // this state root moved with the clone — renamed, checked out elsewhere, or bind-mounted into a
  // container at another path. Re-point the marker and carry on. The strict rules are the point:
  // the earlier version of this branch accepted any *.log as ours and skipped the marker's
  // permission check, which let a planted marker beside a victim's own log files authorize a chmod
  // and, later, a purge delete.
  if (movedCloneIsOurs(root)) {
    writeOwnershipMarker(root);
    enforcePrivateModes(root);
    return root;
  }
  // Name what actually blocked adoption. The old wording ("files this engine did not create")
  // was both unactionable and, for an upgrading user, untrue — it was usually llmwiki's own older
  // artifacts. Whoever hits this needs to know which entries to move, not a category.
  // Name the entries for ANY root, not just the canonical default. Whoever hits this needs to know
  // which files to move; "must name a new directory, an empty one, or one llmwiki already owns" is
  // a restatement of the rule, not an answer. The list is trustworthy now that our own marker is no
  // longer counted among them.
  const foreign = unownedEntries(root) ?? [];
  const named = foreign.length ? `\n  unrecognized: ${foreign.slice(0, 5).join(", ")}${foreign.length > 5 ? ", …" : ""}` : "";
  throw new StateRootError(
    `refusing to use a state root llmwiki cannot prove it owns: ${root}${named}\n` +
      (isDefault
        ? `  (move or delete the entries above — llmwiki only adopts its own artifacts, and never deletes what it did not create)`
        : `  (LLMWIKI_STATE_DIR must name a new directory, an empty one, or one llmwiki already owns)`),
  );
}

/**
 * Would `ensureOwnedStateRoot` accept this path? Answers without creating, marking or chmodding
 * anything, so `doctor` can report a state root it must not touch.
 *
 * Worth its own function because a refused state root is silent in production: capture throws
 * inside the daemon's per-session guard, the daemon logs and carries on, and every other surface
 * keeps working. Nothing surfaces it until someone asks.
 */
export function probeStateRoot(dir = effectiveStateRoot()): { usable: boolean; detail: string } {
  const existing = lstatOrNull(dir);
  if (existing === null) return { usable: true, detail: "not created yet — the first capture creates it" };
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    return { usable: false, detail: "not a directory" };
  }
  let root: string;
  try {
    root = realpathSync(dir);
  } catch (error) {
    return { usable: false, detail: `unreadable: ${error}` };
  }
  if (hasOwnershipMarker(root) || markerContentMatches(root)) return { usable: true, detail: "owned" };
  let entries: string[];
  try {
    entries = settledEntries(root);
  } catch (error) {
    return { usable: false, detail: `unreadable: ${error}` };
  }
  if (entries.length === 0) return { usable: true, detail: "empty — adoptable" };
  if (movedCloneIsOurs(root)) {
    return { usable: true, detail: "owned (marker re-pointed on use — the clone moved)" };
  }
  const defaultRoot = join(CLONE_ROOT, ".state");
  const isDefault =
    root === defaultRoot || (lstatOrNull(defaultRoot) !== null && realpathSync(defaultRoot) === root);
  if (!isDefault) {
    return { usable: false, detail: "LLMWIKI_STATE_DIR points at a non-empty directory llmwiki does not own" };
  }
  const foreign = unownedEntries(root) ?? [];
  if (foreign.length === 0) return { usable: true, detail: "adoptable (llmwiki's own artifacts only)" };
  return {
    usable: false,
    detail: `holds ${foreign.length} unrecognized entr${foreign.length === 1 ? "y" : "ies"}: ${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}`,
  };
}

/** Apply the private modes again — cheap, and called after SQLite creates WAL/SHM siblings. */
export function reassertPrivateModes(root: string): void {
  enforcePrivateModes(root);
}

/** Installer-safe bootstrap: prove ownership before creating the daemon log redirection target. */
export function bootstrapStateRoot(dir = effectiveStateRoot()): string {
  const root = ensureOwnedStateRoot(dir);
  const logPath = join(root, "daemon.log");
  const existing = lstatOrNull(logPath);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new StateRootError(`llmwiki daemon log path is not a regular file: ${logPath}`);
  }
  try {
    const fd = openSync(
      logPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        (POSIX ? fsConstants.O_NOFOLLOW : 0),
      0o600,
    );
    closeSync(fd);
  } catch (error) {
    // The point of this open is to CREATE the redirection target privately before a shell's `>>`
    // creates it with whatever the umask says. A file that is already there has already passed
    // that gate — and on Windows the running daemon holds daemon.log open through cmd's `>>` in a
    // share mode that denies every other writer, so re-running the installer while capture was up
    // died with EBUSY on the one file whose existence proves the last install worked. Narrow on
    // purpose: only a sharing violation, only on Windows, only when the path is already a regular
    // file — a genuinely unwritable or missing log still fails here, where it is diagnosable.
    const code = (error as NodeJS.ErrnoException).code;
    const shared = !POSIX && existing !== null && (code === "EBUSY" || code === "EPERM");
    if (!shared) throw error;
  }
  reassertPrivateModes(root);
  return root;
}

/**
 * Copy-truncate daemon.log without ever following a planted symlink.
 *
 * The service shell keeps daemon.log open with O_APPEND, so the live path cannot be renamed: that
 * would leave the service writing into the renamed inode forever. Instead we open the live file
 * once, validate that descriptor, copy from that descriptor into an exclusive private temporary
 * file, atomically replace only the daemon.log.1 directory entry, and truncate the same validated
 * live descriptor. No path-based copy, chmod, or truncate is safe enough for this operation.
 *
 * Returns the number of bytes rotated, or null when the live log is absent or not oversized.
 */
export function rotateDaemonLog(root: string, thresholdBytes: number): number | null {
  if (!isOwnedStateDir(root)) {
    throw new StateRootError(`refusing to rotate a daemon log outside an owned state root: ${root}`);
  }
  const logPath = join(root, "daemon.log");
  const rotatedPath = join(root, "daemon.log.1");
  const before = lstatOrNull(logPath);
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new StateRootError(`llmwiki daemon log path is not a regular file: ${logPath}`);
  }

  const liveFd = openSync(logPath, fsConstants.O_RDWR | (POSIX ? fsConstants.O_NOFOLLOW : 0));
  let tempPath: string | null = null;
  try {
    const live = fstatSync(liveFd);
    if (!live.isFile() || live.dev !== before.dev || live.ino !== before.ino) {
      throw new StateRootError(`llmwiki daemon log changed while opening it: ${logPath}`);
    }
    if (live.size <= thresholdBytes) return null;

    tempPath = join(root, `.daemon.log.1.tmp-${process.pid}-${Date.now().toString(36)}`);
    const tempFd = openSync(
      tempPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (POSIX ? fsConstants.O_NOFOLLOW : 0),
      0o600,
    );
    try {
      if (POSIX) fchmodSync(tempFd, 0o600);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < live.size) {
        const count = readSync(liveFd, buffer, 0, Math.min(buffer.length, live.size - position), position);
        if (count === 0) throw new Error(`daemon log became shorter while rotating: ${logPath}`);
        let written = 0;
        while (written < count) {
          const n = writeSync(tempFd, buffer, written, count - written);
          if (n === 0) throw new Error(`could not write rotated daemon log: ${rotatedPath}`);
          written += n;
        }
        position += count;
      }
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }

    // rename replaces a planted daemon.log.1 symlink as a directory entry; it never opens or
    // mutates that link's target. Only after the durable copy is installed do we truncate the
    // already-open, already-validated live inode used by the service's append descriptor.
    renameSync(tempPath, rotatedPath);
    tempPath = null;
    ftruncateSync(liveFd, 0);
    return live.size;
  } finally {
    closeSync(liveFd);
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best-effort cleanup of our exclusive temporary file */
      }
    }
  }
}

// ---- retention ------------------------------------------------------------------------------

export interface ExpiredPair {
  readonly sessionId: string;
  readonly exportPath: string | null;
  readonly metaPath: string | null;
}

interface ValidExportArtifact {
  readonly sessionId: string;
  readonly exportPath: string | null;
  readonly metaPath: string | null;
  readonly newest: number;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  const text = readBounded(path, 64 * 1024);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exportHeader(path: string): Record<string, unknown> | null {
  const text = readBounded(path, 64 * 1024);
  if (text === null) return null;
  try {
    const value = JSON.parse(text.split("\n", 1)[0] ?? "");
    return value?.kind === "opencode-meta" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function modernHeaderMatches(
  key: string,
  header: Record<string, unknown> | null,
): header is Record<string, unknown> & { sessionID: string; sourcePath: string } {
  return (
    header !== null &&
    header.exportKey === key &&
    typeof header.sessionID === "string" &&
    typeof header.sourcePath === "string"
  );
}

function modernProgressMatches(
  key: string,
  progress: Record<string, unknown> | null,
): progress is Record<string, unknown> & { sessionID: string; sourcePath: string; lastSeq: number } {
  return (
    progress !== null &&
    progress.kind === "opencode-progress" &&
    progress.exportKey === key &&
    typeof progress.sessionID === "string" &&
    typeof progress.sourcePath === "string" &&
    typeof progress.lastSeq === "number"
  );
}

function strictLegacyOrphanMatches(key: string, header: Record<string, unknown> | null): boolean {
  if (header === null) return false;
  const keys = Object.keys(header).sort();
  return (
    keys.length === 4 &&
    keys[0] === "directory" &&
    keys[1] === "kind" &&
    keys[2] === "sessionID" &&
    keys[3] === "title" &&
    header.kind === "opencode-meta" &&
    header.sessionID === key &&
    (typeof header.directory === "string" || header.directory === null) &&
    (typeof header.title === "string" || header.title === null)
  );
}

function completePairMatches(
  key: string,
  header: Record<string, unknown>,
  progress: Record<string, unknown>,
): boolean {
  if (typeof header.sessionID !== "string" || typeof progress.lastSeq !== "number") return false;
  if (modernHeaderMatches(key, header)) {
    return (
      modernProgressMatches(key, progress) &&
      progress.sessionID === header.sessionID &&
      progress.sourcePath === header.sourcePath
    );
  }
  if (!strictLegacyOrphanMatches(key, header)) return false;
  if (modernProgressMatches(key, progress)) {
    // Upgrade compatibility: a v0.8 export header can remain append-only while its small progress
    // sidecar is bound to the exact OpenCode database that adopted it.
    return progress.sessionID === header.sessionID;
  }
  return Object.keys(progress).length === 1 && typeof progress.lastSeq === "number";
}

/**
 * Self-authenticating modern or complete legacy export artifacts owned by llmwiki.
 *
 * Complete pairs are cross-validated. A single modern member can also prove ownership from its
 * filename-bound exportKey and source/session fields, which lets retention remove an orphaned
 * plaintext transcript after its peer is lost. If both members exist but disagree, neither is
 * deleted: an inconsistent lookalike remains evidence for manual inspection.
 */
function validExportArtifacts(root: string): ValidExportArtifact[] {
  const dir = join(root, EXPORT_DIR_NAME);
  if (!isRealDir(dir)) return [];
  const names = readdirSync(dir);
  const keys = new Set<string>();
  for (const name of names) {
    if (EXPORT_NAME_RE.test(name)) keys.add(name.slice(0, -".jsonl".length));
    else if (META_NAME_RE.test(name)) keys.add(name.slice(0, -".meta.json".length));
  }
  const out: ValidExportArtifact[] = [];
  for (const key of keys) {
    const exportPath = join(dir, `${key}.jsonl`);
    const metaPath = join(dir, `${key}.meta.json`);
    const exportStat = lstatOrNull(exportPath);
    const metaStat = lstatOrNull(metaPath);
    const exportRegular = exportStat !== null && exportStat.isFile() && !exportStat.isSymbolicLink();
    const metaRegular = metaStat !== null && metaStat.isFile() && !metaStat.isSymbolicLink();
    const header = exportRegular ? exportHeader(exportPath) : null;
    const progress = metaRegular ? readJsonObject(metaPath) : null;

    if (exportRegular && metaRegular) {
      if (!header || !progress || !completePairMatches(key, header, progress)) continue;
      out.push({
        sessionId: header.sessionID as string,
        exportPath,
        metaPath,
        newest: Math.max(exportStat.mtimeMs, metaStat.mtimeMs),
      });
      continue;
    }

    if (
      exportRegular &&
      metaStat === null &&
      (modernHeaderMatches(key, header) || strictLegacyOrphanMatches(key, header))
    ) {
      out.push({ sessionId: header!.sessionID as string, exportPath, metaPath: null, newest: exportStat.mtimeMs });
    } else if (exportStat === null && metaRegular && modernProgressMatches(key, progress)) {
      out.push({ sessionId: progress.sessionID, exportPath: null, metaPath, newest: metaStat.mtimeMs });
    }
  }
  return out;
}

/**
 * OpenCode export/meta pairs older than the TTL, timed by the NEWEST member of the pair (a
 * session written to yesterday is not 40 days old because its meta file is). Incomplete or
 * unrecognized lookalikes are retained; filename shape alone is never deletion authority.
 */
export function expiredExportPairs(root: string, now = Date.now(), ttlDays = EXPORT_TTL_DAYS): ExpiredPair[] {
  if (!isOwnedStateDir(root)) return [];
  const cutoff = now - ttlDays * 86_400_000;
  return validExportArtifacts(realpathSync(root))
    .filter((artifact) => artifact.newest < cutoff)
    .map(({ sessionId, exportPath, metaPath }) => ({ sessionId, exportPath, metaPath }))
    .sort((a, b) => (a.exportPath ?? a.metaPath ?? "").localeCompare(b.exportPath ?? b.metaPath ?? ""));
}

// ---- purge ----------------------------------------------------------------------------------

export interface PurgeResult {
  readonly removed: string[];
  readonly retained: string[];
  readonly rootRemoved: boolean;
  readonly error?: string;
}

/**
 * Remove ONLY the named artifacts this engine creates, under a root it owns, never following a
 * symlink. Anything else in the directory survives and is reported — a purge that deleted an
 * unrelated file it found in a shared directory would be a far worse bug than leaving state behind.
 */
export function purgeOwnedState(dir: string): PurgeResult {
  const removed: string[] = [];
  const retained: string[] = [];
  const st = lstatOrNull(dir);
  if (st === null) return { removed, retained, rootRemoved: false };
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { removed, retained, rootRemoved: false, error: `state path is not a directory: ${dir}` };
  }
  const root = realpathSync(dir);
  if (!hasOwnershipMarker(root)) {
    return {
      removed,
      retained: readdirSync(root),
      rootRemoved: false,
      error: `refusing to purge a state root llmwiki does not own: ${root}`,
    };
  }
  const exportDir = join(root, EXPORT_DIR_NAME);
  if (isRealDir(exportDir)) {
    const owned = new Set<string>();
    for (const artifact of validExportArtifacts(root)) {
      for (const path of [artifact.exportPath, artifact.metaPath]) {
        if (path === null) continue;
        unlinkSync(path);
        const name = path.slice(exportDir.length + 1);
        owned.add(name);
        removed.push(join(EXPORT_DIR_NAME, name));
      }
    }
    for (const name of readdirSync(exportDir)) {
      if (!owned.has(name)) retained.push(join(EXPORT_DIR_NAME, name));
    }
    try {
      rmdirSync(exportDir); // empty only
    } catch {
      retained.push(EXPORT_DIR_NAME);
    }
  }
  const projectsDir = join(root, PROJECTS_DIR_NAME);
  if (isRealDir(projectsDir)) {
    // Whole-subtree removal is right here and nowhere else: `--purge-data` is the explicit
    // "delete what llmwiki stored about me" request, and every id directory under projects/ was
    // created by this engine. Anything NOT matching our id shape is left, and leaving it also
    // leaves the parent directory — the same refusal the rest of this function makes.
    let allOurs = true;
    for (const name of readdirSync(projectsDir)) {
      const path = join(projectsDir, name);
      if (!PROJECT_ID_RE.test(name) || !isRealDir(path)) {
        retained.push(join(PROJECTS_DIR_NAME, name));
        allOurs = false;
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      removed.push(join(PROJECTS_DIR_NAME, name));
    }
    if (allOurs) {
      try {
        rmdirSync(projectsDir);
      } catch {
        retained.push(PROJECTS_DIR_NAME);
      }
    }
  }
  for (const name of OWNED_FILES) {
    const path = join(root, name);
    if (!isRegular(path)) continue;
    unlinkSync(path);
    removed.push(name);
  }
  // A crash can strand the exclusive private copy used by rotateDaemonLog before rename. Treat
  // only the exact engine-generated shape as owned, and only when it is a regular non-symlink.
  for (const name of readdirSync(root)) {
    if (!ROTATION_TEMP_RE.test(name)) continue;
    const path = join(root, name);
    if (!isRegular(path)) continue;
    unlinkSync(path);
    removed.push(name);
  }
  const marker = markerPath(root);
  if (isRegular(marker)) {
    unlinkSync(marker);
    removed.push(STATE_MARKER);
  }
  for (const name of readdirSync(root)) retained.push(name);
  let rootRemoved = false;
  try {
    rmdirSync(root); // only when nothing unrelated remains
    rootRemoved = true;
  } catch {
    /* unrelated entries survive, and so does the directory holding them */
  }
  return { removed, retained, rootRemoved };
}

// ---- moving the state root off a disposable clone -------------------------------------------
//
// The clone-local default is kept alive by the sticky branch in effectiveStateRoot, which is what
// makes upgrading safe. But keeping it forever means "the engine clone is disposable" is false for
// every existing user, and since per-project state moved into the state root there is now MORE to
// lose to a `git clean -xdf` than there was before. So the situation is reported and a migration
// is offered — checked automatically, applied by a person, the same split as engine updates.

export type StateMigration = {
  readonly needed: boolean;
  readonly from: string;
  readonly to: string;
  /** Why nothing is offered — empty when `needed`. */
  readonly reason: string;
  /** Must be cleared before a commit run can proceed. */
  readonly blockers: readonly string[];
  readonly summary: string;
};

/**
 * Should this machine move its state root, and can it right now?
 *
 * Deliberately narrow: only the clone-local default is ever offered for migration. A root the user
 * named through LLMWIKI_STATE_DIR is their decision and is left alone.
 */
export function planStateMigration(
  daemonRunning: boolean,
  // Overridable so the decision can be exercised on temp directories: the real `from` is this
  // clone's own live state root, which a test must never be able to move.
  locations: { readonly from?: string; readonly to?: string } = {},
): StateMigration {
  const from = locations.from ?? legacyCloneStateRoot();
  const to = locations.to ?? defaultStateRoot();
  const explicit = envValueOutsideRepoFiles("LLMWIKI_STATE_DIR")?.trim();
  const idle = { needed: false, from, to, blockers: [] as string[], summary: describeStateRoot(from) };
  if (explicit) return { ...idle, reason: "LLMWIKI_STATE_DIR names the root explicitly — nothing to decide" };
  if (from === to) return { ...idle, reason: "already at the default location" };
  if (!isRealDir(from)) return { ...idle, reason: "no clone-local state root exists" };
  if (!hasOwnershipMarker(from)) return { ...idle, reason: "the clone-local directory is not an llmwiki state root" };

  const blockers: string[] = [];
  // capture.db is open for writing while the daemon sweeps; moving it under a live writer is how
  // a queue gets truncated. Stopping first costs one poll interval and nothing else.
  if (daemonRunning) blockers.push("the capture daemon is running — stop it first (`./setup.sh --uninstall` keeps your data, or unload the service)");
  if (isRealDir(to)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(to);
    } catch {
      blockers.push(`cannot read the destination: ${to}`);
    }
    if (entries.length > 0) blockers.push(`destination is not empty: ${to}`);
  }
  return { needed: true, from, to, reason: "", blockers, summary: describeStateRoot(from) };
}

export type StateMigrationResult =
  | { readonly kind: "dry-run"; readonly plan: StateMigration }
  | { readonly kind: "blocked"; readonly plan: StateMigration }
  | { readonly kind: "not-needed"; readonly plan: StateMigration }
  | { readonly kind: "moved"; readonly plan: StateMigration };

/**
 * Move the whole state root, then re-stamp the ownership marker for its new path (the marker
 * records the path it was written for, so a moved root that kept the old marker would read as
 * un-owned and every later command would refuse it).
 *
 * A rename is preferred and a copy is the fallback for a cross-device move; the source is removed
 * only after the destination verifies, so an interrupted migration leaves the original intact.
 */
export function migrateStateRoot(
  daemonRunning: boolean,
  commit: boolean,
  locations: { readonly from?: string; readonly to?: string } = {},
): StateMigrationResult {
  const plan = planStateMigration(daemonRunning, locations);
  if (!plan.needed) return { kind: "not-needed", plan };
  if (plan.blockers.length > 0) return { kind: "blocked", plan };
  if (!commit) return { kind: "dry-run", plan };

  mkdirSync(dirname(plan.to), { recursive: true, mode: 0o700 });
  let renamed = false;
  try {
    renameSync(plan.from, plan.to);
    renamed = true;
  } catch {
    /* cross-device or otherwise unrenameable → copy below */
  }
  if (!renamed) {
    cpSync(plan.from, plan.to, { recursive: true, preserveTimestamps: true, dereference: false });
    if (!isRealDir(plan.to) || readdirSync(plan.to).length === 0) {
      throw new StateRootError(`state migration copied nothing into ${plan.to}; the original is untouched`);
    }
  }
  writeOwnershipMarker(plan.to);
  reassertPrivateModes(plan.to);
  if (!hasOwnershipMarker(plan.to)) {
    throw new StateRootError(`state migration could not stamp ownership on ${plan.to}`);
  }
  if (!renamed) rmSync(plan.from, { recursive: true, force: true });
  return { kind: "moved", plan };
}

/** Size of the state root's contents, for reporting when a purge was NOT requested. */
export function describeStateRoot(dir: string): string {
  if (!isRealDir(dir)) return `${dir} (absent)`;
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      const st = lstatOrNull(path);
      if (st === null) continue;
      if (st.isDirectory()) walk(path);
      else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    /* partial count is fine for a report */
  }
  return `${dir} (${files} file(s), ${Math.round(bytes / 1024)} KB)`;
}

/** True when `path` is a real directory carrying our ownership marker. */
export function isOwnedStateDir(path: string): boolean {
  return isRealDir(path) && hasOwnershipMarker(realpathSync(path));
}

/** True only for a path lexically inside the effective, owned OpenCode export directory. */
export function isOwnedExportPath(path: string): boolean {
  const root = effectiveStateRoot();
  if (!isOwnedStateDir(root)) return false;
  const dir = join(realpathSync(root), EXPORT_DIR_NAME);
  let parent: string;
  try {
    parent = realpathSync(dirname(path));
  } catch {
    return false;
  }
  return parent === dir && EXPORT_NAME_RE.test(basename(path));
}
