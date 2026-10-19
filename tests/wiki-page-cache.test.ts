import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetForTests, getConfig } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { loadWikiPages, searchWiki } from "../src/engine/page-rank.ts";
import { _wikiPageCachePath, cachedWikiPages } from "../src/engine/wiki-page-cache.ts";

const roots: string[] = [];
let oldTemp: string | undefined;
let oldCache: string | undefined;
beforeEach(() => {
  oldTemp = process.env.LLMWIKI_PAGE_CACHE_TMPDIR;
  oldCache = process.env.LLMWIKI_PAGE_CACHE;
  process.env.LLMWIKI_PAGE_CACHE_TMPDIR = temp();
  delete process.env.LLMWIKI_PAGE_CACHE;
});
afterEach(() => {
  setSystemTime();
  if (oldTemp === undefined) delete process.env.LLMWIKI_PAGE_CACHE_TMPDIR; else process.env.LLMWIKI_PAGE_CACHE_TMPDIR = oldTemp;
  if (oldCache === undefined) delete process.env.LLMWIKI_PAGE_CACHE; else process.env.LLMWIKI_PAGE_CACHE = oldCache;
  _resetForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string { const p = mkdtempSync(join(tmpdir(), "llmwiki-page-cache-test-")); roots.push(p); return p; }
function put(root: string, rel: string, body = "cache body", fm = ""): void {
  const p = join(root, "docs/wiki", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\ntype: Note\ntitle: ${rel}\ndescription: cache policy\n${fm}---\n${body}\n`);
}
function fixture(): string { const root = temp(); put(root, "a.md"); return root; }
function withoutCache<T>(fn: () => T): T {
  process.env.LLMWIKI_PAGE_CACHE = "off";
  try { return fn(); } finally { delete process.env.LLMWIKI_PAGE_CACHE; }
}

test("cache hit skips parsing, is private, and equals uncached search including original-case snippets", () => {
  const root = fixture();
  put(root, "decision.md", "Use X-Trace-ID.\n  > ignored evidence", "tags: [cache]\nx-llmwiki:\n  rule: Use bounded caching\n");
  put(root, "cold.md", "Hidden token", "tier: cold\nkeywords: [archive]\n");
  const miss = loadWikiPages(root);
  expect(loadWikiPages(root)).toEqual(miss);
  expect(withoutCache(() => loadWikiPages(root))).toEqual(miss);
  const ranked = searchWiki(root, "cache policy", 10);
  expect(withoutCache(() => searchWiki(root, "cache policy", 10))).toEqual(ranked);
  expect(statSync(_wikiPageCachePath(root)).mode & 0o777).toBe(0o600);
  expect(existsSync(join(root, ".llmwiki"))).toBe(false);
  let calls = 0;
  cachedWikiPages(root, () => { calls++; throw new Error("warm cache must not parse"); });
  expect(calls).toBe(0);
});

test("addition, same-size mtime edit, size edit, rename, deletion each invalidate", () => {
  const root = fixture();
  loadWikiPages(root);
  put(root, "added.md", "first-value");
  expect(loadWikiPages(root).map(p => p.rel).sort()).toEqual(["a.md", "added.md"]);
  const path = join(root, "docs/wiki/added.md");
  const stat = statSync(path);
  put(root, "added.md", "other-value");
  utimesSync(path, stat.atime, new Date(stat.mtimeMs + 2000));
  expect(loadWikiPages(root).find(p => p.rel === "added.md")!.body).toContain("other-value");
  const updated = statSync(path);
  put(root, "added.md", "different long body");
  utimesSync(path, updated.atime, updated.mtime);
  expect(loadWikiPages(root).find(p => p.rel === "added.md")!.body).toContain("different long body");
  renameSync(path, join(root, "docs/wiki/renamed.md"));
  expect(loadWikiPages(root).map(p => p.rel).sort()).toEqual(["a.md", "renamed.md"]);
  rmSync(join(root, "docs/wiki/renamed.md"));
  expect(loadWikiPages(root).map(p => p.rel)).toEqual(["a.md"]);
});

test("configuration and skip lists apply independently after a cache hit", () => {
  const root = fixture();
  for (const rel of ["0_review/question.md", "6_quiz/quiz.md", "other_queue/decision.md", "custom-log.md", "index.md", "nested/a.md"]) put(root, rel);
  const cfg = getConfig(root);
  const defaultPages = loadWikiPages(root, cfg);
  const changed = { ...cfg, queueDir: "other_queue", files: { ...cfg.files, log: "custom-log.md" } };
  const actual = loadWikiPages(root, changed, new Set(["a.md"]));
  expect(actual.map(p => p.rel)).toEqual(["0_review/question.md"]);
  expect(actual).toEqual(withoutCache(() => loadWikiPages(root, changed, new Set(["a.md"]))));
  expect(loadWikiPages(root, cfg)).toEqual(defaultPages);
});

test("stale_after changes with time without a page edit or cache invalidation", () => {
  const root = fixture();
  put(root, "expires.md", "cache expiry", "stale_after: 2030-01-02T00:00:00Z\n");
  setSystemTime(new Date("2030-01-01T00:00:00Z"));
  expect(loadWikiPages(root).find(p => p.rel === "expires.md")!.stale).toBe(false);
  const before = statSync(_wikiPageCachePath(root)).mtimeMs;
  setSystemTime(new Date("2030-01-03T00:00:00Z"));
  expect(loadWikiPages(root).find(p => p.rel === "expires.md")!.stale).toBe(true);
  expect(statSync(_wikiPageCachePath(root)).mtimeMs).toBe(before);
});

test("sourceChanged is fetched anew from the index on cache hits", () => {
  const root = fixture();
  const index = new WikiIndex(root); index.indexAll();
  expect(loadWikiPages(root)[0]!.sourceChanged).toBe(false);
  const cache = readFileSync(_wikiPageCachePath(root), "utf8");
  expect(cache).not.toContain("sourceChanged");
  expect(cache).not.toContain('"stale":');
  const db = index.connect();
  try {
    db.run("UPDATE documents SET stale_since='2030-01-01' WHERE source_kind='wiki'");
    expect(loadWikiPages(root)[0]!.sourceChanged).toBe(true);
    db.run("UPDATE documents SET stale_since=NULL WHERE source_kind='wiki'");
    expect(loadWikiPages(root)[0]!.sourceChanged).toBe(false);
  } finally { db.close(); }
});

test("planted cache symlink is never followed and is replaced without touching its target", () => {
  const root = fixture(); loadWikiPages(root);
  const path = _wikiPageCachePath(root);
  const forged = JSON.parse(readFileSync(path, "utf8"));
  forged.pages[0].title = "PLANTED";
  const outside = join(temp(), "outside.json");
  const content = JSON.stringify(forged);
  writeFileSync(outside, content, { mode: 0o600 });
  rmSync(path); symlinkSync(outside, path);
  expect(loadWikiPages(root)[0]!.title).toBe("a.md");
  expect(readFileSync(outside, "utf8")).toBe(content);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("corrupt, wrong-version, malformed, public, oversized and directory caches are ignored", () => {
  const root = fixture(); const baseline = loadWikiPages(root);
  const path = _wikiPageCachePath(root);
  const valid = readFileSync(path, "utf8");
  for (const corrupt of ["{broken", JSON.stringify({ ...JSON.parse(valid), version: -1 }), JSON.stringify({ ...JSON.parse(valid), pages: [{ rel: "../escape.md" }] })]) {
    writeFileSync(path, corrupt); expect(loadWikiPages(root)).toEqual(baseline);
  }
  const planted = JSON.parse(valid); planted.pages[0].title = "PLANTED";
  writeFileSync(path, JSON.stringify(planted)); chmodSync(path, 0o644);
  expect(loadWikiPages(root)).toEqual(baseline);
  truncateSync(path, 65 * 1024 * 1024);
  expect(loadWikiPages(root)).toEqual(baseline);
  rmSync(path); mkdirSync(path);
  expect(loadWikiPages(root)).toEqual(baseline);
});

test("repository page and ancestor symlinks cannot supply cached content", () => {
  const root = fixture(); loadWikiPages(root);
  const outside = temp(); put(outside, "secret.md", "NEVER_INJECT");
  symlinkSync(join(outside, "docs/wiki/secret.md"), join(root, "docs/wiki/a.md.link.md"));
  symlinkSync(join(outside, "docs/wiki"), join(root, "docs/wiki/linked"));
  expect(loadWikiPages(root).map(p => p.rel)).toEqual(["a.md"]);
  rmSync(join(root, "docs/wiki"), { recursive: true });
  symlinkSync(join(outside, "docs/wiki"), join(root, "docs/wiki"));
  expect(loadWikiPages(root)).toEqual([]);
});

test("a cache whose owner does not match the current UID is rejected", () => {
  if (typeof process.getuid !== "function") return;
  const root = fixture(); loadWikiPages(root);
  const path = _wikiPageCachePath(root);
  const planted = JSON.parse(readFileSync(path, "utf8"));
  planted.pages[0].title = "PLANTED";
  writeFileSync(path, JSON.stringify(planted));
  // Simulate the ownership mismatch without requiring privileged chown in the test runner.
  const uid = process.getuid;
  process.getuid = () => uid() + 1;
  try { expect(loadWikiPages(root)[0]!.title).toBe("a.md"); }
  finally { process.getuid = uid; }
});

test("cache keys isolate roots and canonical root aliases share the same safe cache", () => {
  const first = fixture(); const second = fixture();
  put(second, "a.md", "second root body");
  expect(_wikiPageCachePath(first)).not.toBe(_wikiPageCachePath(second));
  expect(loadWikiPages(first)[0]!.body).toContain("cache body");
  expect(loadWikiPages(second)[0]!.body).toContain("second root body");
  const alias = join(temp(), "alias"); symlinkSync(first, alias);
  expect(_wikiPageCachePath(alias)).toBe(_wikiPageCachePath(first));
  expect(loadWikiPages(alias)).toEqual(loadWikiPages(first));
});
