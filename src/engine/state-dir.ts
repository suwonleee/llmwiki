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
//      `.state` and every single entry in it validates as something this engine wrote. A
//      pre-existing directory someone pointed LLMWIKI_STATE_DIR at is NEVER adopted, never
//      recursively chmodded, and never purged — setup and capture fail closed with an
//      explanation instead. Adopting it would mean changing permissions on, and later deleting,
//      files we have no reason to believe are ours.
//   2. PRIVATE BY CONSTRUCTION. An owned root and its export directory are 0700; the databases,
//      logs and exports inside are 0600. Not "usually" — enforced on every open.
import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { envValueOutsideRepoFiles } from "./env-policy.ts";

export const STATE_MARKER = ".llmwiki-state-v1.json";
export const STATE_MARKER_VERSION = 1;
export const STATE_MARKER_MAX_BYTES = 4096;

/** OpenCode exports are the only transcript BODIES this engine keeps. They expire. */
export const EXPORT_TTL_DAYS = 30;

export const EXPORT_DIR_NAME = "opencode-export";
/** Everything an llmwiki-owned state root may contain — the purge allowlist, and nothing else. */
export const OWNED_FILES = ["capture.db", "capture.db-wal", "capture.db-shm", "daemon.log", "update-check.json"] as const;
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
let stateRootOverride: string | null = null;

/** One process-wide state location, shared by capture, OpenCode exports, retention and purge. */
export function effectiveStateRoot(): string {
  return stateRootOverride ?? (envValueOutsideRepoFiles("LLMWIKI_STATE_DIR")?.trim() || join(CLONE_ROOT, ".state"));
}

/** Test/embedded-process override. Production callers normally use LLMWIKI_STATE_DIR. */
export function setEffectiveStateRoot(dir: string | null): void {
  stateRootOverride = dir;
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
  const temp = join(root, `.${STATE_MARKER}.tmp-${process.pid}`);
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
    const cols = db.query("PRAGMA table_info(capture_queue)").all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    return names.has("transcript_path") && names.has("status") && names.has("repo");
  } catch {
    return false;
  } finally {
    db?.close();
  }
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

/** Entries of the canonical default root that this engine is known to write. */
function unownedEntries(root: string): string[] | null {
  const allowed = new Set<string>([...OWNED_FILES, EXPORT_DIR_NAME]);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const foreign: string[] = [];
  for (const name of entries) {
    const path = join(root, name);
    if (name === EXPORT_DIR_NAME) {
      if (!looksLikeOurExportDir(path)) foreign.push(name);
      continue;
    }
    if (!allowed.has(name) && !LEGACY_OWNED_FILE_RE.test(name)) {
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
  const entries = readdirSync(root);
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
  // Name what actually blocked adoption. The old wording ("files this engine did not create")
  // was both unactionable and, for an upgrading user, untrue — it was usually llmwiki's own older
  // artifacts. Whoever hits this needs to know which entries to move, not a category.
  const foreign = (isDefault ? unownedEntries(root) : null) ?? [];
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
    entries = readdirSync(root);
  } catch (error) {
    return { usable: false, detail: `unreadable: ${error}` };
  }
  if (entries.length === 0) return { usable: true, detail: "empty — adoptable" };
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
  const fd = openSync(
    logPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_APPEND |
      (POSIX ? fsConstants.O_NOFOLLOW : 0),
    0o600,
  );
  closeSync(fd);
  reassertPrivateModes(root);
  return root;
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
  for (const name of OWNED_FILES) {
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
