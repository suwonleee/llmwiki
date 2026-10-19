// Provider-free semantic review, invoked only by an explicit /wiki-deep session. The current
// session supplies judgments; the engine binds them to unchanged pages and imports a draft report.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { getConfig } from "./config.ts";
import { isEnrolledFresh } from "./enrollment.ts";
import { loadWikiPages } from "./page-rank.ts";
import { canonicalRoot, readRepoFileBytes, repoFileMtime, ensureRepoDir, createRepoFile } from "./repo-write.ts";
import { okfStamp } from "./autoupdate.ts";
import { screenOutbound } from "./claude.ts";
import { today } from "./today.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { splitFrontmatter } from "./okf.ts";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const MAX_PAGES = 40;
export interface SessionReviewSnapshot {
  schema_version: 1; root: string;
  pages: { page: string; sha256: string; excerpt: string }[];
  total: number;
}

export function prepareSessionReview(root: string): SessionReviewSnapshot {
  if (!isEnrolledFresh(root)) throw new Error("repository not enrolled");
  const canonical = canonicalRoot(root);
  const pages = loadWikiPages(canonical).filter(p => !p.retired)
    .map(p => ({ page: `docs/wiki/${p.rel}`, excerpt: (p.snippetBody ?? p.body).slice(0, 450), mtime: repoFileMtime(canonical, `docs/wiki/${p.rel}`) ?? 0 }))
    .sort((a,b)=>b.mtime-a.mtime || a.page.localeCompare(b.page));
  return { schema_version: 1, root: canonical, total: pages.length,
    pages: pages.slice(0, MAX_PAGES).flatMap(p => {
      const bytes = readRepoFileBytes(canonical, p.page);
      return bytes === null ? [] : [{ page: p.page, sha256: hash(bytes), excerpt: p.excerpt }];
    }) };
}

export function importSessionReview(root: string, input: unknown, date = today()) {
  if (!isEnrolledFresh(root)) throw new Error("repository not enrolled");
  const v = input as { snapshot: SessionReviewSnapshot; report: string };
  const s = v?.snapshot;
  if (!s || s.schema_version !== 1 || s.root !== canonicalRoot(root) || !Array.isArray(s.pages) ||
      !s.pages.length || s.pages.length > MAX_PAGES || typeof v.report !== "string" || v.report.length > 30000 ||
      !Number.isSafeInteger(s.total) || s.total < s.pages.length ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("current review-input snapshot and bounded Markdown report required");
  if (!/^##\s+(?:Missing concepts|Missing concept pages?|개념 누락)/mi.test(v.report) ||
      !/^##\s+(?:Next questions|다음 질문|Cross-references|교차참조)/mi.test(v.report))
    throw new Error("report requires ## Missing concepts and ## Next questions sections (use (none) when empty)");
  const known = new Set<string>();
  for (const p of s.pages) {
    if (!p || typeof p.page !== "string" || !p.page.startsWith("docs/wiki/") ||
        !p.page.endsWith(".md") || /[\\\0]/.test(p.page) || p.page.split("/").some(part => !part || part === "." || part === "..") ||
        !/^[a-f0-9]{64}$/.test(p.sha256) || known.has(p.page))
      throw new Error("invalid or duplicate review page");
    const bytes = readRepoFileBytes(root, p.page);
    if (bytes === null || hash(bytes) !== p.sha256) throw new Error(`review snapshot changed: ${p.page}`);
    known.add(p.page);
  }
  // A caller cannot fabricate a selective scope and claim it was the full bounded review.
  // Excerpts remain navigation hints; page hashes and the current selected page set bind it.
  const current = prepareSessionReview(root);
  const identity = (pages: SessionReviewSnapshot["pages"]) => JSON.stringify(
    pages.map(p => [p.page, p.sha256]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
  if (s.total !== current.total || identity(s.pages) !== identity(current.pages))
    throw new Error("review snapshot scope changed; prepare current review-input again");
  const screened = screenOutbound({ report: v.report });
  if (!screened || screened.report !== v.report) throw new Error("review contains screened secret material");
  const cfg = getConfig(root);
  for (const m of v.report.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = m[1]!.split("#")[0]!;
    if (!href) continue;
    if (/^https?:\/\//i.test(href)) continue; // cited remote evidence, never fetched or executed
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
      throw new Error("review link uses an unsupported scheme");
    const rel = posix.normalize(posix.join("docs/wiki", cfg.queueDir, href));
    if (readRepoFileBytes(root, rel) === null) throw new Error(`review link does not resolve: ${href}`);
  }
  const scopeHash = hash(JSON.stringify(s.pages.map(p => [p.page,p.sha256])));
  const reportHash = hash(v.report);
  const name = `semantic-review-${date}-${scopeHash.slice(0,8)}-${reportHash.slice(0,8)}.md`;
  const rel = `${cfg.queueDir}/${name}`;
  const report = okfStamp(root, rel, v.report, cfg, {
    actor: "llmwiki-session-review/1",
    set: { type: "Review Report", title: `Session review ${date}`, description: "Session-authored advisory review bound to page snapshots", status: "draft", date,
      sources: [{ resource: "semantic-lint" }], "x-llmwiki-review": { scope_sha256: scopeHash, pages: s.pages.map(p => ({page:p.page,sha256:p.sha256})), total: s.total, included: s.pages.length, bounded: s.total > s.pages.length, classification: "session-self-assessment" } },
  });
  ensureRepoDir(root, `docs/wiki/${cfg.queueDir}`);
  const path = `docs/wiki/${rel}`;
  if (!createRepoFile(root, path, report + "\n")) {
    const prior = readRepoFileBytes(root,path);
    if (prior === null) throw new Error("review destination is unsafe");
    // Re-import is idempotent only while the original immutable report still matches.
    // Generated timestamps can differ across invocations, so compare the normalized body
    // and scope metadata, not a new stamp's wall-clock field.
    const priorScope = parseFrontmatter(prior.toString("utf8")).data["x-llmwiki-review"];
    const expectedScope = parseFrontmatter(report).data["x-llmwiki-review"];
    if (JSON.stringify(priorScope) !== JSON.stringify(expectedScope) ||
        splitFrontmatter(prior.toString("utf8")).body.trim() !== splitFrontmatter(report).body.trim())
      throw new Error("review destination changed; immutable report cannot be replaced");
    return { path, duplicate: true, classification: "session-self-assessment" };
  }
  return { path, duplicate: false, classification: "session-self-assessment" };
}
