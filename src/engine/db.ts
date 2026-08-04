// WikiIndex — synchronous SQLite index over a workspace (markdown = source of truth).
// The index is derived state: delete it (see `llmwiki state-path`) and rebuild from disk anytime.
// bun:sqlite-based. Methods that take a `db: Database` operate on an explicit
// connection the caller opens/closes.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, relative as relpath, resolve } from "node:path";
import { storeChunks, chunkText, CHUNKER_VERSION } from "./chunker.ts";
import { UNSPACED_CHAR, UNSPACED_RUN_RE, unspacedWindows } from "./segment.ts";
import { stripEvidence } from "./refs.ts";
import { ensureProjectStateDir, ensureProjectStatePath, projectStatePath } from "./project-state.ts";
import { getConfig } from "./config.ts";
import {
  RepoBoundaryError,
  ensureRepoDir,
  readRepoDir,
  readRepoFile,
  readRepoFileBytes,
  readRepoRoot,
  repoFileMetadata,
  repoPath,
  repoRelative,
} from "./repo-write.ts";
import { parseFrontmatter, resolveDocumentTitle } from "./frontmatter.ts";
import {
  COLD_INDEX_RELATIVE_PATH,
  coldDiscoveryChunk,
  isColdTier,
  readColdPageBody,
  writeColdIndex,
} from "./cold-index.ts";

const SCHEMA_PATH = join(import.meta.dir, "schema.sql");
const SCHEMA = readFileSync(SCHEMA_PATH, "utf-8");

const WINDOWS = process.platform === "win32";

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

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export interface DocRow {
  [k: string]: any;
  tags?: string[] | string;
}

function sha256(root: string, relative: string, size: number): string | null {
  if (size >= 100_000_000) return null;
  const bytes = readRepoFileBytes(root, relative);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

function sourceKind(relative: string): string {
  return relative.startsWith(WIKI_DIR + "/") ? "wiki" : "source";
}

// The trigram tokenizer indexes three-character sequences, so a MATCH term shorter than three
// characters has nothing in the index to compare against and can never match. Not an English
// edge case: 언어 · 세션 · 보안 · 言語 · 语言 · 設定 are ordinary two-character words, and this
// tokenizer was chosen precisely BECAUSE it segments CJK (schema.sql) — so the words a Korean,
// Japanese or Chinese reader is most likely to type are the ones the index cannot answer.
const FTS_MIN_TERM_CHARS = 3;

/** Word-bearing tokens of a free-text query (punctuation-only tokens dropped). */
export function ftsTokens(query: string): string[] {
  return (query || "").split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

/** Can the trigram index answer this term at all? Counted in code points, not UTF-16 units. */
export function ftsMatchable(token: string): boolean {
  return [...token].length >= FTS_MIN_TERM_CHARS;
}

// Sanitize a free-text query into a safe FTS5 MATCH string. Raw user input may contain FTS5
// operators (- : * ^ ( ) " OR AND NEAR) — passing it straight to MATCH throws (e.g. a query
// like "native-epub" yields `SQLiteError: no such column: epub`). We split on whitespace and
// wrap each word-bearing token as a quoted string literal (doubling any embedded quote), so
// every term is matched literally with implicit AND between them and no token is ever parsed
// as syntax. Power-user FTS syntax is intentionally unsupported here — robustness over
// expressivity for natural-language queries.
//
// Terms below the trigram floor are dropped rather than quoted: they cannot contribute the
// precision they appear to promise, and under implicit AND a single one of them silently empties
// an otherwise good query ("언어 설정으로" would return nothing at all). When that leaves nothing,
// the result is "" and `search` answers by substring instead of reporting silence.
export function ftsSanitize(query: string): string {
  return ftsTokens(query)
    .filter(ftsMatchable)
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
/**
 * Second-stage relax for queries carrying UNSPACED-script runs (Han · Kana · Thai …), where the
 * first stage cannot even begin: ftsRelax OR-joins whitespace tokens, and an unspaced clause IS
 * one whitespace token — "索引更新失败了怎么办" or "watch.tsを再起動する手順" arrive as a single
 * quoted phrase, which a trigram MATCH treats as a verbatim substring no page contains (measured:
 * 0/4 on mixed JA+EN / ZH+EN natural-language queries while turn-context, which windows its
 * terms, resolved 4/4). Decomposition mirrors turn-context exactly, via the shared segment.ts:
 * embedded ASCII identifiers survive whole (watch.ts · index.db), runs become word-sized windows,
 * everything OR-joins and bm25 ranks — a window that straddles a particle simply matches nothing.
 * Null unless an unspaced run is actually present AND decomposition yielded ≥2 terms, so every
 * query that worked before takes exactly the path it took before.
 */
function blocksFtsRelaxation(query: string): boolean {
  if (!query || query.includes('"')) return true;
  const padded = ` ${query} `;
  if (padded.includes(" AND ") || padded.includes(" OR ") || padded.includes(" NOT ")) return true;
  return query.split(/\s+/).some((token) => /^\p{N}+$/u.test(token));
}

export function ftsRelaxUnspaced(query: string): string | null {
  const q = (query || "").trim();
  if (blocksFtsRelaxation(q)) return null;
  if (!new RegExp(`[${UNSPACED_CHAR}]{3,}`, "u").test(q)) return null;
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if ([...t].length < 3 || seen.has(t)) return; // trigram floor; ASCII idents below are ≥3 by regex
    seen.add(t);
    terms.push(t);
  };
  for (const m of q.matchAll(/[A-Za-z_][A-Za-z0-9_./-]{2,}/g)) push(m[0]!);
  for (const m of q.matchAll(UNSPACED_RUN_RE)) for (const w of unspacedWindows(m[0]!)) push(w);
  if (terms.length < 2) return null;
  return terms
    .slice(0, 12)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");
}

export function ftsRelax(query: string): string | null {
  const q = (query || "").trim();
  if (blocksFtsRelaxation(q)) return null;
  const tokens = q.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length < 2) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// Recursive top-down walk with in-place dir pruning (replaces Python os.walk + dirs[:]).
function* walkFiles(workspaceRoot: string, relativeDir: string | null): Generator<string> {
  const entries = relativeDir === null ? readRepoRoot(workspaceRoot) : readRepoDir(workspaceRoot, relativeDir);
  const subdirs: string[] = [];
  const files: string[] = [];
  const normalizedDir = relativeDir?.replace(/\\/g, "/") ?? "";
  const isWikiDir = normalizedDir === WIKI_DIR || normalizedDir.startsWith(WIKI_DIR + "/");
  for (const e of entries) {
    if (e.isDirectory) {
      if (!IGNORE_DIRS.has(e.name) && (isWikiDir || !GENERATED_DIRS.has(e.name)) && !e.name.startsWith(".")) {
        subdirs.push(e.name);
      }
    } else if (e.isFile) {
      if (!e.name.startsWith(".")) files.push(e.name);
    }
  }
  for (const fn of files) yield relativeDir === null ? fn : join(relativeDir, fn);
  for (const d of subdirs) yield* walkFiles(workspaceRoot, relativeDir === null ? d : join(relativeDir, d));
}

export class WikiIndex {
  root: string;
  /**
   * Resolved on read, never in the constructor: resolution must not create state (turncontext
   * probes this to decide whether an index exists at all), and WikiIndex is constructed on paths
   * that may have none.
   */
  get dbPath(): string {
    return projectStatePath(this.root, "index.db");
  }
  // Rows updated by the current index pass. Staleness is propagated once the pass is complete,
  // so pages edited together never mark each other (flushStaleness).
  private readonly _updatedInPass = new Set<string>();
  static SOURCE_FILE_CAP = 5000;
  // Version of the stat fast-path's row semantics (see indexAll) — bump to force one full hash
  // pass on every existing index, e.g. when title/filename derivation changes again.
  static STAT_SKIP_VERSION = "1";
  // Stat identity is a fast-path hint, not proof: an editor can preserve both size and an old
  // mtime. Periodically re-hash every file so such edits are bounded rather than missed forever.
  static FULL_HASH_INTERVAL_MS = 24 * 60 * 60 * 1000;
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
  }

  // ---- lifecycle --------------------------------------------------------

  init(): void {
    ensureRepoDir(this.root, WIKI_DIR);
    ensureProjectStateDir(this.root, "cache");
    const db = this.connect();
    db.close();
  }

  connect(): Database {
    // The index is engine-held derived state (project-state.ts). Wherever it resolves, the file
    // is validated BEFORE SQLite opens it: a symlink in its place — planted by someone else's
    // commit in the legacy in-repo layout, or by anything at all in the state root — would
    // otherwise have SQLite write through it. ensureProjectStateDir routes the legacy branch
    // through the repository boundary, so containment is still checked there.
    const dbPath = ensureProjectStatePath(this.root, "index.db");
    if (lstatSafe(dbPath)?.isSymbolicLink()) {
      throw new RepoBoundaryError(`refusing to open a symlinked index database: ${dbPath}`);
    }
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("PRAGMA busy_timeout=5000"); // migration DDL vs a concurrent daemon write → wait, not SQLITE_BUSY
    this.migrateFts(db); // must run BEFORE exec(SCHEMA): drop the old-tokenizer table first
    db.exec(SCHEMA); // idempotent (IF NOT EXISTS) → any command self-initializes
    this.migrateFrontmatterMetadata(db);
    this.ensurePagesFts(db); // strictly AFTER the metadata migration — its triggers name description
    this.migrateChunker(db);
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

  // Callers pass NATIVE paths (indexFile's absolute path, registerTranscript's transcript path),
  // and a native Windows path contains no `/` at all — so a `/`-only split returned the entire
  // path as the "filename". Nothing failed loudly: `documents.filename` simply held
  // `C:\repo\docs\wiki\page.md` where every consumer expects `page.md`. The damage is downstream
  // and total — refs.ts keys byName on filename, so every `[[wikilink]]` and every `.jsonl`
  // citation resolved to nothing (each link dangling, each page an orphan), and lint's L0/log/
  // ledger exemptions match on the bare name, so machine-managed pages lost their exemptions.
  //
  // `\` is a legal character in a POSIX filename, so it is a separator only where the OS makes it
  // one: this keeps POSIX behaviour byte-identical while making Windows correct.
  private basename(p: string): string {
    const parts = (WINDOWS ? p.split(/[/\\]/) : p.split("/")).filter(Boolean);
    return parts.length ? parts[parts.length - 1]! : p;
  }

  // Tokenizer migration: DBs created before the trigram switch carry a
  // 'porter unicode61' chunks_fts. The index is derived state, so the migration is just:
  // drop the old FTS table + its triggers (SCHEMA recreates them with trigram) and
  // repopulate from document_chunks. Idempotent — a trigram table is left untouched.
  // Chunker migration: chunk boundaries are a function of how tokens are counted, so a DB whose
  // chunks were cut under an older rule holds retrieval units of the wrong size. Indexing is
  // incremental by content hash and the FILES did not change, so nothing else would ever notice.
  // The index is derived state, so the migration is just: drop the chunks and clear the hashes
  // that make indexing skip them. Idempotent — a current marker is left untouched.
  private migrateChunker(db: Database): void {
    const row = db.query("SELECT value FROM index_build WHERE key = 'chunker'").get() as { value: string } | null;
    if (row?.value === CHUNKER_VERSION) return;
    // One transaction: an interruption must not leave the chunks gone AND the marker current,
    // which would look migrated while serving an empty index.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.run("DELETE FROM document_chunks");
      db.run("UPDATE documents SET content_hash = NULL");
      db.run(
        "INSERT INTO index_build (key, value) VALUES ('chunker', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [CHUNKER_VERSION],
      );
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

  // Page-identity full-text index: title · description · filename. The chunk index ranks by BODY
  // prose, which can bury a hub below pages that merely mention its title in a Related list.
  // Created HERE and not in schema.sql, strictly after
  // migrateFrontmatterMetadata: the triggers name documents.description, a column that migration
  // may still have to ADD on a legacy index — declared in the schema, the triggers would either
  // fail or pin a column mid-migration. An external-content FTS table starts empty and its
  // triggers only see future writes, so first creation is followed by one 'rebuild' backfill —
  // without it, a project indexed before pages_fts existed would silently stay body-only forever.
  private ensurePagesFts(db: Database): void {
    const version = "1";
    const requiredObjects = ["pages_fts", "pages_fts_insert", "pages_fts_delete", "pages_fts_update"] as const;
    const objects = new Set(
      db
        .query<{ readonly name: string }, [string, string, string, string]>(
          "SELECT name FROM sqlite_master WHERE name IN (?, ?, ?, ?)",
        )
        .all(...requiredObjects)
        .map((row) => row.name),
    );
    const marked =
      (db.query("SELECT value FROM index_build WHERE key='pages-fts'").get() as { value: string } | null)?.value ===
      version;
    if (marked && requiredObjects.every((name) => objects.has(name))) return;

    // The table, all three maintenance triggers, first backfill, and completion marker are one
    // unit. If creation is interrupted SQLite rolls the whole unit back; databases left by the
    // older non-transactional implementation have no marker and are rebuilt on the next connect.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(" +
          "title, description, filename, content='documents', content_rowid='rowid', tokenize='trigram');" +
          "CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON documents BEGIN " +
          "INSERT INTO pages_fts(rowid, title, description, filename) VALUES (new.rowid, new.title, new.description, new.filename); END;" +
          "CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON documents BEGIN " +
          "INSERT INTO pages_fts(pages_fts, rowid, title, description, filename) VALUES ('delete', old.rowid, old.title, old.description, old.filename); END;" +
          "CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON documents BEGIN " +
          "INSERT INTO pages_fts(pages_fts, rowid, title, description, filename) VALUES ('delete', old.rowid, old.title, old.description, old.filename); " +
          "INSERT INTO pages_fts(rowid, title, description, filename) VALUES (new.rowid, new.title, new.description, new.filename); END;",
      );
      db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
      db.run(
        "INSERT INTO index_build (key, value) VALUES ('pages-fts', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [version],
      );
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
      // Title and filename heal here — at connect, from the STORED content — and not only in
      // indexFile: the stat fast-path skips a byte-identical file without reading it, and a heal
      // that lives behind a read is a heal the fast path silently starves (the contract test
      // "repairs its titles without a content change" caught exactly that).
      const title = resolveDocumentTitle(metadata, row.relative_path);
      const filename = this.basename(row.relative_path);
      db.run(
        "UPDATE documents SET description=?, date=?, tags=?, knowledge_status=?, knowledge_tier=?, title=?, filename=? " +
          "WHERE id=? AND (description IS NOT ? OR date IS NOT ? OR tags IS NOT ? OR knowledge_status IS NOT ? OR knowledge_tier IS NOT ? OR title IS NOT ? OR filename IS NOT ?)",
        [
          metadata.description,
          metadata.date,
          tags,
          metadata.status,
          metadata.tier,
          title,
          filename,
          row.id,
          metadata.description,
          metadata.date,
          tags,
          metadata.status,
          metadata.tier,
          title,
          filename,
        ],
      );
    }
  }

  // ---- indexing (incremental via content_hash) --------------------------

  indexAll(conn: Database | null = null): [number, number, number] {
    const own = conn === null;
    const db = conn ?? this.connect();
    let neu = 0;
    let updated = 0;
    let removed = 0;
    const seen = new Set<string>();

    // Stat fast-path arming. indexFile may skip a row on stat identity alone (no read, no hash),
    // but the per-row self-heals (title-from-frontmatter, Windows filename) need CONTENT once for
    // rows written by older engines — and a heal blocked by the fast path would stay blocked
    // forever, because healing is exactly what makes the row look current. So a DB indexed before
    // this marker existed gets ONE full hash pass (heals included), and the marker arms the fast
    // path between periodic audits. Bump STAT_SKIP_VERSION when derived-row semantics change
    // again — same pattern, same reason as CHUNKER_VERSION.
    const statSkipArmed =
      (db.query("SELECT value FROM index_build WHERE key = 'stat-skip'").get() as { value: string } | null)
        ?.value === WikiIndex.STAT_SKIP_VERSION;
    const lastFullHashValue = (
      db.query("SELECT value FROM index_build WHERE key = 'stat-full-hash-at'").get() as { value: string } | null
    )?.value;
    const lastFullHashAt = Number(lastFullHashValue);
    const now = Date.now();
    const fullHashDue =
      !Number.isFinite(lastFullHashAt) ||
      lastFullHashAt <= 0 ||
      lastFullHashAt > now ||
      now - lastFullHashAt >= WikiIndex.FULL_HASH_INTERVAL_MS;
    const statSkip = statSkipArmed && !fullHashDue;

    const wikiOnly = this.root === resolve(homedir());
    if (wikiOnly) {
      process.stderr.write(
        `⚠️  workspace root is the home directory (${this.root}); indexing ` +
          `${WIKI_DIR}/ only — skipping a whole-home source scan to avoid a runaway index.\n`,
      );
    }
    const walkRoot = wikiOnly ? WIKI_DIR : null;
    let sourceCount = 0;
    let sourceCapped = false;

    // The quiz layer (docs/wiki/<quizDir>/) is the HUMAN's memory loop, not LLM knowledge:
    // never index it, so search/lint/review/synthesis/cold-start can't re-ingest it (the
    // one-directional wiki→human contract — see quiz.ts). The prune loop below also
    // self-heals rows indexed before this guard existed.
    const quizPrefix = WIKI_DIR + "/" + getConfig(this.root).quizDir + "/";

    for (const relativeNative of walkFiles(this.root, walkRoot)) {
      // posix-normalize the stored relative_path so downstream `docs/wiki/` matching
      // (sourceKind, lint, cold-start) holds on Windows, where relpath yields backslashes.
      const relative = relativeNative.replace(/\\/g, "/");
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
      const r = this.indexFile(db, join(this.root, relativeNative), relative, statSkip);
      if (r === "new") neu += 1;
      else if (r === "updated") updated += 1;
    }
    this.flushStaleness(db);
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
    // The pass above visited every file; a full-hash pass arms the bounded stat fast path.
    if (!statSkipArmed) {
      db.run(
        "INSERT INTO index_build (key, value) VALUES ('stat-skip', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [WikiIndex.STAT_SKIP_VERSION],
      );
    }
    if (!statSkip) {
      db.run(
        "INSERT INTO index_build (key, value) VALUES ('stat-full-hash-at', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(now)],
      );
    }
    // refs-built invalidation is performed by schema triggers in the SAME SQLite statement as
    // each graph-input mutation. Doing it here after the walk left a crash window in which a
    // committed document update still carried the old graph's completion marker.
    if (own) db.close();
    // `removed` is in the tuple so callers can tell a true no-op from a deletion-only pass —
    // the reference graph changes on deletions too, and "0 new, 0 updated" alone hid that.
    return [neu, updated, removed];
  }

  isVirtual(relative: string): boolean {
    return relative.startsWith("__transcript__/");
  }

  private optimizeFts(db: Database): void {
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
  }

  indexFile(db: Database, full: string, relative: string, statSkip = false): "new" | "updated" | null {
    const name = this.basename(full);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    let safeRelative: string;
    try {
      safeRelative = repoRelative(this.root, full);
    } catch {
      return null;
    }
    const metadata = repoFileMetadata(this.root, safeRelative);
    if (metadata === null) return null;
    const size = metadata.size;
    const mtimeNs = metadata.mtimeNs;

    // mtime_ns as TEXT, never as a JS number: nanoseconds since the epoch (~1.7e18) exceed
    // 2^53, so a number read is silently lossy and the stat comparison below would never be
    // equal — a fast path that never fires looks exactly like a working one.
    const existing = db
      .query(
        "SELECT id, content_hash, title, filename, file_size, CAST(mtime_ns AS TEXT) AS mtime_txt " +
          "FROM documents WHERE relative_path = ?",
      )
      .get(relative) as {
      id: string;
      content_hash: string | null;
      title: string | null;
      filename: string | null;
      file_size: number | null;
      mtime_txt: string | null;
    } | null;

    // Stat fast-path: same size, same nanosecond mtime, same basename, and a hash on record —
    // the bytes are not read at all. Until this branch, a no-op `index` read and hashed EVERY
    // file every pass (content_hash can only say "unchanged" after paying for the content):
    // measured 1.0s on an 868-file fixture and 2.8s at 1000 pages, ×4 per autoupdate run.
    // Armed only after one full pass under the current row semantics (indexAll's marker), so the
    // per-row self-heals below are never starved. A row whose hash was cleared (chunker
    // migration) or never computed keeps taking the full path.
    // Racily-clean guard (the rule git applies to its own index, for the same reason). Stat
    // identity is only evidence of "unchanged" when the clock that produced the mtime can
    // RESOLVE a change: on FAT/exFAT (2s), SMB and older NFS (1s), two same-size writes inside one
    // tick share a timestamp, so a real edit is indistinguishable from no edit. Measured here:
    // APFS gives nanoseconds, but a Windows USB stick or a mounted share does not, and those are
    // ordinary places to keep a wiki. So a file whose mtime is younger than the coarsest
    // granularity we might be sitting on is always hashed. A future mtime (clock skew on a share)
    // and a zero mtime (mounts that do not report one) fail the same test — both mean "this
    // timestamp cannot be trusted", and the cost of distrust is one hash of one recently-touched
    // file, which is the set most likely to have changed anyway.
    const RACY_WINDOW_NS = 2_000_000_000n; // 2s — the coarsest common filesystem granularity
    const nowNs = BigInt(Date.now()) * 1_000_000n;
    const mtimeIsDecisive = mtimeNs > 0n && mtimeNs <= nowNs - RACY_WINDOW_NS;
    const statIdentical =
      statSkip &&
      mtimeIsDecisive &&
      existing !== null &&
      existing.content_hash !== null &&
      existing.file_size === size &&
      existing.mtime_txt === mtimeNs.toString() &&
      existing.filename === name;
    if (statIdentical) return null;

    const contentHash = sha256(this.root, safeRelative, size);

    let sourceContent: string | null = null;
    const capExempt = sourceKind(relative) === "wiki"; // wiki pages are never capped
    if (TEXT_EXTENSIONS.has(ext) && (capExempt || size <= WikiIndex.SOURCE_CONTENT_CAP)) {
      try {
        sourceContent = readRepoFile(this.root, safeRelative);
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
    const title = resolveDocumentTitle(frontmatter, relative);

    if (existing) {
      if (existing.content_hash === contentHash) {
        // The title is derived state, so an index written before titles came from frontmatter
        // heals here rather than waiting for the page's bytes to change (self-heal, same stance
        // as the citation graph) — one cheap UPDATE, and the row still counts as unchanged.
        if (existing.title !== title) db.run("UPDATE documents SET title=? WHERE id=?", [title, existing.id]);
        // Same stance for filename, and it needs its own heal: filename is written on INSERT only,
        // so an index built by a Windows engine that stored a full native path there would never
        // recover — not on reindex either, because an existing row takes the UPDATE path below.
        // Without this, every wikilink stays dangling on machines that indexed before the fix.
        if (existing.filename !== name) db.run("UPDATE documents SET filename=? WHERE id=?", [name, existing.id]);
        // A touched file (same bytes, new mtime — git checkout, cp -p, editors that save-then-
        // revert) would fail the stat fast-path on every future pass and pay the hash forever;
        // record what stat says now, so the next pass can skip on it.
        if (existing.mtime_txt !== mtimeNs.toString() || existing.file_size !== size) {
          db.run("UPDATE documents SET mtime_ns=?, file_size=? WHERE id=?", [mtimeNs, size, existing.id]);
        }
        return null;
      }
      db.run(
        "UPDATE documents SET filename=?, content=?, file_size=?, content_hash=?, mtime_ns=?, file_type=?, " +
          "description=CASE WHEN source_kind='wiki' THEN ? ELSE description END, " +
          "date=CASE WHEN source_kind='wiki' THEN ? ELSE date END, " +
          "tags=CASE WHEN source_kind='wiki' THEN ? ELSE tags END, " +
          "knowledge_status=CASE WHEN source_kind='wiki' THEN ? ELSE knowledge_status END, " +
          "knowledge_tier=CASE WHEN source_kind='wiki' THEN ? ELSE knowledge_tier END, " +
          "last_indexed_at=datetime('now'), updated_at=datetime('now'), version=version+1, " +
          "stale_since=NULL WHERE id=?",
        [
          name,
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
      // Staleness is propagated by the CALLER once the whole pass is known — a page edited in the
      // same pass is not behind this change (see propagateStaleness).
      this._updatedInPass.add(existing.id);
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

  reindex(): [number, number, number] {
    const db = this.connect();
    // Resync both external-content indexes BEFORE deleting their content rows. On a drifted
    // index the DELETE below fires the FTS delete-trigger for a row the index does not hold,
    // SQLite raises SQLITE_CORRUPT_VTAB, and the one command whose purpose is rebuilding derived
    // state dies on exactly the state it exists to rebuild (measured with a delete-all'd
    // chunks_fts). 'rebuild' rewrites each index from its content table, making the trigger
    // deletes coherent again; on a healthy index it is a cheap no-op-shaped rewrite.
    db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    db.run("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
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

  /**
   * Mark the pages that link to `docId` as stale — "a source I cite moved on without me".
   *
   * Pages updated in the SAME pass are excluded: a close-out routinely edits cross-linked pages
   * together, and marking each other turned a fully-current wiki into a list of stale pages.
   */
  propagateStaleness(db: Database, docId: string, excludeIds: ReadonlySet<string> = new Set()): void {
    const placeholders = excludeIds.size ? ` AND id NOT IN (${[...excludeIds].map(() => "?").join(", ")})` : "";
    db.run(
      "UPDATE documents SET stale_since = datetime('now') WHERE id IN " +
        "(SELECT source_document_id FROM document_references " +
        " WHERE target_document_id = ? AND reference_type = 'links_to') AND stale_since IS NULL" +
        placeholders,
      [docId, ...excludeIds],
    );
  }

  /** Propagate for every page updated in this pass, then reset the pass. */
  flushStaleness(db: Database): void {
    const updated = new Set(this._updatedInPass);
    this._updatedInPass.clear();
    for (const id of updated) this.propagateStaleness(db, id, updated);
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
    const tokens = raw ? [] : ftsTokens(query);
    let rows: DocRow[] = [];

    if (match) {
      rows = this._matchRows(db, match, limit, kind);
      // Relaxed-recall retry (P0-3): strict AND semantics found nothing → one OR retry with
      // the same SQL/ranking. Sanitized (natural-language) queries only — raw callers own
      // their query semantics (turn-context already builds its own OR query).
      if (rows.length === 0 && !raw && process.env.LLMWIKI_SEARCH_RELAX !== "off") {
        // Same stage, two decompositions: whitespace tokens first (ftsRelax), unspaced-run
        // windows when whitespace has nothing to offer (ftsRelaxUnspaced) — same kill-switch.
        const relaxed = ftsRelax(query) ?? ftsRelaxUnspaced(query);
        if (relaxed && relaxed !== match) rows = this._matchRows(db, relaxed, limit, kind);
      }
    }

    // Below-the-floor recall: the query named terms the trigram index cannot represent, so the
    // MATCH above answered a strictly smaller question than the reader asked (or, with every term
    // short, none of it). Substring is exactly what trigram would have done had the terms been
    // long enough. It costs a scan, so it runs only after MATCH has come back empty — measured on
    // this engine's own wiki (304 chunks): 0.5-1.3ms.
    if (rows.length === 0 && !raw && tokens.length > 0 && !tokens.every(ftsMatchable)) {
      rows = this._substringRows(db, tokens, limit, kind);
    }

    // Title boost (P0-5), LAST so it never perturbs the chunk pipeline's own gates (relax fires on
    // "chunk match found nothing", not on "a title matched"): a WIKI page whose IDENTITY (title ·
    // description · filename) contains EVERY query token outranks any body mention — the
    // hub-vs-mention distinction. Two routes to the same AND-over-all-tokens judgment: FTS when
    // every token clears the trigram floor; identity SUBSTRING otherwise, because Korean 2-char
    // content words (본문·계약·병합) fall below the floor — an FTS query without them degenerates
    // to its one surviving term (measured: "worker 본문 생성 계약" became MATCH "worker" and put
    // worker.py above the hub page), and a query made ONLY of such words ("위키 유무 ab 실측")
    // has no MATCH at all yet still deserves its hub. Prepended; dedupeByPage's first-win keeps
    // identity hits on top. Raw callers own their candidate semantics: turn-context appends its
    // OR identity candidates explicitly after the below-floor fallback. Prepending identity rows
    // here as well made the same page arrive through two indistinguishable identity paths and
    // inflated its hit count. Kill-switch mirrors LLMWIKI_SEARCH_RELAX.
    if (!raw && process.env.LLMWIKI_SEARCH_TITLE_BOOST !== "off") {
      const titled = tokens.length > 0 && !tokens.every(ftsMatchable)
          ? this._titleRowsLike(db, tokens, limit)
          : match
            ? this._titleRows(db, match, limit)
            : [];
      if (titled.length) rows = [...titled, ...rows];
    }
    return rows.map(WikiIndex.row);
  }

  /**
   * The same below-the-floor answer `search()` falls back to, for callers that build their own
   * MATCH query and therefore opt out of it (turn-context). Without this, the one retrieval path a
   * reader hits EVERY turn is the only one that cannot see a term the trigram index can't represent
   * — and in Hangul those are the ordinary words (토큰·만료·검사), not the exotic ones.
   */
  searchBelowFloor(db: Database, tokens: string[], limit = 10, kind: string | null = null): DocRow[] {
    if (!tokens.length) return [];
    return this._substringRows(db, tokens, limit, kind).map(WikiIndex.row);
  }

  // Live pages before retired ones, then the caller's ranking. Superseded down-rank (P0-4):
  // pages whose FRONTMATTER carries `status: superseded` sort after live pages so retired
  // decisions stop crowding top-k as the wiki grows (read-cost-constant principle).
  // Frontmatter-only for real: the page must open with `---\n`, have a closing `\n---` (scanned
  // within the first 2000 chars), and the phrase must sit BEFORE that closing fence — a body that
  // merely mentions the phrase is not demoted. Query-time, migration-free, deterministic;
  // superseded pages stay findable (demoted, never filtered).
  static _orderBy(rank: string): string {
    const fmEnd = "instr(substr(d.content,5,2000), char(10)||'---')";
    return (
      "ORDER BY (CASE WHEN d.source_kind='wiki' AND substr(d.content,1,4) = '---'||char(10) " +
      `AND ${fmEnd} > 0 ` +
      `AND instr(substr(d.content, 1, ${fmEnd} + 4), 'status: superseded') > 0 ` +
      `THEN 1 ELSE 0 END), ${rank} LIMIT ?`
    );
  }

  // Page-identity hits (pages_fts): one row per PAGE, shaped like a chunk row so every caller
  // downstream (dedupeByPage, turn-context's per-page union) consumes it unchanged. `content`
  // carries the description — for a hub page that is the best snippet a reader can get, and for
      // turn-context it is text the scorer can legitimately count terms against. Wiki pages ONLY:
      // identity is a hub signal, and boosting source files by filename can put an implementation
      // file above the page that actually owns the concept.
  _titleRows(db: Database, match: string, limit: number): DocRow[] {
    const sql =
      "SELECT d.description AS content, NULL AS header_breadcrumb, d.relative_path, d.title, d.source_kind, " +
      "'identity' AS candidate_kind, rank AS score " +
      "FROM documents d JOIN pages_fts fts ON d.rowid = fts.rowid " +
      "WHERE pages_fts MATCH ? AND d.status != 'failed' AND d.source_kind = 'wiki' " +
      WikiIndex._orderBy("rank");
    try {
      return db.query(sql).all(match, limit) as DocRow[];
    } catch (e: any) {
      // Same absorb-to-empty contract as _matchRows: a query-shape problem must never crash search.
      if (/syntax error|unterminated string|no such column|malformed MATCH|fts5/i.test(String(e?.message || e))) {
        return [];
      }
      throw e;
    }
  }

  /**
   * OR-semantics identity candidates for turn-context: wiki pages whose title/description/filename
   * contains ANY of the terms — checked against a whitespace/hyphen-stripped copy too, because
   * Korean compound spacing can make a prompt say "문서허브" while the title says "문서 허브",
   * and neither trigram MATCH nor plain substring can bridge that. This only SUPPLIES candidates;
   * the caller's scorer still applies the witness/score gate, so recall added here cannot become
   * noise on its own. One short string per page — a scan over pages, never chunks.
   */
  identityCandidates(db: Database, tokens: readonly string[], limit = 12): DocRow[] {
    const clean = tokens.filter((t) => t.trim().length > 0);
    if (!clean.length) return [];
    const hay = "lower(coalesce(d.title,'') || ' ' || coalesce(d.description,'') || ' ' || d.filename)";
    const hayNS = `replace(replace(${hay}, ' ', ''), '-', '')`;
    const params: any[] = [];
    const ors = clean.map((t) => {
      const like = `%${t.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
      return `(${hay} LIKE ? ESCAPE '\\' OR ${hayNS} LIKE ? ESCAPE '\\')`;
    });
    const sql =
      "SELECT d.description AS content, NULL AS header_breadcrumb, d.relative_path, d.title, d.source_kind, " +
      "'identity' AS candidate_kind, NULL AS score " +
      "FROM documents d " +
      `WHERE (${ors.join(" OR ")}) AND d.status != 'failed' AND d.source_kind = 'wiki' ` +
      WikiIndex._orderBy("length(coalesce(d.title,'')), d.relative_path");
    params.push(limit);
    return db.query(sql).all(...params) as DocRow[];
  }

  // The identity judgment for queries the trigram index cannot fully represent: every token —
  // including the sub-floor ones — must appear as a substring of title/description/filename.
  // Mirrors _substringRows' philosophy on the identity surface; ~one row per page, so the scan is
  // hundreds of rows, not chunks.
  _titleRowsLike(db: Database, tokens: readonly string[], limit: number): DocRow[] {
    const hay = "lower(coalesce(d.title,'') || ' ' || coalesce(d.description,'') || ' ' || d.filename)";
    const params: any[] = tokens.map((t) => `%${t.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const sql =
      "SELECT d.description AS content, NULL AS header_breadcrumb, d.relative_path, d.title, d.source_kind, " +
      "'identity' AS candidate_kind, NULL AS score " +
      "FROM documents d " +
      `WHERE ${tokens.map(() => `${hay} LIKE ? ESCAPE '\\'`).join(" AND ")} ` +
      "AND d.status != 'failed' AND d.source_kind = 'wiki' " +
      WikiIndex._orderBy("length(coalesce(d.title,'')), d.relative_path");
    params.push(limit);
    return db.query(sql).all(...params) as DocRow[];
  }

  _matchRows(db: Database, match: string, limit: number, kind: string | null): DocRow[] {
    let sql =
      "SELECT dc.content, dc.header_breadcrumb, d.relative_path, d.title, d.source_kind, " +
      "'body' AS candidate_kind, rank AS score " +
      "FROM document_chunks dc JOIN chunks_fts fts ON dc.rowid = fts.rowid " +
      "JOIN documents d ON dc.document_id = d.id " +
      "WHERE chunks_fts MATCH ? AND d.status != 'failed' ";
    const params: any[] = [match];
    if (kind) {
      sql += "AND d.source_kind = ? ";
      params.push(kind);
    }
    sql += WikiIndex._orderBy("rank");
    params.push(limit);
    // FTS5 MATCH parse errors (stray operators in a raw query) degrade to "no rows",
    // never a crash — same absorb-to-empty contract basic-memory uses. bun:sqlite surfaces
    // them with varying messages ("fts5: syntax error", "unterminated string", "no such
    // column: X" for an unquoted hyphen query) — all are query-shape problems, not DB bugs.
    try {
      return db.query(sql).all(...params) as DocRow[];
    } catch (e: any) {
      if (/syntax error|unterminated string|no such column|malformed MATCH|fts5/i.test(String(e?.message || e))) {
        return [];
      }
      throw e;
    }
  }

  // Every term must appear (implicit AND, as in the MATCH path). There is no bm25 here, so the
  // stand-in for relevance is density: the shortest chunk that still contains every term.
  _substringRows(db: Database, tokens: readonly string[], limit: number, kind: string | null): DocRow[] {
    // `%` and `_` are LIKE wildcards and must survive as literals — unescaped, a query of "%"
    // would match every chunk in the wiki.
    const params: any[] = tokens.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    let sql =
      "SELECT dc.content, dc.header_breadcrumb, d.relative_path, d.title, d.source_kind, " +
      "'body' AS candidate_kind, NULL AS score " +
      "FROM document_chunks dc JOIN documents d ON dc.document_id = d.id " +
      `WHERE ${tokens.map(() => "dc.content LIKE ? ESCAPE '\\'").join(" AND ")} AND d.status != 'failed' `;
    if (kind) {
      sql += "AND d.source_kind = ? ";
      params.push(kind);
    }
    sql += WikiIndex._orderBy("length(dc.content), d.relative_path, dc.chunk_index");
    params.push(limit);
    return db.query(sql).all(...params) as DocRow[];
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
