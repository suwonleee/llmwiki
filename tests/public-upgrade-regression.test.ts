// Public-upgrade contract: a database produced by public commit 86e4aa1 already lived in the
// engine-managed per-project state directory, but predates the stat-skip, page-identity FTS, and
// completed-reference-graph markers added immediately afterward. Keep this fixture independent
// of today's schema.sql so a future schema change cannot silently make the "old" DB current.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiIndex } from "../src/engine/db.ts";
import {
  LEGACY_STATE_DIR,
  ensureProjectStatePath,
  projectStatePath,
  resetProjectStateCache,
} from "../src/engine/project-state.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { makeEnrolledRepo } from "./support/git-repo.ts";

// Exact table/trigger surface used by 86e4aa1, with comments removed for readability. In
// particular there is no pages_fts table: that post-86 identity index is created by connect().
const PUBLIC_86E4AA1_SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE index_build (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workspace (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE documents (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    filename TEXT NOT NULL,
    title TEXT,
    description TEXT,
    path TEXT DEFAULT '/' NOT NULL,
    relative_path TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('wiki', 'source', 'transcript', 'asset')),
    file_type TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    document_number INTEGER,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    content TEXT,
    tags TEXT DEFAULT '[]',
    date TEXT,
    knowledge_status TEXT CHECK (knowledge_status IN ('draft', 'ready', 'superseded')),
    knowledge_tier TEXT CHECK (knowledge_tier IN ('hot', 'warm', 'cold', 'protected')),
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
  CREATE INDEX idx_documents_relative_path ON documents(relative_path);
  CREATE INDEX idx_documents_path ON documents(path);
  CREATE INDEX idx_documents_source_kind ON documents(source_kind);
  CREATE TABLE document_chunks (
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
  CREATE INDEX idx_chunks_doc ON document_chunks(document_id);
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    content, content='document_chunks', content_rowid='rowid', tokenize='trigram'
  );
  CREATE TRIGGER chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TABLE document_references (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reference_type TEXT NOT NULL CHECK (reference_type IN ('cites', 'links_to')),
    page INTEGER,
    UNIQUE(source_document_id, target_document_id, reference_type)
  );
  CREATE INDEX idx_refs_source ON document_references(source_document_id);
  CREATE INDEX idx_refs_target ON document_references(target_document_id);
`;
const PUBLIC_86E4AA1_CHUNKER_VERSION = "3-three-rate-tokens";

let repo: string;
let stateRoot: string;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function seedPublicDocument(
  db: Database,
  id: string,
  relativePath: string,
  content: string,
  chunkBody: string,
  ordinal: number,
): void {
  const full = join(repo, relativePath);
  const stat = statSync(full, { bigint: true });
  db.run(
    `INSERT INTO documents
      (id, filename, title, description, path, relative_path, source_kind, file_type,
       file_size, document_number, status, content, tags, date, knowledge_status,
       knowledge_tier, version, content_hash, mtime_ns, last_indexed_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'wiki', 'md', ?, ?, 'ready', ?, '[]', NULL, NULL,
             NULL, 1, ?, ?, datetime('now'))`,
    [
      id,
      `86e4aa1-${ordinal}.md`,
      `86e4aa1 stale title ${ordinal}`,
      `/${relativePath.slice(0, relativePath.lastIndexOf("/") + 1)}`,
      relativePath,
      Number(stat.size),
      ordinal,
      content,
      sha256(content),
      stat.mtimeNs,
    ],
  );
  db.run(
    "INSERT INTO document_chunks (id, document_id, chunk_index, content, token_count, header_breadcrumb) VALUES (?, ?, 0, ?, 40, '')",
    [`chunk-${id}`, id, chunkBody],
  );
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "llmwiki-public-upgrade-state-"));
  setEffectiveStateRoot(stateRoot);
  resetProjectStateCache();
  repo = makeEnrolledRepo("llmwiki-public-upgrade-repo-");
});

afterEach(() => {
  setEffectiveStateRoot(null);
  resetProjectStateCache();
  rmSync(repo, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("public 86e4aa1 derived-state upgrade", () => {
  test("upgrades the old project index in place and keeps source pages byte-identical and searchable", () => {
    const wikiDir = join(repo, "docs", "wiki", "3_decision");
    mkdirSync(wikiDir, { recursive: true });
    const hubPath = join(wikiDir, "upgrade-compass.md");
    const targetPath = join(wikiDir, "target.md");
    const hub = [
      "---",
      "title: Upgrade Compass",
      "description: Engine managed migration signal",
      "date: 2026-08-04",
      "tags: [upgrade, regression]",
      "status: ready",
      "tier: warm",
      "---",
      "",
      "The historical page links to [[3_decision/target]].",
    ].join("\n");
    const target = "---\ntitle: Migration Target\nstatus: ready\n---\n\nStable target body.";
    writeFileSync(hubPath, hub);
    writeFileSync(targetPath, target);
    const sourceBytes = new Map([
      [hubPath, readFileSync(hubPath)],
      [targetPath, readFileSync(targetPath)],
    ]);

    // Public 86e4aa1 already used central project state. Seed that real layout directly, while
    // leaving the old DB's post-86 artifacts absent.
    const dbPath = ensureProjectStatePath(repo, "index.db");
    const legacy = new Database(dbPath);
    legacy.exec(PUBLIC_86E4AA1_SCHEMA);
    legacy.run("INSERT INTO workspace (id, name, root_path) VALUES ('public-86', 'fixture', ?)", [repo]);
    legacy.run("INSERT INTO index_build (key, value) VALUES ('chunker', ?)", [PUBLIC_86E4AA1_CHUNKER_VERSION]);
    seedPublicDocument(
      legacy,
      "hub",
      "docs/wiki/3_decision/upgrade-compass.md",
      hub,
      "Historical body only; identity terms deliberately absent from chunk search.",
      1,
    );
    seedPublicDocument(
      legacy,
      "target",
      "docs/wiki/3_decision/target.md",
      target,
      "Stable target body with enough deterministic fixture text for retrieval.",
      2,
    );
    expect(legacy.query("SELECT 1 FROM sqlite_master WHERE name='pages_fts'").get()).toBeNull();
    expect(legacy.query("SELECT key FROM index_build ORDER BY key").all()).toEqual([{ key: "chunker" }]);
    // The old graph marker must be invalidated by the filename self-heal during connect, before a
    // later no-op index could reuse edges resolved against the stale Windows-shaped filename.
    legacy.run("INSERT INTO index_build (key, value) VALUES ('refs-built', '1')");
    legacy.close();

    const index = new WikiIndex(repo);
    const current = index.connect();
    try {
      expect(projectStatePath(repo, "index.db")).toBe(dbPath);
      expect(existsSync(join(repo, LEGACY_STATE_DIR))).toBe(false);
      expect(
        current
          .query(
            "SELECT title, filename, description, date, tags, knowledge_status, knowledge_tier " +
              "FROM documents WHERE id='hub'",
          )
          .get(),
      ).toEqual({
        title: "Upgrade Compass",
        filename: "upgrade-compass.md",
        description: "Engine managed migration signal",
        date: "2026-08-04",
        tags: '["upgrade","regression"]',
        knowledge_status: "ready",
        knowledge_tier: "warm",
      });
      expect(current.query("SELECT rowid FROM pages_fts WHERE pages_fts MATCH 'engine managed migration'").all()).toHaveLength(1);
      expect(current.query("SELECT value FROM index_build WHERE key='refs-built'").get()).toBeNull();

      expect(index.indexAll(current)).toEqual([0, 0, 0]);
      expect(current.query("SELECT value FROM index_build WHERE key='stat-skip'").get()).toEqual({ value: "1" });
    } finally {
      current.close();
    }

    expect(rebuildReferenceGraph(index)).toMatchObject({ citations: 0, links: 1, pages: 2 });
    const verified = index.connect();
    try {
      expect(verified.query("SELECT value FROM index_build WHERE key='refs-built'").get()).toEqual({ value: "1" });
      expect(
        verified
          .query("SELECT reference_type FROM document_references WHERE source_document_id='hub' AND target_document_id='target'")
          .get(),
      ).toEqual({ reference_type: "links_to" });
      expect(index.search(verified, "engine managed migration")[0]?.relative_path).toBe(
        "docs/wiki/3_decision/upgrade-compass.md",
      );
    } finally {
      verified.close();
    }

    for (const [path, before] of sourceBytes) expect(readFileSync(path)).toEqual(before);
  });
});
