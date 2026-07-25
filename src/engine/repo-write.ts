// Every engine write of a file inside the USER'S repository goes through here.
//
// Two properties, one primitive:
//
//   1. Atomic replace — content is written to a temp sibling and renamed, so a crash, a concurrent
//      reader, or a full disk never leaves half a page behind.
//   2. Symlinks are replaced, never followed. git stores a symlink as its target path, so a shared
//      wiki can arrive with `docs/wiki/overview.md` (or log.md, or any page) pointing outside the
//      repository. Following it lets a close-out overwrite that file with wiki text; READING it
//      would copy private content into a page that then gets committed. The engine owns these
//      paths, so a link there is replaced by a regular file and its target is never touched.
//
// Machine-local state (.llmwiki/, .state/, the OS temp dir) is not repository content and keeps
// its own writers — see turncontext.ts for the temp-dir equivalent of rule 2.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // absent → nothing to follow
  }
}

/** Read a repository file. Returns null when it is absent OR a symlink (whose target is not ours). */
export function readRepoFile(path: string): string | null {
  if (isSymlink(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Write a repository file atomically, replacing (never following) a symlink at that path. */
export function writeRepoFile(path: string, content: string): void {
  const temp = `${path}.llmwiki-tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, content, "utf-8");
    renameSync(temp, path); // rename replaces the link itself, so the target stays untouched
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
export function appendRepoFile(path: string, addition: string): void {
  const existing = readRepoFile(path) ?? "";
  writeRepoFile(path, existing + addition);
}

/** Does a regular file of ours exist at this path? A symlink counts as absent (see above). */
export function repoFileExists(path: string): boolean {
  return !isSymlink(path) && existsSync(path);
}
