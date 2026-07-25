// Parse citations + cross-references from wiki content, materialize as graph edges.
// Ported from engine/refs.py.
// Citations: footnote defs `[^1]: file.pdf, p.3`. Links: markdown `[t](path.md)`.
import type { Database } from "bun:sqlite";
import type { WikiIndex, DocRow } from "./db.ts";

// refs operates on loose document rows returned by the index (db.ts DocRow).
export type WikiDocument = DocRow;

// Footnote citation defs. Label is ANY token (not just digits) so named footnotes like
// `[^s1]:` (used by 5_topic pages) materialize into graph edges too — must match lint's
// FOOTNOTE_DEF label charset `[^\]]+`, else lint flags citation-graph-mismatch on every
// page whose footnotes the parser silently skipped.
const _CITATION_RE = /\[\^[^\]]+\]:\s*(.+)$/gm;
const _WIKI_LINK_RE = /(?<!!)\[(?:[^\]]*)\]\(([^)]+)\)/g;
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

// Self-heal transcript provenance: a wiki page cites its session transcript (`[^1]: <id>.jsonl`),
// but transcripts ROTATE/disappear over time and a fresh index has none registered — so the
// citation breaks (unresolved-citation). Register every `.jsonl` footnote target that isn't already
// an indexed document, as a virtual provenance row. A `.jsonl` citation is unambiguously a transcript
// (never a code path), so this can't mask a wrong code citation; it only preserves the page's
// self-declared origin even after the raw transcript is gone. Idempotent; runs on every index/refs,
// so the fix is durable across full rebuilds. Returns how many were newly registered.
export function autoRegisterCitedTranscripts(w: WikiIndex): number {
  const conn = w.connect();
  const all = w.listDocumentsWithContent(conn);
  const existing = new Set(all.map((d) => String(d.filename).toLowerCase()));
  const wanted = new Set<string>();
  for (const d of all) {
    if (!String(d.relative_path).includes("docs/wiki/")) continue;
    for (const m of String(d.content || "").matchAll(/^\[\^[^\]]+\]:\s*([^\s/]+\.jsonl)\s*$/gm)) {
      if (!existing.has(m[1]!.toLowerCase())) wanted.add(m[1]!);
    }
  }
  conn.close();
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

export function parseWikiLinks(content: string, currentDir: string): string[] {
  content = stripCode(content); // ignore example link syntax inside code spans/fences
  const paths: string[] = [];
  // Reset lastIndex defensively (global regexes carry state across calls).
  _WIKI_LINK_RE.lastIndex = 0;
  for (const match of content.matchAll(_WIKI_LINK_RE)) {
    const href = match[1]!;
    if (href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("data:")) {
      continue;
    }
    if (_IMG_EXT_RE.test(href)) {
      continue;
    }
    let resolved: string;
    if (href.startsWith("./")) {
      resolved = currentDir ? currentDir + href.slice(2) : href.slice(2);
    } else if (href.startsWith("../")) {
      const parts = (currentDir.replace(/\/+$/, "") + "/" + href).split("/");
      const rp: string[] = [];
      for (const p of parts) {
        if (p === "..") {
          if (rp.length) rp.pop();
        } else if (p && p !== ".") {
          rp.push(p);
        }
      }
      resolved = rp.join("/");
    } else if (!href.includes("/")) {
      resolved = currentDir ? currentDir + href : href;
    } else {
      resolved = href;
    }
    if (resolved) {
      paths.push(resolved);
    }
  }
  // [[wikilink]] targets — pass raw (path-qualified like 'milestones/foo' resolves via relpath+'.md';
  // bare like 'current-state' resolves by filename in updateReferences). No relative rewrite.
  for (const m of content.matchAll(_WIKILINK_BRACKET_RE)) {
    const t = m[1]!.trim();
    if (t && !t.startsWith("http") && !t.startsWith("#") && !t.startsWith("../")) {
      paths.push(t);
    }
  }
  return paths;
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

export function updateReferences(
  index: WikiIndex,
  conn: Database,
  document: WikiDocument,
  content: string,
): [number, number] {
  // Rebuild this document's outgoing edges. document = object with id, path, relative_path.
  const docId = String(document.id);
  const docDir = document.path;
  let wikiRelDir = "";
  // current dir relative to the wiki root, for resolving sibling links
  if (docDir.includes("/docs/wiki/")) {
    wikiRelDir = docDir.split("/docs/wiki/")[1] ?? "";
  }

  const linkIndex = buildLinkIndex(index.listDocuments(conn));

  const edges: [string, string, number | null][] = [];
  for (const m of content.matchAll(_CITATION_RE)) {
    const [filename, page] = parseCitationFilename(m[1]!);
    const key = lookupKey(filename);
    const target = linkIndex.byName[key] ?? linkIndex.byName[key.replace(_SRC_EXT, "")];
    if (target && String(target.id) !== docId) {
      edges.push([String(target.id), "cites", page]);
    }
  }

  for (const link of parseWikiLinks(content, wikiRelDir)) {
    const target = resolveWikiLink(link, linkIndex);
    if (target && String(target.id) !== docId) {
      edges.push([String(target.id), "links_to", null]);
    }
  }

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
export function rebuildReferenceGraph(index: WikiIndex): {
  readonly citations: number;
  readonly links: number;
  readonly pages: number;
  readonly transcriptsRegistered: number;
} {
  const transcriptsRegistered = autoRegisterCitedTranscripts(index);
  const conn = index.connect();
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
  conn.close();
  return { citations, links, pages: docs.length, transcriptsRegistered };
}
