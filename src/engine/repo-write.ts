// Every engine read and write of a file inside the USER'S repository goes through here.
//
// A repository is untrusted INPUT: its directory layout, its symlinks, and any path its
// `llmwiki.config.toml` names all arrive from someone else's commit. So the boundary is
// expressed the only way that can actually be checked — as a canonical ROOT plus a repository
// RELATIVE path — and every component between the two is verified before a descriptor exists.
//
// Four properties:
//
//   1. Containment. The relative path may not be absolute, may not contain NUL, and may not
//      carry `.` / `..` / empty components. There is no arithmetic on the joined string that a
//      `..` could survive, because `..` never gets joined in the first place.
//   2. No symlink is ever followed — leaf OR ancestor. A leaf link is refused by O_NOFOLLOW on
//      the descriptor we actually read; ancestors are lstat-verified as real directories on the
//      way down. Checking only the leaf (the previous behavior) leaves `docs/wiki -> /etc` wide
//      open: the leaf is a regular file, and the escape already happened one level up.
//   3. Atomic replace. Content goes to an exclusively-created temp sibling, is fsynced, and is
//      renamed over the target — so a crash never leaves half a page, and the rename replaces a
//      symlink at the destination without writing through it.
//   4. Reads of a link report ABSENT rather than the target's bytes. A close-out that read
//      `docs/wiki/overview.md -> ~/.ssh/id_rsa` would copy that content into a page and commit
//      it; "absent" makes the engine write its own content instead.
//
// Machine-local state that is NOT repository content (the capture queue, OpenCode exports, the
// OS temp dir) has its own writers and its own private-mode rules — see capture.ts.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const POSIX = process.platform !== "win32";

export class RepoBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoBoundaryError";
  }
}

/** Split a repository-relative path into components, rejecting everything that could escape. */
export function repoComponents(relativePath: string): string[] {
  if (typeof relativePath !== "string" || relativePath === "") {
    throw new RepoBoundaryError("repository path must be a non-empty relative path");
  }
  if (relativePath.includes("\0")) throw new RepoBoundaryError("repository path contains NUL");
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    throw new RepoBoundaryError(`repository path must be relative: ${relativePath}`);
  }
  const parts = relativePath.split(/[\\/]/);
  for (const part of parts) {
    if (part === "") throw new RepoBoundaryError(`empty path component: ${relativePath}`);
    if (part === "." || part === "..") throw new RepoBoundaryError(`path traversal refused: ${relativePath}`);
  }
  return parts;
}

/**
 * Convert an absolute path the caller already computed into a repository-relative one, refusing
 * anything that is not strictly inside the canonical root. Call sites that build destinations by
 * joining onto the root use this instead of re-deriving the string by hand.
 */
export function repoRelative(root: string, absolutePath: string): string {
  const target = resolve(absolutePath);
  // Two spellings of the same root are both accepted: the canonical one and the one the caller
  // resolved (macOS /var vs /private/var). Containment is decided by prefix on whichever matches;
  // the resulting relative path is then validated like any other, so `..` still cannot survive.
  for (const base of [canonicalRoot(root), resolve(root)]) {
    if (target === base) throw new RepoBoundaryError("the repository root is not a file");
    if (target.startsWith(base + sep)) {
      const rel = relative(base, target);
      repoComponents(rel);
      return rel;
    }
  }
  throw new RepoBoundaryError(`path escapes the repository root: ${absolutePath}`);
}

/** The canonical repository root. Throws when it is absent or is not a real directory. */
export function canonicalRoot(root: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(root));
  } catch {
    throw new RepoBoundaryError(`repository root does not exist: ${root}`);
  }
  if (!lstatSync(real).isDirectory()) throw new RepoBoundaryError(`repository root is not a directory: ${root}`);
  return real;
}

/**
 * Resolve `relative` beneath `root`, verifying that every EXISTING ancestor is a real directory.
 * Returns the absolute path of the leaf (which may or may not exist yet).
 */
export function repoPath(root: string, relativePath: string): string {
  const canonical = canonicalRoot(root);
  const parts = repoComponents(relativePath);
  let current = canonical;
  for (let i = 0; i < parts.length - 1; i++) {
    current = join(current, parts[i]!);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      continue; // absent ancestor: nothing to follow, and creation is ensureRepoDir's job
    }
    if (st.isSymbolicLink()) {
      throw new RepoBoundaryError(`refusing to follow a symlinked directory inside the repository: ${relativePath}`);
    }
    if (!st.isDirectory()) throw new RepoBoundaryError(`not a directory: ${relativePath}`);
  }
  return join(current, parts[parts.length - 1]!);
}

/** True when every ancestor of `relative` exists as a real directory (no symlink on the way). */
function ancestorsUsable(root: string, relativePath: string): string | null {
  try {
    return repoPath(root, relativePath);
  } catch {
    return null;
  }
}

/**
 * Read a repository file. Returns null when it is absent, is a symlink, sits behind a symlinked
 * directory, escapes the root, or is unreadable — the engine then writes its own content instead
 * of copying someone else's file into a page.
 */
export function readRepoFile(root: string, relativePath: string): string | null {
  const bytes = readRepoFileBytes(root, relativePath);
  return bytes === null ? null : bytes.toString("utf-8");
}

export type RepoFileReadResult =
  | { readonly status: "file"; readonly bytes: Buffer }
  | { readonly status: "absent" }
  | { readonly status: "unsafe" };

function openRepoFile(root: string, relativePath: string): number | null {
  const path = ancestorsUsable(root, relativePath);
  if (path === null) return null;
  // O_NOFOLLOW is unavailable on native Windows. The explicit lstat is therefore part of the
  // contract, not merely a nicer error: a junction/symlink leaf must never be opened there.
  // POSIX keeps O_NOFOLLOW as the descriptor-time backstop against a leaf swap after this check.
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (POSIX ? fsConstants.O_NOFOLLOW : 0));
  } catch {
    return null; // absent, or a symlink refused by O_NOFOLLOW (ELOOP)
  }
  try {
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return null;
    }
  } catch {
    closeSync(fd);
    return null;
  }
  return fd;
}

/**
 * Read a repository file while preserving the security-relevant distinction between ABSENT and
 * PRESENT-BUT-UNSAFE. Most repository readers intentionally collapse both to null; policy inputs
 * such as `.env` must fail closed when a symlink, non-file, unreadable leaf, or invalid ancestor
 * is present.
 */
export function readRepoFileResult(root: string, relativePath: string): RepoFileReadResult {
  const path = ancestorsUsable(root, relativePath);
  if (path === null) return { status: "unsafe" };
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return { status: "unsafe" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "unsafe" };
  }

  // A failure after the lstat is deliberately UNSAFE, not absent. The leaf may have been swapped,
  // or it may be unreadable; either way a protected setting must not trust Bun's autoloaded value.
  const fd = openRepoFile(root, relativePath);
  if (fd === null) return { status: "unsafe" };
  try {
    return { status: "file", bytes: readFileSync(fd) };
  } catch {
    return { status: "unsafe" };
  } finally {
    closeSync(fd);
  }
}

/** Read repository bytes without following a leaf or ancestor symlink. */
export function readRepoFileBytes(root: string, relativePath: string): Buffer | null {
  const result = readRepoFileResult(root, relativePath);
  return result.status === "file" ? result.bytes : null;
}

export interface RepoFileMetadata {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: bigint;
}

/** Descriptor-derived metadata for a regular repository file, or null at any unsafe path. */
export function repoFileMetadata(root: string, relativePath: string): RepoFileMetadata | null {
  const fd = openRepoFile(root, relativePath);
  if (fd === null) return null;
  try {
    const st = fstatSync(fd, { bigint: true });
    return {
      size: Number(st.size),
      mtimeMs: Number(st.mtimeMs),
      mtimeNs: st.mtimeNs,
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Write a repository file atomically, replacing (never following) a symlink at that path. */
export function writeRepoFile(root: string, relativePath: string, content: string): void {
  const path = repoPath(root, relativePath);
  const dir = join(path, "..");
  const temp = join(dir, `.llmwiki-tmp-${randomUUID()}`);
  try {
    const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path); // replaces the link itself, so its target stays untouched
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/**
 * Append to a repository file, creating it when absent.
 *
 * A symlinked path is treated as having no content of ours: the addition alone becomes the new
 * regular file. Reading the target first would pull someone else's file into the repository.
 */
export function appendRepoFile(root: string, relativePath: string, addition: string): void {
  const existing = readRepoFile(root, relativePath) ?? "";
  writeRepoFile(root, relativePath, existing + addition);
}

/** Does a regular file of ours exist there? A symlink (leaf or ancestor) counts as absent. */
export function repoFileExists(root: string, relativePath: string): boolean {
  const path = ancestorsUsable(root, relativePath);
  if (path === null) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Create a directory (and its missing ancestors) inside the repository, refusing to create
 * anything through a symlink. Returns the absolute path.
 */
export function ensureRepoDir(root: string, relativePath: string): string {
  const canonical = canonicalRoot(root);
  const parts = repoComponents(relativePath);
  let current = canonical;
  for (const part of parts) {
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      mkdirSync(current); // non-recursive: each level is verified as we go
      continue;
    }
    if (st.isSymbolicLink()) {
      throw new RepoBoundaryError(`refusing to create through a symlinked directory: ${relativePath}`);
    }
    if (!st.isDirectory()) throw new RepoBoundaryError(`not a directory: ${relativePath}`);
  }
  return current;
}

/** True when the path is usable for a repository read/write (used by callers that only probe). */
export function repoPathAllowed(root: string, relativePath: string): boolean {
  return ancestorsUsable(root, relativePath) !== null;
}

/**
 * Remove a repository file. Unlinks the ENTRY (a symlink is removed, its target untouched) and
 * refuses anything that escapes the root or sits behind a symlinked directory.
 */
export function removeRepoFile(root: string, relativePath: string): boolean {
  const path = repoPath(root, relativePath);
  try {
    if (!lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/** Rename inside the repository. Both sides are validated; neither may cross a symlink. */
export function renameRepoPath(root: string, fromRelative: string, toRelative: string): void {
  const from = repoPath(root, fromRelative);
  const to = repoPath(root, toRelative);
  if (lstatSync(from).isSymbolicLink()) {
    throw new RepoBoundaryError(`refusing to rename a symlink: ${fromRelative}`);
  }
  renameSync(from, to);
}

export interface RepoDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/**
 * List a repository directory, dropping symlinked entries and returning [] when the directory
 * itself is absent, is a link, or sits behind one. Listing is how the cold start finds pages, so
 * it needs the same containment as reading them.
 */
export function readRepoDir(root: string, relativePath: string): RepoDirEntry[] {
  const path = ancestorsUsable(root, relativePath);
  if (path === null) return [];
  try {
    if (lstatSync(path).isSymbolicLink()) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => !e.isSymbolicLink())
      .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** List the canonical repository root itself. Root is not representable as a file path. */
export function readRepoRoot(root: string): RepoDirEntry[] {
  try {
    return readdirSync(canonicalRoot(root), { withFileTypes: true })
      .filter((e) => !e.isSymbolicLink())
      .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

/** Does a real directory of ours exist there? A symlink (leaf or ancestor) counts as absent. */
export function repoDirExists(root: string, relativePath: string): boolean {
  const path = ancestorsUsable(root, relativePath);
  if (path === null) return false;
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Modification time of a repository file, or null when it is absent or not a regular file. */
export function repoFileMtime(root: string, relativePath: string): number | null {
  return repoFileMetadata(root, relativePath)?.mtimeMs ?? null;
}
