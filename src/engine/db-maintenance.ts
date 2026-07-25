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
  readonly ftsBytes: number;
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
  return { ok: messages.length === 0 && foreignKeyMessages.length === 0, messages: [...messages, ...foreignKeyMessages] };
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
    ftsBytes: scalar(db, "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name GLOB 'chunks_fts*'", "bytes"),
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
