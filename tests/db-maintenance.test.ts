import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import {
  compactDatabase,
  DEFAULT_DB_COMPACTION_POLICY,
  ftsIndexBytes,
  ftsSyncMessages,
  inspectDatabaseHealth,
} from "../src/engine/db-maintenance.ts";

// Per-table sizes come from `dbstat`, which is a COMPILE-TIME SQLite option — Bun ships it on
// macOS and not on Linux. Assertions about index SIZE are therefore conditional on the platform
// being able to measure one; everything else in these tests must hold everywhere.
function ftsBytes(idx: WikiIndex): number | null {
  const conn = idx.connect();
  try {
    return ftsIndexBytes(conn);
  } finally {
    conn.close();
  }
}

const DBSTAT = (() => {
  const probe = new WikiIndex(mkdtempSync(join(tmpdir(), "llmwiki-dbstat-probe-")));
  const conn = probe.connect();
  try {
    return ftsIndexBytes(conn) !== null;
  } finally {
    conn.close();
    rmSync(probe.root, { recursive: true, force: true });
  }
})();

describe("WikiIndex maintenance", () => {
  let root: string;
  let wiki: string;
  let idx: WikiIndex;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-maintenance-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "page.md"), "# Page\n\n" + "durable wiki content ".repeat(100));
    idx = new WikiIndex(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("generated runtime directories are excluded and previously indexed rows are pruned", () => {
    for (const dir of ["out", "output", "var"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "artifact.json"), '{"generated":"runtime-artifact"}');
    }
    mkdirSync(join(wiki, "out"), { recursive: true });
    writeFileSync(join(wiki, "out", "kept.md"), "# Kept\n\nThis custom wiki category remains searchable.");
    const conn = idx.connect();
    conn.run(
      "INSERT INTO documents " +
        "(id, filename, title, path, relative_path, source_kind, file_type, status, content, tags, version, document_number) " +
        "VALUES ('old-out', 'artifact.json', 'Old output', '/out/', 'out/artifact.json', 'source', 'json', 'ready', 'legacy', '[]', 1, 999)",
    );

    idx.indexAll(conn);

    const rows = conn
      .query<{ relative_path: string }, []>(
        "SELECT relative_path FROM documents WHERE relative_path LIKE 'out/%' OR relative_path LIKE 'output/%' OR relative_path LIKE 'var/%'",
      )
      .all();
    const kept = conn
      .query<{ relative_path: string }, []>("SELECT relative_path FROM documents WHERE relative_path='docs/wiki/out/kept.md'")
      .all();
    conn.close();
    expect(rows).toEqual([]);
    expect(kept).toEqual([{ relative_path: "docs/wiki/out/kept.md" }]);
  });

  test("reindex compacts free SQLite pages", () => {
    const bulk = join(root, "bulk");
    mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(bulk, `${i}.json`), JSON.stringify({ body: `temporary-${i} `.repeat(3000) }));
    }
    const first = idx.connect();
    idx.indexAll(first);
    first.close();
    rmSync(bulk, { recursive: true, force: true });

    idx.reindex();

    const compacted = idx.connect();
    const row = compacted.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get();
    compacted.close();
    expect(row?.freelist_count).toBe(0);
  });

  test.if(DBSTAT)("normal indexing keeps FTS storage bounded across repeated updates", () => {
    const page = join(wiki, "page.md");
    for (let revision = 0; revision < 30; revision++) {
      writeFileSync(page, `# Page ${revision}\n\n` + `반복 갱신 검색 본문 ${revision} `.repeat(2000));
      idx.indexAll();
    }
    const churnBytes = ftsBytes(idx)!;

    idx.reindex();

    const freshBytes = ftsBytes(idx)!;
    expect(churnBytes).toBeLessThanOrEqual(freshBytes * 3);
  });

  test("reports read-only storage, FTS, and indexed-content health by source tier", () => {
    writeFileSync(join(root, "notes.txt"), "searchable source ".repeat(100));
    idx.indexAll();
    idx.registerTranscript("/tmp/maintenance-transcript.jsonl", "maintenance-session");
    const conn = idx.connect();
    const before = conn.query<{ page_count: number; freelist_count: number }, []>("PRAGMA page_count; PRAGMA freelist_count").get();

    const report = inspectDatabaseHealth(conn);

    const after = conn.query<{ page_count: number; freelist_count: number }, []>("PRAGMA page_count; PRAGMA freelist_count").get();
    conn.close();
    expect(DEFAULT_DB_COMPACTION_POLICY).toEqual({
      minimumDatabaseBytes: 30 * 1024 * 1024,
      minimumFreeRatio: 0.1,
      minimumFreeBytes: 1024 * 1024,
    });
    expect(report.integrity.ok).toBeTrue();
    expect(report.storage.databaseBytes).toBeGreaterThan(0);
    // Measurable only where SQLite was built with dbstat; elsewhere the report must say "unknown"
    // rather than take the rest of database health down with it.
    if (DBSTAT) expect(report.ftsBytes).toBeGreaterThan(0);
    else expect(report.ftsBytes).toBeNull();
    expect(report.liveIndexedBytes).toBeGreaterThan(0);
    expect(report.buckets.some((bucket) => bucket.sourceKind === "wiki" && bucket.tier === "live")).toBeTrue();
    expect(report.buckets.some((bucket) => bucket.sourceKind === "source" && bucket.tier === "live")).toBeTrue();
    expect(report.buckets.some((bucket) => bucket.sourceKind === "transcript" && bucket.tier === "metadata_only")).toBeTrue();
    expect(after).toEqual(before);
  });

  test("dry-run and commit compact only healthy free pages while retaining document identity", () => {
    const dependent = join(wiki, "dependent.md");
    const bulk = join(root, "bulk");
    writeFileSync(dependent, "# Dependent\n\nStable linked page.");
    mkdirSync(bulk, { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(bulk, `${i}.json`), JSON.stringify({ body: `transient-${i} `.repeat(5000) }));
    idx.indexAll();
    idx.registerTranscript("/tmp/identity-preserved.jsonl", "identity-session");
    const conn = idx.connect();
    const docs = conn
      .query<{ id: string; relative_path: string; document_number: number }, []>(
        "SELECT id, relative_path, document_number FROM documents WHERE relative_path IN ('docs/wiki/page.md', 'docs/wiki/dependent.md')",
      )
      .all();
    const page = docs.find((doc) => doc.relative_path === "docs/wiki/page.md");
    const source = docs.find((doc) => doc.relative_path === "docs/wiki/dependent.md");
    if (!page || !source) throw new Error("indexed identity fixtures are missing");
    conn.run(
      "INSERT INTO document_references (id, source_document_id, target_document_id, reference_type) VALUES ('stable-ref', ?, ?, 'links_to')",
      [source.id, page.id],
    );
    conn.run("UPDATE documents SET stale_since='2026-07-23 00:00:00' WHERE id=?", [source.id]);
    rmSync(bulk, { recursive: true, force: true });
    idx.indexAll(conn);
    const policy = { minimumDatabaseBytes: 1, minimumFreeRatio: 0, minimumFreeBytes: 1 };
    const before = inspectDatabaseHealth(conn, policy);
    const identityBefore = conn
      .query<{ id: string; document_number: number; stale_since: string | null }, [string, string]>(
        "SELECT id, document_number, stale_since FROM documents WHERE id IN (?, ?) ORDER BY id",
      )
      .all(source.id, page.id);
    const referencesBefore = conn
      .query<{ source_document_id: string; target_document_id: string; reference_type: string }, []>(
        "SELECT source_document_id, target_document_id, reference_type FROM document_references ORDER BY id",
      )
      .all();
    const transcriptBefore = conn
      .query<{ id: string; document_number: number }, []>("SELECT id, document_number FROM documents WHERE source_kind='transcript'")
      .get();

    const dryRun = compactDatabase(conn, { commit: false, policy });
    const afterDryRun = inspectDatabaseHealth(conn, policy);
    const committed = compactDatabase(conn, { commit: true, policy });
    const repeated = compactDatabase(conn, { commit: true, policy });

    const after = inspectDatabaseHealth(conn, policy);
    const identityAfter = conn
      .query<{ id: string; document_number: number; stale_since: string | null }, [string, string]>(
        "SELECT id, document_number, stale_since FROM documents WHERE id IN (?, ?) ORDER BY id",
      )
      .all(source.id, page.id);
    const referencesAfter = conn
      .query<{ source_document_id: string; target_document_id: string; reference_type: string }, []>(
        "SELECT source_document_id, target_document_id, reference_type FROM document_references ORDER BY id",
      )
      .all();
    const transcriptAfter = conn
      .query<{ id: string; document_number: number }, []>("SELECT id, document_number FROM documents WHERE source_kind='transcript'")
      .get();
    conn.close();
    expect(before.storage.freeBytes).toBeGreaterThan(0);
    expect(dryRun.kind).toBe("dry-run");
    expect(afterDryRun.storage).toEqual(before.storage);
    expect(committed.kind).toBe("compacted");
    expect(repeated.kind).toBe("not_needed");
    expect(after.storage.freePages).toBe(0);
    expect(identityAfter).toEqual(identityBefore);
    expect(referencesAfter).toEqual(referencesBefore);
    expect(transcriptAfter).toEqual(transcriptBefore);
  }, 5_000);

  test("refuses compaction when a foreign-key integrity check fails", () => {
    idx.indexAll();
    const conn = idx.connect();
    conn.exec("PRAGMA foreign_keys=OFF");
    conn.run(
      "INSERT INTO document_references (id, source_document_id, target_document_id, reference_type) VALUES ('broken-ref', 'missing-source', 'missing-target', 'links_to')",
    );
    conn.exec("PRAGMA foreign_keys=ON");
    const health = inspectDatabaseHealth(conn);
    const pagesBefore = health.storage.pageCount;

    const result = compactDatabase(conn, { commit: true });

    const pagesAfter = inspectDatabaseHealth(conn).storage.pageCount;
    conn.close();
    expect(health.integrity.ok).toBeFalse();
    expect(result).toMatchObject({ kind: "refused", reason: "integrity_failed" });
    expect(pagesAfter).toBe(pagesBefore);
  });
});

describe("external-content FTS drift (silent-quality-regression guard)", () => {
  let root: string;
  let idx: WikiIndex;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-drift-"));
    const wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "hub.md"), "---\ntitle: Hub Page\ndescription: d\n---\n\n" + "hub body content ".repeat(40));
    idx = new WikiIndex(root);
    const conn = idx.connect();
    idx.indexAll(conn);
    conn.close();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a drifted pages_fts fails integrity on a writable connection", () => {
    const conn = idx.connect();
    conn.exec("INSERT INTO pages_fts(pages_fts) VALUES('delete-all')");
    const report = inspectDatabaseHealth(conn);
    conn.close();
    expect(report.integrity.ok).toBe(false);
    expect(report.integrity.messages.join(" ")).toContain("pages_fts");
  });

  test("a read-only probe still sees the drift (docsize, not the content-table echo)", () => {
    // COUNT(*) on an external-content FTS answers from the CONTENT table — measured: a
    // delete-all'd index read as clean through that probe. _docsize is the indexed truth.
    let conn = idx.connect();
    conn.exec("INSERT INTO pages_fts(pages_fts) VALUES('delete-all')");
    conn.close();
    const { Database } = require("bun:sqlite");
    const ro = new Database(join(String(idx.dbPath)), { readonly: true });
    const report = inspectDatabaseHealth(ro);
    ro.close();
    expect(report.integrity.ok).toBe(false);
    expect(report.integrity.messages.join(" ")).toContain("pages_fts indexes 0 row(s)");
  });

  test("a read-only legacy database may omit pages_fts", () => {
    const conn = idx.connect();
    conn.exec("DROP TRIGGER pages_fts_insert; DROP TRIGGER pages_fts_delete; DROP TRIGGER pages_fts_update; DROP TABLE pages_fts");
    conn.close();
    const ro = new Database(join(String(idx.dbPath)), { readonly: true });
    const report = inspectDatabaseHealth(ro);
    ro.close();
    expect(report.integrity.ok).toBe(true);
  });

  test("an unexpected primary FTS error fails integrity closed", () => {
    const conn = idx.connect();
    conn.exec("DROP TRIGGER chunks_fts_insert; DROP TRIGGER chunks_fts_delete; DROP TRIGGER chunks_fts_update; DROP TABLE chunks_fts");
    const report = inspectDatabaseHealth(conn);
    conn.close();
    expect(report.integrity.ok).toBe(false);
    expect(report.integrity.messages.join(" ")).toContain("fts integrity check failed for chunks_fts");
  });

  test("an unexpected read-only fallback error fails integrity closed", () => {
    const fake = {
      run: () => {
        throw new Error("attempt to write a readonly database");
      },
      query: () => ({
        get: () => {
          throw new Error("disk I/O error");
        },
      }),
    } as unknown as Database;
    expect(ftsSyncMessages(fake, "chunks_fts", "document_chunks")).toEqual([
      "fts readonly fallback failed for chunks_fts: disk I/O error",
    ]);
  });

  test("reindex repairs the drift — triggers repopulate both FTS tables", () => {
    let conn = idx.connect();
    conn.exec("INSERT INTO pages_fts(pages_fts) VALUES('delete-all')");
    conn.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')");
    expect(inspectDatabaseHealth(conn).integrity.ok).toBe(false);
    conn.close();
    idx.reindex();
    conn = idx.connect();
    expect(inspectDatabaseHealth(conn).integrity.ok).toBe(true);
    conn.close();
  });
});
