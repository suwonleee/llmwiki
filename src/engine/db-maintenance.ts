import { Database } from "bun:sqlite";

export const DEFAULT_DB_COMPACTION_POLICY = {
  minimumDatabaseBytes: 30 * 1024 * 1024,
  minimumFreeRatio: 0.1,
  minimumFreeBytes: 1024 * 1024,
} as const satisfies DatabaseCompactionPolicy;

export type DatabaseCompactionPolicy = {
  readonly minimumDatabaseBytes: number;
  readonly minimumFreeRatio: number;
  readonly minimumFreeBytes: number;
};

export type SourceKind = "wiki" | "source" | "transcript" | "asset";
export type IndexTier = "live" | "metadata_only" | "failed";

export type DatabaseHealthBucket = {
  readonly sourceKind: SourceKind;
  readonly tier: IndexTier;
  readonly documents: number;
  readonly chunks: number;
  readonly liveIndexedBytes: number;
};

export type DatabaseHealthReport = {
  readonly integrity: {
    readonly ok: boolean;
    readonly messages: readonly string[];
  };
  readonly storage: {
    readonly databaseBytes: number;
    readonly pageSizeBytes: number;
    readonly pageCount: number;
    readonly freePages: number;
    readonly freeBytes: number;
    readonly freeRatio: number;
  };
  /**
   * Bytes the trigram index occupies, or null where this build of SQLite cannot say.
   *
   * The only source for a per-table size is the `dbstat` virtual table, which is a COMPILE-TIME
   * option (SQLITE_ENABLE_DBSTAT_VTAB). Bun ships it on macOS and not on Linux — so a query that
   * had never failed for the author threw `no such table: dbstat` on every Linux machine, taking
   * `db-health`, `compact` AND `wiki-doctor` down with it. Nothing else in this report needs it:
   * total and free space come from PRAGMAs that exist everywhere, and compaction eligibility is
   * decided entirely from those.
   */
  readonly ftsBytes: number | null;
  readonly buckets: readonly DatabaseHealthBucket[];
  readonly liveIndexedBytes: number;
  readonly compactionEligible: boolean;
};

export type DatabaseCompactOptions = {
  readonly commit?: boolean;
  readonly policy?: DatabaseCompactionPolicy;
};

export type DatabaseCompactResult =
  | { readonly kind: "refused"; readonly reason: "integrity_failed"; readonly health: DatabaseHealthReport }
  | { readonly kind: "not_needed"; readonly health: DatabaseHealthReport }
  | { readonly kind: "dry-run"; readonly health: DatabaseHealthReport }
  | { readonly kind: "compacted"; readonly before: DatabaseHealthReport; readonly after: DatabaseHealthReport };

type IntegrityRow = { readonly integrity_check: string };
type ForeignKeyRow = { readonly table: string; readonly rowid: number; readonly parent: string; readonly fkid: number };
type BucketRow = {
  readonly source_kind: SourceKind;
  readonly tier: IndexTier;
  readonly documents: number;
  readonly chunks: number;
  readonly live_indexed_bytes: number;
};

function scalar(db: Database, sql: string, column: string): number {
  const row = db.query<Record<string, number>, []>(sql).get();
  const value = row?.[column];
  if (typeof value !== "number") throw new DatabaseMaintenanceReadError(sql, column);
  return value;
}

class DatabaseMaintenanceReadError extends Error {
  readonly name = "DatabaseMaintenanceReadError";

  constructor(readonly sql: string, readonly column: string) {
    super(`Expected numeric ${column} from database maintenance query`);
  }
}

/**
 * Size of the trigram index, when this SQLite build can measure one.
 *
 * Probed rather than assumed: `dbstat` is a compile-time option, and which platforms have it is not
 * something this engine gets to decide. An absent one is a missing MEASUREMENT, never a missing
 * database — so it degrades to null and every other number in the report stands.
 */
export function ftsIndexBytes(db: Database): number | null {
  try {
    const row = db
      .query<{ bytes: number }, []>(
        "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name GLOB 'chunks_fts*'",
      )
      .get();
    return typeof row?.bytes === "number" ? row.bytes : null;
  } catch {
    return null; // no dbstat in this build (Bun on Linux, and any SQLite without the vtab)
  }
}

/**
 * External-content FTS sync — the drift PRAGMA integrity_check cannot see. chunks_fts and
 * pages_fts hold no text of their own; when they fall out of step with their content tables the
 * database is page-perfect and search is silently WRONG (stale ranking, missing hub hits) — a
 * quality regression indistinguishable from working until someone measures it. Reported as an
 * integrity failure because everything downstream then does the right thing already: db-health
 * says failed, compact refuses (VACUUM cannot fix this), and `wiki-doctor --fix` rebuilds the
 * derived index, whose reinserts re-fire the triggers and repopulate both tables.
 *
 * The FTS 'integrity-check' command is an INSERT, so a read-only connection (wiki-doctor's
 * precheck probe) cannot run it — there the countable half of the question stands in: a row-count
 * mismatch is the common drift shape (a missed trigger), and "cannot check" must never read as
 * "drifted", so an absent table (a legacy DB the next real connect will backfill) reports clean.
 */
export function ftsSyncMessages(db: Database, fts: string, contentTable: string): string[] {
  try {
    db.run(`INSERT INTO ${fts}(${fts}, rank) VALUES('integrity-check', 1)`);
    return [];
  } catch (e: any) {
    const message = String(e?.message ?? e);
    if (/malformed|corrupt/i.test(message)) {
      return [`fts drift: ${fts} is out of sync with ${contentTable} — run wiki-doctor --fix to rebuild the derived index`];
    }
    if (fts === "pages_fts" && /no such table:\s*(?:main\.)?pages_fts\b/i.test(message)) {
      return []; // legacy database; WikiIndex.connect creates and backfills this optional index
    }
    if (!/attempt to write a readonly database/i.test(message)) {
      return [`fts integrity check failed for ${fts}: ${message}`];
    }
    try {
      // NOT `COUNT(*) FROM ${fts}`: an external-content FTS answers table scans from its CONTENT
      // table, so that count matches by construction even when the index is empty — measured: a
      // delete-all'd pages_fts read as clean through this probe. The `_docsize` shadow table has
      // one row per document actually IN the index, and plain reads work on a read-only handle.
      const a = (db.query(`SELECT COUNT(*) AS c FROM ${fts}_docsize`).get() as { c: number }).c;
      const b = (db.query(`SELECT COUNT(*) AS c FROM ${contentTable}`).get() as { c: number }).c;
      return a === b ? [] : [`fts drift: ${fts} indexes ${a} row(s) for ${b} ${contentTable} row(s) — run wiki-doctor --fix`];
    } catch (fallbackError: any) {
      const fallbackMessage = String(fallbackError?.message ?? fallbackError);
      if (fts === "pages_fts" && /no such table:\s*(?:main\.)?pages_fts(?:_docsize)?\b/i.test(fallbackMessage)) {
        try {
          const exists = db
            .query<{ readonly present: number }, [string]>(
              "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS present",
            )
            .get(fts)?.present;
          if (exists === 0) return []; // legacy database; the whole optional FTS table is absent
        } catch (existenceError: any) {
          return [`fts readonly fallback failed for ${fts}: ${String(existenceError?.message ?? existenceError)}`];
        }
      }
      return [`fts readonly fallback failed for ${fts}: ${fallbackMessage}`];
    }
  }
}

function inspectIntegrity(db: Database): DatabaseHealthReport["integrity"] {
  const messages = db
    .query<IntegrityRow, []>("PRAGMA integrity_check")
    .all()
    .filter((row) => row.integrity_check !== "ok")
    .map((row) => row.integrity_check);
  const foreignKeyMessages = db
    .query<ForeignKeyRow, []>("PRAGMA foreign_key_check")
    .all()
    .map((row) => `foreign key: ${row.table} row ${row.rowid} references ${row.parent} (${row.fkid})`);
  const ftsMessages = [
    ...ftsSyncMessages(db, "chunks_fts", "document_chunks"),
    ...ftsSyncMessages(db, "pages_fts", "documents"),
  ];
  return {
    ok: messages.length === 0 && foreignKeyMessages.length === 0 && ftsMessages.length === 0,
    messages: [...messages, ...foreignKeyMessages, ...ftsMessages],
  };
}

export function inspectDatabaseHealth(
  db: Database,
  policy: DatabaseCompactionPolicy = DEFAULT_DB_COMPACTION_POLICY,
): DatabaseHealthReport {
  const pageSizeBytes = scalar(db, "PRAGMA page_size", "page_size");
  const pageCount = scalar(db, "PRAGMA page_count", "page_count");
  const freePages = scalar(db, "PRAGMA freelist_count", "freelist_count");
  const databaseBytes = pageSizeBytes * pageCount;
  const freeBytes = pageSizeBytes * freePages;
  const freeRatio = pageCount === 0 ? 0 : freePages / pageCount;
  const buckets = db
    .query<BucketRow, []>(
      "SELECT d.source_kind, CASE WHEN d.status='failed' THEN 'failed' WHEN d.content IS NULL THEN 'metadata_only' ELSE 'live' END AS tier, " +
        "COUNT(*) AS documents, COALESCE(SUM((SELECT COUNT(*) FROM document_chunks dc WHERE dc.document_id=d.id)), 0) AS chunks, " +
        "COALESCE(SUM(CASE WHEN d.status != 'failed' AND d.content IS NOT NULL THEN d.file_size ELSE 0 END), 0) AS live_indexed_bytes " +
        "FROM documents d GROUP BY d.source_kind, tier ORDER BY d.source_kind, tier",
    )
    .all()
    .map((row) => ({
      sourceKind: row.source_kind,
      tier: row.tier,
      documents: row.documents,
      chunks: row.chunks,
      liveIndexedBytes: row.live_indexed_bytes,
    }));
  const integrity = inspectIntegrity(db);
  return {
    integrity,
    storage: { databaseBytes, pageSizeBytes, pageCount, freePages, freeBytes, freeRatio },
    ftsBytes: ftsIndexBytes(db),
    buckets,
    liveIndexedBytes: buckets.reduce((total, bucket) => total + bucket.liveIndexedBytes, 0),
    compactionEligible:
      integrity.ok &&
      databaseBytes >= policy.minimumDatabaseBytes &&
      freeBytes >= policy.minimumFreeBytes &&
      freeRatio >= policy.minimumFreeRatio,
  };
}

export function compactDatabase(db: Database, options: DatabaseCompactOptions = {}): DatabaseCompactResult {
  const policy = options.policy ?? DEFAULT_DB_COMPACTION_POLICY;
  const health = inspectDatabaseHealth(db, policy);
  if (!health.integrity.ok) return { kind: "refused", reason: "integrity_failed", health };
  if (!health.compactionEligible) return { kind: "not_needed", health };
  if (options.commit !== true) return { kind: "dry-run", health };
  db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
  db.run("VACUUM");
  return { kind: "compacted", before: health, after: inspectDatabaseHealth(db, policy) };
}
