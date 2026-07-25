// WikiIndex — synchronous SQLite index over a workspace (markdown = source of truth).
// The index is derived state: delete .llmwiki/index.db and rebuild from disk anytime.
// bun:sqlite-based. Methods that take a `db: Database` operate on an explicit
// connection the caller opens/closes.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative as relpath, resolve } from "node:path";
import { storeChunks, chunkText } from "./chunker.ts";
import { stripEvidence } from "./refs.ts";
import { getConfig } from "./config.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import {
  COLD_INDEX_RELATIVE_PATH,
  coldDiscoveryChunk,
  isColdTier,
  readColdPageBody,
  writeColdIndex,
} from "./cold-index.ts";

const SCHEMA_PATH = join(import.meta.dir, "schema.sql");
const SCHEMA = readFileSync(SCHEMA_PATH, "utf-8");

const IGNORE_DIRS = new Set([
  ".llmwiki", ".git", "node_modules", "__pycache__", ".venv", "venv",
  ".idea", ".vscode", ".pytest_cache", ".mypy_cache",
  "dist", "build", ".next", ".cache", ".gradle", "coverage", "Pods",
  "examples", "fixtures", "testdata", "__fixtures__", // sample/fixture trees are illustration, not knowledge sources
]);
const GENERATED_DIRS = new Set(["out", "output", "var"]);
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "csv", "html", "svg", "json", "xml", "yaml", "yml",
  "toml", "ini", "cfg", "rst", "tex",
]);
const WIKI_DIR = "docs/wiki";

export interface DocRow {
  [k: string]: any;
  tags?: string[] | string;
}

function sha256(path: string): string | null {
  try {
    if (statSync(path).size < 100_000_000) {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  } catch {
    return null;
  }
  return null;
}

function sourceKind(relative: string): string {
  return relative.startsWith(WIKI_DIR + "/") ? "wiki" : "source";
}

// Python str.title(): capitalize first letter of each alphabetic run, lower the rest.
// Non-alpha (digits, Hangul, spaces) are word boundaries; Hangul has no case → unchanged.
function titleCase(s: string): string {
  return s.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());
}

// Sanitize a free-text query into a safe FTS5 MATCH string. Raw user input may contain FTS5
// operators (- : * ^ ( ) " OR AND NEAR) — passing it straight to MATCH throws (e.g. a query
// like "native-epub" yields `SQLiteError: no such column: epub`). We split on whitespace and
// wrap each word-bearing token as a quoted string literal (doubling any embedded quote), so
// every term is matched literally with implicit AND between them and no token is ever parsed
// as syntax. Punctuation-only tokens are dropped; an all-punctuation/empty query → "" (the
// caller returns no rows rather than issuing an empty MATCH). Power-user FTS syntax is
// intentionally unsupported here — robustness over expressivity for natural-language queries.
export function ftsSanitize(query: string): string {
  return (query || "")
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

// Relaxed-recall fallback (P0-3, ported from basic-memory's AND→OR retry — adapted for
// trigram/CJK): when the strict all-terms query returns 0 rows, retry ONCE with the same
// terms OR-joined so any-term matches rank by bm25. Gating (skip → return null):
//   - user signalled exact intent: embedded quote, or explicit boolean (` AND `/` OR `/` NOT `)
//   - fewer than 2 word-bearing tokens (single-term queries gain nothing from OR;
//     unspaced CJK arrives as one token and already gets trigram substring matching)
//   - any purely-numeric token (IDs like "SPEC 16" — OR-relaxing floods false positives;
//     known recall-loss tradeoff: legitimate "summarize 5 decisions"-style queries also skip — revisit
//     via `llmwiki bench` if it shows up in golden-set misses)
// Unlike basic-memory: token detection is Unicode (\p{L}\p{N}, not [A-Za-z0-9] — else CJK
// queries never relax), and no prefix `*` (meaningless under the trigram tokenizer) and no
// English stopword list (language-neutral; corpus <100k so over-expansion risk is low).
export function ftsRelax(query: string): string | null {
  const q = (query || "").trim();
  if (!q || q.includes('"')) return null;
  const padded = ` ${q} `;
  if (padded.includes(" AND ") || padded.includes(" OR ") || padded.includes(" NOT ")) return null;
  const tokens = q.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length < 2) return null;
  if (tokens.some((t) => /^\p{N}+$/u.test(t))) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// Recursive top-down walk with in-place dir pruning (replaces Python os.walk + dirs[:]).
function* walkFiles(walkRoot: string, workspaceRoot: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(walkRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  const files: string[] = [];
  const relativeDir = relpath(workspaceRoot, walkRoot).replace(/\\/g, "/");
  const isWikiDir = relativeDir === WIKI_DIR || relativeDir.startsWith(WIKI_DIR + "/");
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name) && (isWikiDir || !GENERATED_DIRS.has(e.name)) && !e.name.startsWith(".")) {
        subdirs.push(e.name);
      }
    } else if (e.isFile()) {
      if (!e.name.startsWith(".")) files.push(e.name);
    }
  }
  for (const fn of files) yield join(walkRoot, fn);
  for (const d of subdirs) yield* walkFiles(join(walkRoot, d), workspaceRoot);
}

export class WikiIndex {
  root: string;
  dbPath: string;
  static SOURCE_FILE_CAP = 5000;
  // Per-file content cap for SOURCE files. Large data files
  // (multi-MB yaml/json fixtures) bloat the trigram index ~5-6x their raw size while
  // adding little search value. Over the cap the file is registered metadata-only
  // (still findable by name/path) — no content, no chunks. Wiki pages are exempt
  // (they ARE the knowledge base). Override: LLMWIKI_MAX_SOURCE_BYTES.
  static SOURCE_CONTENT_CAP = (() => {
    const v = parseInt(process.env.LLMWIKI_MAX_SOURCE_BYTES ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : 256 * 1024;
  })();
  static CITABLE = ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "html", "htm", "txt"];

  constructor(workspace: string) {
    this.root = resolve(workspace);
    this.dbPath = join(this.root, ".llmwiki", "index.db");
  }

  // ---- lifecycle --------------------------------------------------------

  init(): void {
    mkdirSync(join(this.root, WIKI_DIR), { recursive: true });
    mkdirSync(join(this.root, ".llmwiki", "cache"), { recursive: true });
    const db = this.connect();
    db.close();
  }

  connect(): Database {
    mkdirSync(join(this.root, ".llmwiki"), { recursive: true });
    const db = new Database(this.dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000"); // migration DDL vs a concurrent daemon write → wait, not SQLITE_BUSY
    this.migrateFts(db); // must run BEFORE exec(SCHEMA): drop the old-tokenizer table first
    db.exec(SCHEMA); // idempotent (IF NOT EXISTS) → any command self-initializes
    this.migrateFrontmatterMetadata(db);
    const ws = db.query("SELECT 1 FROM workspace LIMIT 1").get();
    if (!ws) {
      db.run("INSERT INTO workspace (id, name, root_path) VALUES (?, ?, ?)", [
        crypto.randomUUID(),
        this.basename(this.root),
        this.root,
      ]);
    }
    return db;
  }

  private basename(p: string): string {
    const parts = p.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1]! : p;
  }

  // Tokenizer migration: DBs created before the trigram switch carry a
  // 'porter unicode61' chunks_fts. The index is derived state, so the migration is just:
  // drop the old FTS table + its triggers (SCHEMA recreates them with trigram) and
  // repopulate from document_chunks. Idempotent — a trigram table is left untouched.
  private migrateFts(db: Database): void {
    const row = db
      .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
      .get() as { sql: string } | null;
    if (!row || row.sql.includes("trigram")) return;
    // One transaction, so an interruption rolls back to the old porter table (which
    // re-triggers migration next run) instead of committing an EMPTY trigram table that
    // the guard above would then treat as done — a silent, non-self-healing search outage.
    // The PRAGMAs inside SCHEMA are no-ops within a transaction; the DDL is transactional.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_delete");
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_update");
      db.exec("DROP TABLE chunks_fts");
      db.exec(SCHEMA); // recreate table + triggers with the trigram tokenizer
      db.exec("INSERT INTO chunks_fts(rowid, content) SELECT rowid, content FROM document_chunks");
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  private migrateFrontmatterMetadata(db: Database): void {
    const columns = new Set(
      db.query<{ readonly name: string }, []>("PRAGMA table_info(documents)").all().map((column) => column.name),
    );
    if (!columns.has("description")) {
      db.exec("ALTER TABLE documents ADD COLUMN description TEXT");
    }
    if (!columns.has("knowledge_status")) {
      db.exec("ALTER TABLE documents ADD COLUMN knowledge_status TEXT CHECK (knowledge_status IN ('draft', 'ready', 'superseded'))");
    }
    if (!columns.has("knowledge_tier")) {
      db.exec("ALTER TABLE documents ADD COLUMN knowledge_tier TEXT CHECK (knowledge_tier IN ('hot', 'warm', 'cold', 'protected'))");
    }
    const rows = db
      .query<
        { readonly id: string; readonly content: string | null; readonly relative_path: string; readonly knowledge_tier: string | null },
        []
      >(
        "SELECT id, content, relative_path, knowledge_tier FROM documents WHERE source_kind='wiki'",
      )
      .all();
    for (const row of rows) {
      const content = row.content ?? (row.knowledge_tier === "cold" ? readColdPageBody(this.root, row.relative_path) : "");
      const metadata = parseFrontmatter(content);
      const tags = JSON.stringify(metadata.tags);
      db.run(
        "UPDATE documents SET description=?, date=?, tags=?, knowledge_status=?, knowledge_tier=? " +
          "WHERE id=? AND (description IS NOT ? OR date IS NOT ? OR tags IS NOT ? OR knowledge_status IS NOT ? OR knowledge_tier IS NOT ?)",
        [
          metadata.description,
          metadata.date,
          tags,
          metadata.status,
          metadata.tier,
          row.id,
          metadata.description,
          metadata.date,
          tags,
          metadata.status,
          metadata.tier,
        ],
      );
    }
  }

  // ---- indexing (incremental via content_hash) --------------------------

  indexAll(conn: Database | null = null): [number, number] {
    const own = conn === null;
    const db = conn ?? this.connect();
    let neu = 0;
    let updated = 0;
    let removed = 0;
    const seen = new Set<string>();

    const wikiOnly = this.root === resolve(homedir());
    if (wikiOnly) {
      process.stderr.write(
        `⚠️  workspace root is the home directory (${this.root}); indexing ` +
          `${WIKI_DIR}/ only — skipping a whole-home source scan to avoid a runaway index.\n`,
      );
    }
    const walkRoot = wikiOnly ? join(this.root, WIKI_DIR) : this.root;
    let sourceCount = 0;
    let sourceCapped = false;

    // The quiz layer (docs/wiki/<quizDir>/) is the HUMAN's memory loop, not LLM knowledge:
    // never index it, so search/lint/review/synthesis/cold-start can't re-ingest it (the
    // one-directional wiki→human contract — see quiz.ts). The prune loop below also
    // self-heals rows indexed before this guard existed.
    const quizPrefix = WIKI_DIR + "/" + getConfig(this.root).quizDir + "/";

    for (const full of walkFiles(walkRoot, this.root)) {
      // posix-normalize the stored relative_path so downstream `docs/wiki/` matching
      // (sourceKind, lint, cold-start) holds on Windows, where relpath yields backslashes.
      const relative = relpath(this.root, full).replace(/\\/g, "/");
      if (relative === COLD_INDEX_RELATIVE_PATH) continue;
      if (relative.startsWith(quizPrefix)) continue;
      if (!relative.startsWith(WIKI_DIR + "/")) {
        if (sourceCount >= WikiIndex.SOURCE_FILE_CAP) {
          sourceCapped = true;
          continue;
        }
        sourceCount += 1;
      }
      seen.add(relative);
      const r = this.indexFile(db, full, relative);
      if (r === "new") neu += 1;
      else if (r === "updated") updated += 1;
    }
    if (sourceCapped) {
      process.stderr.write(
        `⚠️  source-file cap (${WikiIndex.SOURCE_FILE_CAP}) reached — some non-wiki files were ` +
          `left unindexed. Point the workspace at a single repo, not a parent directory.\n`,
      );
    }
    // prune deleted files
    const rows = db.query("SELECT relative_path FROM documents").all() as { relative_path: string }[];
    for (const row of rows) {
      if (!seen.has(row.relative_path) && !this.isVirtual(row.relative_path)) {
        db.run("DELETE FROM documents WHERE relative_path = ?", [row.relative_path]);
        removed += 1;
      }
    }
    this.writeColdIndex(db);
    if (updated > 0 || removed > 0) this.optimizeFts(db);
    if (own) db.close();
    return [neu, updated];
  }

  isVirtual(relative: string): boolean {
    return relative.startsWith("__transcript__/");
  }

  private optimizeFts(db: Database): void {
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
  }

  indexFile(db: Database, full: string, relative: string): "new" | "updated" | null {
    const name = this.basename(full);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const stb = statSync(full, { bigint: true });
    const size = Number(stb.size);
    const mtimeNs = stb.mtimeNs;
    const contentHash = sha256(full);

    const existing = db
      .query("SELECT id, content_hash FROM documents WHERE relative_path = ?")
      .get(relative) as { id: string; content_hash: string | null } | null;

    let sourceContent: string | null = null;
    const capExempt = sourceKind(relative) === "wiki"; // wiki pages are never capped
    if (TEXT_EXTENSIONS.has(ext) && (capExempt || size <= WikiIndex.SOURCE_CONTENT_CAP)) {
      try {
        sourceContent = readFileSync(full, "utf-8");
      } catch {
        /* ignore */
      }
    }
    const frontmatter = sourceKind(relative) === "wiki" && sourceContent !== null ? parseFrontmatter(sourceContent) : null;
    const description = frontmatter?.description ?? null;
    const tags = JSON.stringify(frontmatter?.tags ?? []);
    const date = frontmatter?.date ?? null;
    const knowledgeStatus = frontmatter?.status ?? null;
    const knowledgeTier = frontmatter?.tier ?? null;
    const content = isColdTier(knowledgeTier) ? null : sourceContent;

    const parts = relative.split("/");
    const dirPath = parts.length > 1 ? "/" + parts.slice(0, -1).join("/") + "/" : "/";
    const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    const title = titleCase(stem.replace(/-/g, " ").replace(/_/g, " ").trim());

    if (existing) {
      if (existing.content_hash === contentHash) return null; // unchanged → skip
      db.run(
        "UPDATE documents SET content=?, file_size=?, content_hash=?, mtime_ns=?, file_type=?, " +
          "description=CASE WHEN source_kind='wiki' THEN ? ELSE description END, " +
          "date=CASE WHEN source_kind='wiki' THEN ? ELSE date END, " +
          "tags=CASE WHEN source_kind='wiki' THEN ? ELSE tags END, " +
          "knowledge_status=CASE WHEN source_kind='wiki' THEN ? ELSE knowledge_status END, " +
          "knowledge_tier=CASE WHEN source_kind='wiki' THEN ? ELSE knowledge_tier END, " +
          "last_indexed_at=datetime('now'), updated_at=datetime('now'), version=version+1, " +
          "stale_since=NULL WHERE id=?",
        [
          content,
          size,
          contentHash,
          mtimeNs,
          ext || "bin",
          description,
          date,
          tags,
          knowledgeStatus,
          knowledgeTier,
          existing.id,
        ],
      );
      if (isColdTier(knowledgeTier) && frontmatter !== null) {
        storeChunks(db, existing.id, [...coldDiscoveryChunk({ relativePath: relative, title, metadata: frontmatter, sourceContent: sourceContent ?? "" })]);
      } else if (content !== null) {
        storeChunks(db, existing.id, chunkText(stripEvidence(content)));
      }
      // content became null (e.g. the file grew past SOURCE_CONTENT_CAP): drop the stale
      // chunks so the FTS no longer serves the old body (delete trigger cleans chunks_fts).
      else db.run("DELETE FROM document_chunks WHERE document_id = ?", [existing.id]);
      this.propagateStaleness(db, existing.id);
      return "updated";
    }

    const docId = crypto.randomUUID();
    const n = (db.query("SELECT COALESCE(MAX(document_number), 0) + 1 AS n FROM documents").get() as { n: number }).n;
    db.run(
      "INSERT INTO documents (id, filename, title, description, path, relative_path, source_kind, file_type, " +
        "file_size, status, content, tags, date, knowledge_status, knowledge_tier, version, content_hash, mtime_ns, last_indexed_at, document_number) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), ?)",
      [
        docId,
        name,
        title,
        description,
        dirPath,
        relative,
        sourceKind(relative),
        ext || "bin",
        size,
        content,
        tags,
        date,
        knowledgeStatus,
        knowledgeTier,
        contentHash,
        mtimeNs,
        n,
      ],
    );
    if (isColdTier(knowledgeTier) && frontmatter !== null) {
      storeChunks(db, docId, [...coldDiscoveryChunk({ relativePath: relative, title, metadata: frontmatter, sourceContent: sourceContent ?? "" })]);
    } else if (content !== null) {
      storeChunks(db, docId, chunkText(stripEvidence(content)));
    }
    return "new";
  }

  private writeColdIndex(db: Database): void {
    const rows = db
      .query<
        {
          readonly relative_path: string;
          readonly title: string | null;
          readonly description: string | null;
          readonly tags: string;
          readonly date: string | null;
          readonly knowledge_status: string | null;
        },
        []
      >(
        "SELECT relative_path, title, description, tags, date, knowledge_status FROM documents " +
          "WHERE source_kind='wiki' AND knowledge_tier='cold' AND status != 'failed'",
      )
      .all();
    writeColdIndex(
      this.root,
      rows.map((row) => {
        const parsed = WikiIndex.row({ tags: row.tags }).tags;
        const tags = Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
        return {
          relativePath: row.relative_path,
          title: row.title ?? this.basename(row.relative_path),
          description: row.description,
          tags,
          date: row.date,
          status: row.knowledge_status,
        };
      }),
    );
  }

  registerTranscript(transcriptPath: string, sessionId: string | null = null): void {
    const db = this.connect();
    const fn = this.basename(transcriptPath);
    const rel = `__transcript__/${fn}`;
    // Reflect the real source extension (rollout.jsonl → jsonl, a dropped notes.md → md)
    // instead of hardcoding jsonl, now that non-Claude sources can be registered.
    const dot = fn.lastIndexOf(".");
    const ext = dot > 0 ? fn.slice(dot + 1).toLowerCase() : "jsonl";
    const existing = db.query("SELECT id FROM documents WHERE relative_path = ?").get(rel);
    if (!existing) {
      const n = (db.query("SELECT COALESCE(MAX(document_number), 0) + 1 AS n FROM documents").get() as { n: number }).n;
      db.run(
        "INSERT INTO documents (id, filename, title, path, relative_path, source_kind, " +
          "file_type, status, tags, version, document_number, metadata) " +
          "VALUES (?, ?, ?, '/__transcript__/', ?, 'transcript', ?, 'ready', '[]', 1, ?, ?)",
        [
          crypto.randomUUID(),
          fn,
          `session ${(sessionId || fn).slice(0, 8)}`,
          rel,
          ext,
          n,
          JSON.stringify({ transcript_path: transcriptPath, session_id: sessionId }),
        ],
      );
    }
    db.close();
  }

  reindex(): [number, number] {
    const db = this.connect();
    db.run("DELETE FROM document_chunks");
    db.run("DELETE FROM document_references");
    db.run("DELETE FROM documents WHERE source_kind != 'transcript'");
    const r = this.indexAll(db);
    this.optimizeFts(db);
    db.run("VACUUM");
    db.close();
    return r;
  }

  // ---- document read ----------------------------------------------------

  workspaceId(db: Database): string {
    return (db.query("SELECT id FROM workspace LIMIT 1").get() as { id: string }).id;
  }

  listDocuments(db: Database): DocRow[] {
    const rows = db
      .query(
        "SELECT id, filename, title, description, path, relative_path, file_type, tags, source_kind, date, updated_at " +
          "FROM documents WHERE status != 'failed' ORDER BY path, filename",
      )
      .all() as DocRow[];
    return rows.map(WikiIndex.row);
  }

  listDocumentsWithContent(db: Database): DocRow[] {
    const rows = db
      .query(
        // `metadata` carries a registered transcript's real path — lint needs it to verify v3
        // evidence excerpts against their source (and to stay silent when that source is gone).
        "SELECT id, filename, title, description, path, relative_path, content, tags, file_type, source_kind, date, stale_since, metadata, knowledge_tier " +
          "FROM documents WHERE status != 'failed' ORDER BY path, filename",
      )
      .all() as DocRow[];
    return rows.map(WikiIndex.row).map((row) => {
      if (row.source_kind === "wiki" && row.knowledge_tier === "cold" && row.content === null) {
        return { ...row, content: readColdPageBody(this.root, String(row.relative_path)) };
      }
      return row;
    });
  }

  // ---- reference graph (cites / links_to) -------------------------------

  deleteReferences(db: Database, sourceId: string): void {
    db.run("DELETE FROM document_references WHERE source_document_id = ?", [sourceId]);
  }

  upsertReference(db: Database, sourceId: string, targetId: string, refType: string, page: number | null): void {
    db.run(
      "INSERT OR REPLACE INTO document_references " +
        "(source_document_id, target_document_id, reference_type, page) VALUES (?, ?, ?, ?)",
      [sourceId, targetId, refType, page],
    );
  }

  propagateStaleness(db: Database, docId: string): void {
    db.run(
      "UPDATE documents SET stale_since = datetime('now') WHERE id IN " +
        "(SELECT source_document_id FROM document_references " +
        " WHERE target_document_id = ? AND reference_type = 'links_to') AND stale_since IS NULL",
      [docId],
    );
  }

  getBacklinks(db: Database, docId: string): DocRow[] {
    const rows = db
      .query(
        "SELECT d.path, d.filename, d.title, dr.reference_type FROM document_references dr " +
          "JOIN documents d ON dr.source_document_id = d.id " +
          "WHERE dr.target_document_id = ? AND d.status != 'failed' ORDER BY d.path, d.filename",
      )
      .all(docId) as DocRow[];
    return rows.map(WikiIndex.row);
  }

  getForwardReferences(db: Database, docId: string): DocRow[] {
    const rows = db
      .query(
        "SELECT d.id, d.filename, d.title, d.path, dr.reference_type, dr.page FROM document_references dr " +
          "JOIN documents d ON dr.target_document_id = d.id " +
          "WHERE dr.source_document_id = ? AND d.status != 'failed' " +
          "ORDER BY dr.reference_type, d.path, d.filename",
      )
      .all(docId) as DocRow[];
    return rows.map(WikiIndex.row);
  }

  findUncitedSources(db: Database): DocRow[] {
    const placeholders = WikiIndex.CITABLE.map(() => "?").join(",");
    const rows = db
      .query(
        "SELECT d.filename, d.title, d.path, d.file_type FROM documents d " +
          "WHERE d.source_kind = 'source' AND d.status != 'failed' " +
          `AND lower(d.file_type) IN (${placeholders}) ` +
          "AND d.id NOT IN (SELECT target_document_id FROM document_references WHERE reference_type='cites') " +
          "ORDER BY d.filename",
      )
      .all(...WikiIndex.CITABLE) as DocRow[];
    return rows.map(WikiIndex.row);
  }

  findStalePages(db: Database): DocRow[] {
    const rows = db
      .query(
        "SELECT d.filename, d.title, d.path, d.stale_since FROM documents d " +
          "WHERE d.status != 'failed' AND d.stale_since IS NOT NULL ORDER BY d.stale_since DESC",
      )
      .all() as DocRow[];
    return rows.map(WikiIndex.row);
  }

  // ---- search -----------------------------------------------------------

  // `raw=true`: the caller passes a pre-built, safely-quoted MATCH query
  // (e.g. turn-context's `"t1" OR "t2"`). ftsSanitize would re-quote it into literal-quote
  // phrases and drop the OR semantics, so raw callers bypass it — they own query safety.
  search(db: Database, query: string, limit = 10, kind: string | null = null, raw = false): DocRow[] {
    const match = raw ? (query || "").trim() : ftsSanitize(query);
    if (!match) return []; // empty/punctuation-only query → no rows (avoid an invalid empty MATCH)
    let sql =
      "SELECT dc.content, dc.header_breadcrumb, d.relative_path, d.title, d.source_kind, rank AS score " +
      "FROM document_chunks dc JOIN chunks_fts fts ON dc.rowid = fts.rowid " +
      "JOIN documents d ON dc.document_id = d.id " +
      "WHERE chunks_fts MATCH ? AND d.status != 'failed' ";
    const params: any[] = [match];
    if (kind) {
      sql += "AND d.source_kind = ? ";
      params.push(kind);
    }
    // Superseded down-rank (P0-4): pages whose FRONTMATTER carries `status: superseded`
    // sort after live pages so retired decisions stop crowding top-k as the wiki grows
    // (read-cost-constant principle). Frontmatter-only for real: the page must open with
    // `---\n`, have a closing `\n---` (scanned within the first 2000 chars), and the phrase
    // must sit BEFORE that closing fence — a body that merely mentions the phrase is not
    // demoted. Query-time, migration-free, deterministic; superseded pages stay findable
    // (demoted, never filtered).
    const fmEnd = "instr(substr(d.content,5,2000), char(10)||'---')";
    sql +=
      "ORDER BY (CASE WHEN d.source_kind='wiki' AND substr(d.content,1,4) = '---'||char(10) " +
      `AND ${fmEnd} > 0 ` +
      `AND instr(substr(d.content, 1, ${fmEnd} + 4), 'status: superseded') > 0 ` +
      "THEN 1 ELSE 0 END), rank LIMIT ?";
    params.push(limit);
    // FTS5 MATCH parse errors (stray operators in a raw query) degrade to "no rows",
    // never a crash — same absorb-to-empty contract basic-memory uses. bun:sqlite surfaces
    // them with varying messages ("fts5: syntax error", "unterminated string", "no such
    // column: X" for an unquoted hyphen query) — all are query-shape problems, not DB bugs.
    const isMatchParseError = (e: any) =>
      /syntax error|unterminated string|no such column|malformed MATCH|fts5/i.test(String(e?.message || e));
    let rows: DocRow[];
    try {
      rows = db.query(sql).all(...params) as DocRow[];
    } catch (e: any) {
      if (isMatchParseError(e)) return [];
      throw e;
    }
    // Relaxed-recall retry (P0-3): strict AND semantics found nothing → one OR retry with
    // the same SQL/ranking. Sanitized (natural-language) queries only — raw callers own
    // their query semantics (turn-context already builds its own OR query).
    if (rows.length === 0 && !raw && process.env.LLMWIKI_SEARCH_RELAX !== "off") {
      const relaxed = ftsRelax(query); // env kill-switch: A/B measurement + safety valve
      if (relaxed && relaxed !== match) {
        params[0] = relaxed;
        try {
          rows = db.query(sql).all(...params) as DocRow[];
        } catch {
          rows = [];
        }
      }
    }
    return rows.map(WikiIndex.row);
  }

  static row(r: DocRow): DocRow {
    const d: DocRow = { ...r };
    if (typeof d.tags === "string") {
      try {
        d.tags = JSON.parse(d.tags);
      } catch {
        d.tags = [];
      }
    }
    return d;
  }
}

// Collapse chunk-level hits to one row per page, keeping each page's BEST-ranked chunk.
//
// `search` deliberately returns CHUNK rows: turn-context unions the matched terms across a page's
// chunks and tie-breaks on hit count, so it needs every chunk. But a reader asking for the top-K
// PAGES gets a worse list from the same rows — one page with several matching chunks eats several
// slots and pushes distinct answers off the end (measured 2026-07-20: an evidence-heavy corpus put
// the same page at ranks 4 AND 5, dropping the correct page out of the top-5).
//
// So dedupe belongs at the presentation edge, not in the query. Rows arrive already ordered by
// (superseded, rank), so first-seen per page IS that page's best chunk.
export function dedupeByPage<T extends { [k: string]: any }>(rows: T[], limit?: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const rel = String(r.relative_path ?? "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(r);
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}
