import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importSessionReview, prepareSessionReview } from "../src/engine/session-review.ts";
import { setStateDir, stateDir } from "../src/engine/capture.ts";
import { refreshGapQueue } from "../src/engine/gaps.ts";
import { parseFrontmatter } from "../src/engine/frontmatter.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

let root: string, repo: string, previousState: string;
const page = "docs/wiki/3_decision/retries.md";
const report = "## Missing concepts\n\n- Idempotency boundary needs a concept page.\n\n## Next questions\n\n- What bounds retry attempts?\n";
function writePage(path = page, body = "Retry policy permits three attempts.", status = "stable") {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), "---\ntype: Decision\ntitle: Retry boundary\ndescription: Retry boundary\ntags: [retry, boundary]\nstatus: " + status + "\n---\n\n" + body + "\n");
}
beforeEach(() => {
  root = tempDir("llmwiki-session-review-");
  previousState = stateDir();
  setStateDir(join(root, "state"));
  repo = enrollRepo(makeGitRepo(join(root, "repo")));
  writePage();
});
afterEach(() => {
  setStateDir(previousState);
  rmSync(root, { recursive: true, force: true });
});

test("provider-free snapshot is bounded, omits retired pages and leaves active pages unchanged", () => {
  for (let i = 0; i < 44; i++) writePage("docs/wiki/3_decision/page-" + i + ".md", "Distinct decision " + i);
  writePage("docs/wiki/3_decision/retired.md", "Retired decision", "deprecated");
  const before = readFileSync(join(repo, page), "utf8");
  const snapshot = prepareSessionReview(repo);
  expect(snapshot.schema_version).toBe(1);
  expect(snapshot.total).toBe(45);
  expect(snapshot.pages).toHaveLength(40);
  expect(snapshot.pages.every(p => p.excerpt.length <= 450 && /^[a-f0-9]{64}$/.test(p.sha256))).toBe(true);
  expect(snapshot.pages.some(p => p.page.endsWith("retired.md"))).toBe(false);
  expect(readFileSync(join(repo, page), "utf8")).toBe(before);
});

test("explicit import creates a draft self-assessment and feeds gap refresh without a provider", () => {
  const snapshot = prepareSessionReview(repo);
  const before = readFileSync(join(repo, page), "utf8");
  const first = importSessionReview(repo, { snapshot, report }, "2026-10-19");
  const written = readFileSync(join(repo, first.path), "utf8");
  expect(first.duplicate).toBe(false);
  expect(first.classification).toBe("session-self-assessment");
  const fm = parseFrontmatter(written);
  expect(fm.status).toBe("draft");
  expect(fm.type).toBe("Review Report");
  expect(fm.data["x-llmwiki-review"]).toMatchObject({ classification: "session-self-assessment" });
  expect(fm.data["x-llmwiki-review"]).toMatchObject({ total: 1, bounded: false });
  expect(refreshGapQueue(repo, "2026-10-19")).toMatchObject({ verdict: "refreshed", open: 2 });
  expect(readFileSync(join(repo, page), "utf8")).toBe(before);
  expect(importSessionReview(repo, { snapshot, report }, "2026-10-19").duplicate).toBe(true);
  expect(readFileSync(join(repo, first.path), "utf8")).toBe(written);
  writeFileSync(join(repo, first.path), written + "\nUnrelated mutation\n");
  expect(() => importSessionReview(repo, { snapshot, report }, "2026-10-19")).toThrow("immutable");
  expect(readFileSync(join(repo, first.path), "utf8")).toEndWith("Unrelated mutation\n");
});

test("a forged hash, changed page, duplicate page or out-of-wiki scope cannot be imported", () => {
  const snapshot = prepareSessionReview(repo);
  const forged = structuredClone(snapshot);
  forged.pages[0]!.sha256 = "0".repeat(64);
  expect(() => importSessionReview(repo, { snapshot: forged, report })).toThrow("snapshot changed");
  expect(() => importSessionReview(repo, { snapshot: { ...snapshot, pages: [...snapshot.pages, ...snapshot.pages], total: 2 }, report })).toThrow("duplicate");
  const escaped = structuredClone(snapshot);
  escaped.pages[0]!.page = "docs/wiki/../../evidence.md";
  writeFileSync(join(repo, "evidence.md"), readFileSync(join(repo, page)));
  expect(() => importSessionReview(repo, { snapshot: escaped, report })).toThrow("invalid");
  writePage(page, "Changed decision after review was prepared.");
  expect(() => importSessionReview(repo, { snapshot, report })).toThrow("snapshot changed");
});

test("scope totals, report size and required sections are validated", () => {
  const snapshot = prepareSessionReview(repo);
  for (const total of [-1, 0, 1.5, Number.NaN]) {
    expect(() => importSessionReview(repo, { snapshot: { ...snapshot, total }, report })).toThrow("bounded");
  }
  expect(() => importSessionReview(repo, { snapshot: { ...snapshot, pages: Array(41).fill(snapshot.pages[0]), total: 41 }, report })).toThrow("bounded");
  expect(() => importSessionReview(repo, { snapshot, report: "x".repeat(30001) })).toThrow("bounded");
  expect(() => importSessionReview(repo, { snapshot, report: "## Arbitrary heading\n- x" })).toThrow("sections");
});

test("a caller cannot shrink a real scope or falsify total, and long reviews are marked bounded", () => {
  writePage("docs/wiki/3_decision/other.md", "Second boundary.");
  const snapshot = prepareSessionReview(repo);
  expect(() => importSessionReview(repo, {
    snapshot: { ...snapshot, pages: snapshot.pages.slice(0, 1) }, report,
  })).toThrow("scope changed");
  expect(() => importSessionReview(repo, { snapshot: { ...snapshot, total: 999 }, report })).toThrow("scope changed");
  for (let i = 0; i < 39; i++) writePage("docs/wiki/3_decision/bounded-" + i + ".md", "Distinct bound " + i);
  const full = prepareSessionReview(repo);
  const receipt = importSessionReview(repo, { snapshot: full, report: report.replace("Missing concepts", "Missing concept page") });
  const fm = parseFrontmatter(readFileSync(join(repo, receipt.path), "utf8"));
  expect(fm.data["x-llmwiki-review"]).toMatchObject({ total: 41, bounded: true });
});

test("symlinked snapshot pages and linked local files are rejected", () => {
  const snapshot = prepareSessionReview(repo);
  const outside = join(root, "external.md");
  writeFileSync(outside, "outside evidence");
  const link = "docs/wiki/3_decision/link.md";
  symlinkSync(outside, join(repo, link));
  const forged = { ...snapshot, pages: [{ page: link, sha256: createHash("sha256").update("outside evidence").digest("hex"), excerpt: "outside evidence" }] };
  expect(() => importSessionReview(repo, { snapshot: forged, report })).toThrow("snapshot changed");
  expect(() => importSessionReview(repo, { snapshot, report: report + "\n[Unsafe](../3_decision/link.md)\n" })).toThrow("does not resolve");
  expect(() => importSessionReview(repo, { snapshot, report: report + "\n[Missing](../3_decision/missing.md)\n" })).toThrow("does not resolve");
});

test("http evidence stays a citation while executable and local-file schemes are rejected", () => {
  const snapshot = prepareSessionReview(repo);
  for (const href of ["file:///tmp/evidence.md", "javascript:alert", "data:text/plain,x", "//example.invalid/claim"]) {
    expect(() => importSessionReview(repo, { snapshot, report: report + "\n[Unsafe](" + href + ")\n" })).toThrow("scheme");
  }
  expect(importSessionReview(repo, { snapshot, report: report + "\n[Reference](https://example.invalid/evidence)\n" }).duplicate).toBe(false);
});

test("unenrolled repositories cannot prepare or import session review", () => {
  const other = makeGitRepo(join(root, "unenrolled"));
  expect(() => prepareSessionReview(other)).toThrow("not enrolled");
  expect(() => importSessionReview(other, { snapshot: prepareSessionReview(repo), report })).toThrow("not enrolled");
});
