-- llmwiki per-repo index (SQLite + FTS5).
-- Everything in this database is DERIVED state: markdown under docs/wiki/ is the source
-- of truth, and <repo>/.llmwiki/index.db can be deleted and rebuilt from disk at any time
-- (`llmwiki reindex`). Nothing durable lives here — the update watermark is kept in the
-- central capture queue (<clone>/.state/capture.db, engine/capture.ts), never per-repo.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Identity row for the indexed repo: id + display name + absolute root path.
CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- One row per indexed file.
--   source_kind 'wiki'       — a compiled wiki page (the LLM writes these)
--               'source'     — a dropped raw document
--               'transcript' — a captured session .jsonl (raw evidence, immutable)
--               'asset'      — anything else registered for provenance
-- content_hash (sha256 of the file bytes) is what makes indexing incremental — unchanged
-- files are skipped. stale_since is stamped when a page this one links to was updated
-- after it (freshness surfacing, see db.ts). Oversized SOURCE files are registered with
-- content=NULL (metadata-only: findable by name/path, not full-text indexed).
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    filename TEXT NOT NULL,
    title TEXT,
    path TEXT DEFAULT '/' NOT NULL,           -- containing directory, e.g. /docs/wiki/3_decision/
    relative_path TEXT NOT NULL,              -- path from the workspace root (unique key)
    source_kind TEXT NOT NULL CHECK (source_kind IN ('wiki', 'source', 'transcript', 'asset')),
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    document_number INTEGER,                  -- stable per-workspace ordinal, assigned at insert
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    content TEXT,
    tags TEXT DEFAULT '[]',                   -- JSON array from page frontmatter
    date TEXT,
    metadata TEXT,
    version INTEGER DEFAULT 0,
    content_hash TEXT,
    mtime_ns INTEGER,
    last_indexed_at TEXT,
    stale_since TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(relative_path)
);
CREATE INDEX IF NOT EXISTS idx_documents_relative_path ON documents(relative_path);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_source_kind ON documents(source_kind);

-- ~512-token chunks per document (see chunker.ts) — the unit of full-text search.
-- header_breadcrumb carries the markdown heading trail ("Guide > Setup > macOS") so a
-- search hit can show where in the page it landed.
CREATE TABLE IF NOT EXISTS document_chunks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    page INTEGER,
    start_char INTEGER,
    token_count INTEGER NOT NULL,
    header_breadcrumb TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);

-- Full-text search over chunks (external-content FTS5 kept in sync by the triggers
-- below). No vector DB on purpose: at wiki scale (<100k tokens) a plain FTS index wins.
-- tokenize='trigram' because porter/unicode61 cannot segment CJK — an unspaced
-- Chinese/Japanese run indexes as ONE token (zero hits) and Korean particles break exact
-- matches. Trigram gives language-neutral substring matching on both the index and query
-- sides, and code identifiers/paths stay matchable from prompts in any language. Known
-- floor: query terms shorter than 3 chars cannot match. DBs created with an older
-- tokenizer are rebuilt automatically (db.ts detects it — this is all derived state).
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='document_chunks',
    content_rowid='rowid',
    tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Directed edges of the citation/link graph (refs.ts materializes these from page
-- footnotes and [[wiki links]]): 'cites' = footnote to a source/transcript,
-- 'links_to' = page → page. lint.ts walks this graph for orphans/staleness.
CREATE TABLE IF NOT EXISTS document_references (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('cites', 'links_to')),
    page INTEGER,
    UNIQUE(source_document_id, target_document_id, reference_type)
);
CREATE INDEX IF NOT EXISTS idx_refs_source ON document_references(source_document_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON document_references(target_document_id);
