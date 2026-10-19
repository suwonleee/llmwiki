// Parse citations + cross-references from wiki content, materialize as graph edges.
// Ported from engine/refs.py.
// Citations: footnote defs `[^1]: file.pdf, p.3`. Links: markdown `[t](path.md)`.
import { parseYamlBlock, splitFrontmatter } from "./okf.ts";
import type { Database } from "bun:sqlite";
import type { WikiIndex, DocRow } from "./db.ts";

// refs operates on loose document rows returned by the index (db.ts DocRow).
export type WikiDocument = DocRow;

// Footnote citation defs. Label is ANY token (not just digits) so named footnotes like
// `[^s1]:` (used by 5_topic pages) materialize into graph edges too — must match lint's
// FOOTNOTE_DEF label charset `[^\]]+`, else lint flags citation-graph-mismatch on every
// page whose footnotes the parser silently skipped.
// Link text may carry escaped brackets (`[\[TRUST\] ECS](x.md)` — a page title with brackets,
// as `llmwiki okf` writes it); `[^\]]*` alone stops at the escaped `\]` and loses the edge.
const _WIKI_LINK_RE = /(?<!!)\[(?:[^\]\\]|\\.)*\]\(([^)]+)\)/g;
// Obsidian-style [[target]] / [[target|alias]] / [[target#anchor]] — our pages use these, and the
// markdown-link regex above misses them entirely (→ 0 links_to edges → graph-staleness inert).
const _WIKILINK_BRACKET_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const _SRC_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|html?|md|txt|jsonl)$/;
// Fenced + inline code spans: link/citation syntax shown here is an EXAMPLE, not a real edge.
const _FENCE_RE = /```.*?```|~~~.*?~~~/gs;
const _INLINE_CODE_RE = /`[^`\n]*`/g;

const _IMG_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg)$/i;
const _DASH_SPLIT_RE = /\s+[-–—]\s+/;
const _PAGE_RE = /,\s*p\.?\s*(\d+)\b/;
// Trailing `:N` / `:N-M` line locator on a code-path citation (`src/foo.ts:123`). The `path:line`
// convention is universal (compilers, editors, other tools' citations), so warm sessions keep
// producing it no matter what the skill prose prescribes — rejecting it caused a lint→rework loop
// every close-out. Absorb it like `, p.N`: the number lands in the same locator slot of the
// [filename, number|null] tuple (a graph-edge `page` is just "locator within the source").
// Canonical format stays the bare path; this is input tolerance, not a format change.
const _LINE_SUFFIX_RE = /:(\d+)(?:[-–]\d+)?$/;
const _MD_LINK_HEAD_RE = /^\[([^\]]+)\]\([^)]*\)(.*)$/;

/** OKF source IDs are stable join keys; the footnote prose is only a display label. */
export function citationDeclarations(content: string): { id: string; filename: string; page: number | null; declared: boolean; kind: "local" | "external" | "ambiguous" | "invalid" }[] {
  const { block, body } = splitFrontmatter(content);
  const fm = block === null ? {} : parseYamlBlock(block).data;
  const sources = new Map<string, unknown[]>();
  for (const source of Array.isArray(fm.sources) ? fm.sources : []) {
    if (!source || typeof source !== "object" || typeof source.id !== "string") continue;
    sources.set(source.id, [...(sources.get(source.id) ?? []), source.resource]);
  }
  const out: ReturnType<typeof citationDeclarations> = [];
  for (const m of stripCode(body).matchAll(/^\[\^([^\]]+)\]:[ \t]*(.+)$/gm)) {
    const id = m[1]!;
    const declared = sources.get(id);
    if (!declared) {
      const [filename, page] = parseCitationFilename(m[2]!);
      out.push({ id, filename, page, declared: false, kind: "local" });
      continue;
    }
    const resource = declared[0];
    let filename = typeof resource === "string" ? resource.trim() : "";
    let page: number | null = null;
    // The converter preserves code line locators in resource, e.g. src/api.ts:123.
    // Normalize that locator from the RESOURCE only; URLs and document citations keep their
    // original semantics. Never let a descriptive footnote label choose the target or locator.
    const locator = _LINE_SUFFIX_RE.exec(filename);
    if (locator) {
      const prefix = filename.slice(0, locator.index);
      if (/[./]/.test(prefix) && !prefix.includes(":") && !prefix.startsWith("//") && !_SRC_EXT.test(prefix)) {
        [filename, page] = parseCitationFilename(filename);
      }
    }
    let kind: "local" | "external" | "ambiguous" | "invalid" = "local";
    if (declared.length !== 1) kind = "ambiguous";
    else if (!filename) kind = "invalid";
    else if (/^[a-z][a-z0-9+.-]*:/i.test(filename) || filename.startsWith("//")) kind = "external";
    // Scope descriptors are valid provenance, but do not name a dereferenceable artifact.
    else if (!/[/.]/.test(filename) || (/\s/.test(filename) && !/\.[a-z0-9]+(?:#.*)?$/i.test(filename))) kind = "external";
    out.push({ id, filename, page, declared: true, kind });
  }
  return out;
}

/** Shared by lint and graph. Declared resources never fall back to a colliding basename. */
export function resolveCitation<T extends object>(
  citation: ReturnType<typeof citationDeclarations>[number], pageDir: string, lookup: Readonly<Record<string, T>>,
): T | undefined {
  if (citation.kind !== "local") return undefined;
  const key = lookupKey(citation.filename);
  if (!citation.declared) return lookup[key] ?? lookup[key.replace(_SRC_EXT, "")];
  const resource = decodeHref(citation.filename);
  if (!resource || resource.includes("\\") || /[\x00-\x1f]/.test(resource) || /^[a-z][a-z0-9+.-]*:/i.test(resource) || resource.startsWith("//")) return undefined;
  // Explicit ./ and ../ are document-relative (§6.2); bare sources paths are bundle-relative (§5.1).
  const parts = resource.startsWith("./") || resource.startsWith("../") ? pageDir.split("/").filter(Boolean) : [];
  for (const part of resource.split("/")) {
    if (part === "..") { if (!parts.length) return undefined; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  const path = lookupKey(parts.join("/"));
  const docs = [...new Set(Object.values(lookup))];
  const rel = (d: T) => String((d as { relative_path?: unknown }).relative_path ?? "");
  const hits = docs.filter((d) => lookupKey(rel(d).replace(/^docs\/wiki\//, "")) === path && rel(d).startsWith("docs/wiki/"));
  if (hits.length === 1) return hits[0];
  // Converter-produced provenance can refer to repository code. Exact path only, after bundle
  // resolution; do not reinterpret explicit bundle-absolute or document-relative paths here.
  if (!resource.startsWith("/") && !resource.startsWith(".")) {
    const repoHits = docs.filter((d) => lookupKey(rel(d)) === path);
    if (repoHits.length === 1) return repoHits[0];
  }
  // A bare identifier can name an explicitly registered transcript, including imported .md/.txt
  // sessions. Only autoRegisterCitedTranscripts may invent virtual rows, and only for .jsonl.
  if (/^[^/\s]+$/.test(resource)) {
    const transcripts = docs.filter((d) =>
      (d as { source_kind?: unknown }).source_kind === "transcript" &&
      lookupKey(String((d as { filename?: unknown }).filename)) === key);
    if (transcripts.length === 1) return transcripts[0];
  }
  return undefined;
}

// Self-heal transcript provenance: a wiki page cites its session transcript (`[^1]: <id>.jsonl`),
// but transcripts ROTATE/disappear over time and a fresh index has none registered — so the
// citation breaks (unresolved-citation). Register every `.jsonl` footnote target that isn't already
// an indexed document, as a virtual provenance row. A `.jsonl` citation is unambiguously a transcript
// (never a code path), so this can't mask a wrong code citation; it only preserves the page's
// self-declared origin even after the raw transcript is gone. Idempotent; runs on every index/refs,
// so the fix is durable across full rebuilds. Returns how many were newly registered.
export function autoRegisterCitedTranscripts(w: WikiIndex): number {
  const conn = w.connect();
  const wanted = new Set<string>();
  try {
    const all = w.listDocumentsWithContent(conn);
    const existing = new Set(all.map((d) => String(d.filename).toLowerCase()));
    for (const d of all) {
      if (!String(d.relative_path).includes("docs/wiki/")) continue;
      for (const c of citationDeclarations(String(d.content || ""))) {
        if (c.kind === "local" && /^[^\s/:\\]+\.jsonl$/.test(c.filename) && !existing.has(c.filename.toLowerCase())) wanted.add(c.filename);
      }
    }
  } finally {
    conn.close();
  }
  for (const fn of wanted) w.registerTranscript(fn);
  return wanted.size;
}

// v3 evidence lines: the indented blockquote continuation under a footnote definition
//   [^s1]: <id>.jsonl
//       > [2026-06-29 14:02 user] "…verbatim excerpt…"
// Column-0 blockquotes (`> [conflict] …` callouts) are real body content and are NOT matched.
const _EVIDENCE_LINE_RE = /^[ \t]{2,}>[ \t].*$/gm;

// Drop evidence lines before FTS chunking. Evidence exists so a TEAMMATE can read a claim's
// grounding — it is not itself a claim to retrieve. Indexing it measurably hurts: the excerpt
// lengthens the chunk that carries the claim, and BM25's length normalization then lowers that
// page's own score for its own topic (measured 2026-07-20: a decision page fell rank 5 → 6 on its
// own question once excerpts were added). Stripping keeps claim chunks short, holds the index size
// flat as evidence accumulates, and preserves the "wiki grows, retrieval unchanged" property.
// The lines stay in the FILE (readable, lintable, git-diffable) — only the search index skips them.
export function stripEvidence(content: string): string {
  return content.replace(_EVIDENCE_LINE_RE, "");
}

export function stripCode(content: string): string {
  // Blank out fenced + inline code so link syntax written as an example
  // (e.g. `[텍스트](경로)`, `[[wikilink]]`) isn't parsed as a real link. A page
  // documenting wiki-link syntax must not self-quarantine on a dangling link to
  // its own example href. Shared with lint so graph + lint agree on what's a link.
  content = content.replace(_FENCE_RE, " ");
  content = content.replace(_INLINE_CODE_RE, " ");
  return content;
}

export function parseCitationFilename(raw: string): [string, number | null] {
  raw = raw.trim().replace(/^\*+/, "").replace(/\*+$/, "");
  const m = _MD_LINK_HEAD_RE.exec(raw);
  if (m) {
    raw = `${m[1]}${m[2]}`;
  }
  raw = raw.split(_DASH_SPLIT_RE, 1)[0]!.trim();
  const pm = _PAGE_RE.exec(raw);
  if (pm) {
    return [raw.slice(0, pm.index).trim(), parseInt(pm[1]!, 10)];
  }
  // Only strip a `:N` suffix when the prefix looks like a path (`.` or `/`) — a malformed
  // citation like `12:30` must stay intact so unresolved-citation reports what was written.
  // Document-type targets (_SRC_EXT: .jsonl/.pdf/.md/…) are also left intact: line suffixes are
  // a CODE-path convention, and several transcript consumers (autoRegisterCitedTranscripts,
  // ensureExcerpts) anchor on a bare `.jsonl$` — stripping here but not there would make
  // `x.jsonl:12` resolve in one place and dangle in another. Left intact it fails one way,
  // visibly (unresolved-citation).
  const lm = _LINE_SUFFIX_RE.exec(raw);
  if (lm && lm.index > 0) {
    const prefix = raw.slice(0, lm.index);
    if (/[./]/.test(prefix) && !_SRC_EXT.test(prefix)) {
      return [prefix.trim(), parseInt(lm[1]!, 10)];
    }
  }
  return [raw, null];
}

// Markdown link hrefs that can name a page: external URLs, in-page anchors and images are not
// edges. Raw (still percent-encoded); callers resolve them against the linking page's folder.
function markdownHrefs(content: string): string[] {
  const out: string[] = [];
  for (const match of stripCode(content).matchAll(_WIKI_LINK_RE)) {
    const href = match[1]!.trim();
    if (href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("data:")) {
      continue;
    }
    if (_IMG_EXT_RE.test(href.split("#")[0]!)) continue;
    out.push(href);
  }
  return out;
}

/** An href's path part, percent-decoded: `a%20b.md#x` → `a b.md`, encoded Hangul → Hangul. */
export function decodeHref(href: string): string {
  const bare = href.split("#")[0]!.trim();
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare; // a stray `%` is a literal character, not an encoding
  }
}

// `a/./b/../c` → `a/c`; a `..` above the bundle root is dropped (the link cannot leave the wiki).
function normalizeBundlePath(path: string): string {
  const out: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

/**
 * Where a markdown href points, as wiki-root-relative paths, best reading first.
 *
 * OKF links are relative to the LINKING PAGE'S folder (`../5_topic/x.md` from `3_decision/a.md` is
 * `5_topic/x.md`), and a bundle-absolute `/5_topic/x.md` is relative to the wiki root. Pre-OKF
 * pages also wrote `5_topic/x.md` from inside a category folder meaning the wiki root, so a bare
 * nested href keeps that legacy reading as a second candidate.
 */
export function hrefCandidates(href: string, pageDir: string): string[] {
  const h = decodeHref(href);
  if (!h) return [];
  if (h.startsWith("/")) return [normalizeBundlePath(h)].filter(Boolean);
  const dir = normalizeBundlePath(pageDir);
  const rel = normalizeBundlePath(dir ? `${dir}/${h}` : h);
  const out = rel ? [rel] : [];
  if (dir && h.includes("/") && !h.startsWith("./") && !h.startsWith("../")) out.push(normalizeBundlePath(h));
  return out;
}

export function parseWikiLinks(content: string, currentDir: string): string[] {
  const paths: string[] = [];
  for (const href of markdownHrefs(content)) {
    const best = hrefCandidates(href, currentDir)[0];
    if (best) paths.push(best);
  }
  paths.push(...parseWikiLinkTargets(content));
  return paths;
}

/**
 * `[[target]]` / `[[target|alias]]` / `[[target#anchor]]` targets, code spans excluded.
 *
 * Targets are raw: a path-qualified one ('5_topic/foo') resolves via relpath + '.md', a bare one
 * ('current-state') by filename. No relative rewrite. Shared with lint so a dangling-link warning
 * can only ever be raised about a link the indexer also failed to turn into an edge.
 */
export function parseWikiLinkTargets(content: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(content).matchAll(_WIKILINK_BRACKET_RE)) {
    const t = m[1]!.trim();
    if (t && !t.startsWith("http") && !t.startsWith("#") && !t.startsWith("../")) {
      out.push(t);
    }
  }
  return out;
}

// The lookup key for a path, filename, title or link target: case-folded AND Unicode-normalized.
//
// Normalization matters as much as case. The same Korean, Japanese or Chinese filename exists in
// two byte forms — composed (NFC, 언어 = 2 code points) and decomposed (NFD, ᄋ+ᅥ+ᆫ… = 4) — and
// which one lands on disk depends on the tool, not the author: macOS Finder, `unzip`, and
// iCloud/Dropbox sync all decompose, while a keyboard and git generally compose. Compared raw,
// those are simply different strings, so `[[5_topic/언어-설정]]` resolves to nothing and the
// failure is silent: no edge is created, and the page quietly reads as an orphan.
export function lookupKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export interface LinkIndex {
  readonly byName: Record<string, WikiDocument>;
  readonly byRelpath: Record<string, WikiDocument>;
}

/** Name/path lookup for turning a citation or `[[wikilink]]` into a graph edge. */
export function buildLinkIndex(docs: readonly WikiDocument[]): LinkIndex {
  const byName: Record<string, WikiDocument> = {};
  const byRelpath: Record<string, WikiDocument> = {};
  for (const d of docs) {
    const fn = lookupKey(d.filename);
    if (!(fn in byName)) byName[fn] = d;
    const stripped = fn.replace(_SRC_EXT, "");
    if (!(stripped in byName)) byName[stripped] = d;
    // key by relative path too, so code-path citations (`engine/db.py`) resolve
    // to a graph edge — must match lint's _source_lookup resolution.
    const rp = lookupKey(d.relative_path);
    if (!(rp in byName)) byName[rp] = d;
    if (d.title) {
      const tl = lookupKey(d.title);
      if (!(tl in byName)) byName[tl] = d;
    }
    byRelpath[rp] = d;
    if (d.relative_path.includes("docs/wiki/")) {
      byRelpath[lookupKey(d.relative_path.split("docs/wiki/")[1]!)] = d;
    }
  }
  return { byName, byRelpath };
}

/**
 * The page a `[[wikilink]]` points at, or undefined when it points at nothing.
 *
 * Single source of truth on purpose: lint reports a link as dangling exactly when this returns
 * undefined, so a warning can never disagree with the graph the indexer actually built.
 */
export function resolveWikiLink(link: string, index: LinkIndex): WikiDocument | undefined {
  const key = lookupKey(link.split("#")[0]!);
  return index.byRelpath[key] ?? index.byRelpath[`${key}.md`] ?? index.byName[key.split("/").pop()!];
}

/**
 * The page a markdown link points at: by path from the linking page's folder (then the legacy
 * root-relative reading), else by filename — the same fallback a `[[wikilink]]` gets.
 */
export function resolveMarkdownLink(href: string, pageDir: string, index: LinkIndex): WikiDocument | undefined {
  const candidates = hrefCandidates(href, pageDir);
  if (!candidates.length) return undefined;
  for (const c of candidates) {
    const key = lookupKey(c);
    const hit = index.byRelpath[key] ?? index.byRelpath[`${key}.md`];
    if (hit) return hit;
  }
  return index.byName[lookupKey(candidates[0]!).split("/").pop()!];
}

/** A wiki page's folder relative to docs/wiki (`3_decision`), `""` for a root page. */
export function wikiPageDir(document: Readonly<Record<string, unknown>>): string {
  // relative_path is the file; `path` is its folder (`/docs/wiki/3_decision/`) in the index but a
  // caller may hand a file path there, so the folder is derived from the file whenever possible.
  const rel = String(document.relative_path ?? "");
  const inWiki = rel.includes("docs/wiki/") ? rel.split("docs/wiki/").pop()! : null;
  if (inWiki !== null) return inWiki.includes("/") ? inWiki.slice(0, inWiki.lastIndexOf("/")) : "";
  const p = String(document.path ?? "");
  if (!p.includes("/docs/wiki/")) return "";
  const after = p.split("/docs/wiki/").pop()!;
  const dir = /\.md$/i.test(after) ? after.slice(0, Math.max(0, after.lastIndexOf("/"))) : after;
  return normalizeBundlePath(dir);
}

/** Pure edge derivation, shared with freshness verification so stale graphs cannot certify a page. */
export function referenceEdges(document: WikiDocument, content: string, documents: readonly WikiDocument[]): [string, string, number | null][] {
  // Rebuild this document's outgoing edges. document = object with id, path, relative_path.
  const docId = String(document.id);
  const wikiRelDir = wikiPageDir(document);

  const linkIndex = buildLinkIndex(documents);

  const edges: [string, string, number | null][] = [];
  for (const citation of citationDeclarations(content)) {
    const page = citation.page;
    const target = resolveCitation(citation, wikiRelDir, linkIndex.byName);
    if (target && String(target.id) !== docId) {
      edges.push([String(target.id), "cites", page]);
    }
  }

  for (const href of markdownHrefs(content)) {
    const target = resolveMarkdownLink(href, wikiRelDir, linkIndex);
    if (target && String(target.id) !== docId) {
      edges.push([String(target.id), "links_to", null]);
    }
  }
  for (const link of parseWikiLinkTargets(content)) {
    const target = resolveWikiLink(link, linkIndex);
    if (target && String(target.id) !== docId) {
      edges.push([String(target.id), "links_to", null]);
    }
  }

  return edges;
}

export function updateReferences(
  index: WikiIndex,
  conn: Database,
  document: WikiDocument,
  content: string,
): [number, number] {
  const docId = String(document.id);
  const edges = referenceEdges(document, content, index.listDocuments(conn));

  index.deleteReferences(conn, docId);
  const seen = new Set<string>();
  let cites = 0;
  let links = 0;
  for (const [targetId, refType, page] of edges) {
    const k = `${targetId}\0${refType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    index.upsertReference(conn, docId, targetId, refType, page);
    if (refType === "cites") {
      cites += 1;
    } else {
      links += 1;
    }
  }
  // bun:sqlite autocommits per statement; no explicit commit() needed.
  return [cites, links];
}

/** Rebuild the complete citation/link graph after an index refresh.
 *
 * This is shared by the normal `index`/`reindex` commands and `wiki-doctor --fix`.
 * Keeping one implementation prevents a repair path from producing a subtly different graph
 * than the everyday indexing path.
 */
/**
 * Read the already-materialized graph without rebuilding it — for the `index` no-op path, where
 * not one page was added, changed, or deleted, so the edges cannot have changed either. Zero
 * edges alone cannot answer "built or never built?" — the 'refs-built' marker (stamped by
 * rebuildReferenceGraph) does. This matters most for exactly the wikis that look least like the
 * author's: a NEW adopter's wiki has few or no [[links]] yet, and without the marker every
 * `index` re-ran the full graph rebuild forever (measured: 9.7s per no-op at 2000 link-less
 * pages, vs 0.3s for the indexing itself).
 */
export function referenceGraphCounts(index: WikiIndex): {
  readonly citations: number;
  readonly links: number;
  readonly pages: number;
} | null {
  const conn = index.connect();
  try {
    // Edges are reusable only when a rebuild committed its completion marker. A non-empty graph
    // can still be the residue of an older build after the indexed documents changed, so edge
    // count is never a substitute for the marker.
    const built = conn.query("SELECT 1 FROM index_build WHERE key = 'refs-built'").get() !== null;
    if (!built) return null;
    const byType = conn
      .query("SELECT reference_type, COUNT(*) AS n FROM document_references GROUP BY reference_type")
      .all() as { reference_type: string; n: number }[];
    const citations = byType.find((r) => r.reference_type === "cites")?.n ?? 0;
    const links = byType.find((r) => r.reference_type === "links_to")?.n ?? 0;
    // Same population the rebuild reports: wiki pages, not sources or transcripts.
    const pages = (
      conn.query("SELECT COUNT(*) AS n FROM documents WHERE relative_path LIKE '%docs/wiki/%'").get() as { n: number }
    ).n;
    return { citations, links, pages };
  } finally {
    conn.close();
  }
}

export function rebuildReferenceGraph(index: WikiIndex): {
  readonly citations: number;
  readonly links: number;
  readonly pages: number;
  readonly transcriptsRegistered: number;
} {
  const transcriptsRegistered = autoRegisterCitedTranscripts(index);
  const conn = index.connect();
  let transactionStarted = false;
  try {
    // Invalidate any older completion marker before starting. If this rebuild is interrupted,
    // SQLite rolls its graph writes back, while the absent marker prevents a later no-op index
    // from mistaking that older graph for the current documents' completed build.
    conn.run("DELETE FROM index_build WHERE key = 'refs-built'");
    conn.run("BEGIN IMMEDIATE");
    transactionStarted = true;

    const docs = index
      .listDocumentsWithContent(conn)
      .filter((document) => String(document.relative_path).includes("docs/wiki/"));
    let citations = 0;
    let links = 0;
    for (const document of docs) {
      const [documentCitations, documentLinks] = updateReferences(
        index,
        conn,
        document,
        String(document.content ?? ""),
      );
      citations += documentCitations;
      links += documentLinks;
    }
    // Stamped in the same transaction as every edge: this marker means the complete graph was
    // committed, never merely that a rebuild was attempted.
    conn.run(
      "INSERT INTO index_build (key, value) VALUES ('refs-built', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    );
    conn.run("COMMIT");
    transactionStarted = false;
    return { citations, links, pages: docs.length, transcriptsRegistered };
  } catch (error) {
    if (transactionStarted) {
      try {
        conn.run("ROLLBACK");
      } catch {
        // Preserve the rebuild error. SQLite also rolls back an open transaction on close.
      }
    }
    throw error;
  } finally {
    conn.close();
  }
}
