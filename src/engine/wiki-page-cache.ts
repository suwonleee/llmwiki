// Parsed retrieval pages live in one private OS-temp file per canonical repository root.
// Repository content is untrusted: enumerate through the repository boundary, never follow a
// planted cache link, and accept only a bounded regular file owned exclusively by this user.
// No project state is created by a first lookup in an unregistered repository.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPage } from "./page-rank.ts";
import { canonicalRoot, readRepoDir } from "./repo-write.ts";

export type ParsedWikiPage = Omit<WikiPage, "stale" | "sourceChanged"> & { readonly staleAfter?: string };
const VERSION = 1;
const MAX_BYTES = 64 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Test/diagnostic seam. The directory override keeps fixtures out of the shared OS cache. */
export function _wikiPageCachePath(root: string): string {
  const key = createHash("sha256").update(canonicalRoot(root)).digest("hex").slice(0, 24);
  return join(process.env.LLMWIKI_PAGE_CACHE_TMPDIR || tmpdir(), `llmwiki-pages-cache-${key}.json`);
}

function scanWiki(root: string): { sig: string; pages: string[] } {
  const hash = createHash("sha256").update(`v${VERSION}\n${root}\n`);
  const pages: string[] = [];
  const walk = (rel: string, prefix: string): void => {
    for (const e of readRepoDir(root, rel)) {
      if (e.name.startsWith(".")) continue;
      const child = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory) { walk(`${rel}/${e.name}`, child); continue; }
      if (!e.isFile || !e.name.endsWith(".md")) continue;
      try {
        const st = lstatSync(join(root, "docs/wiki", child));
        if (!st.isFile()) continue;
        pages.push(child);
        hash.update(`${child}\0${st.mtimeMs}\0${st.size}\n`);
      } catch { /* disappeared while listing */ }
    }
  };
  walk("docs/wiki", "");
  return { sig: hash.digest("hex"), pages };
}

function validPage(value: unknown): value is ParsedWikiPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (!["rel", "title", "description", "status", "identity", "trigger", "rule", "body"].every((k) => typeof p[k] === "string") || typeof p.retired !== "boolean") return false;
  if (!["type", "tags", "snippetBody", "staleAfter"].every((k) => p[k] === undefined || typeof p[k] === "string")) return false;
  const rel = p.rel as string;
  return rel.endsWith(".md") && rel.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"));
}

function readCache(path: string, sig: string): ParsedWikiPage[] | null {
  let fd: number | null = null;
  try {
    // NONBLOCK also prevents a planted FIFO from blocking before its descriptor is rejected.
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES || (st.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const bytes = readFileSync(fd);
    if (bytes.byteLength > MAX_BYTES) return null;
    const data = JSON.parse(bytes.toString("utf8"));
    if (data?.version !== VERSION || data.sig !== sig || !Array.isArray(data.pages) || !data.pages.every(validPage)) return null;
    return data.pages;
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

function writeCache(path: string, sig: string, pages: ParsedWikiPage[]): void {
  const temp = `${path}.${randomUUID()}`;
  try {
    const content = JSON.stringify({ version: VERSION, sig, pages });
    if (Buffer.byteLength(content) > MAX_BYTES) return;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { writeFileSync(fd, content, "utf8"); }
    finally { closeSync(fd); }
    renameSync(temp, path); // replace a planted link, never its target
  } catch { /* cache failure never prevents reading the actual wiki */ }
  finally { try { unlinkSync(temp); } catch { /* renamed or not created */ } }
}

/** Cache parsing only. Settings, skip lists, source changes and elapsed time are applied later. */
export function cachedWikiPages(root: string, parse: (root: string, paths: readonly string[]) => ParsedWikiPage[]): ParsedWikiPage[] {
  let canonical: string;
  try { canonical = canonicalRoot(root); } catch { return []; }
  const scan = scanWiki(canonical);
  if (process.env.LLMWIKI_PAGE_CACHE === "off") return parse(canonical, scan.pages);
  const path = _wikiPageCachePath(canonical);
  const cached = readCache(path, scan.sig);
  if (cached !== null) return cached;
  const pages = parse(canonical, scan.pages);
  // The signature is captured before parsing: a simultaneous edit invalidates the next read.
  writeCache(path, scan.sig, pages);
  return pages;
}
