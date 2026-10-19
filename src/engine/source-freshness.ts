// Existing index signals only: no indexing, schema migration, model call or source traversal
// on the retrieval path. Missing/corrupt state is unknown, never evidence of freshness.
import { relative, resolve, sep } from "node:path";
import { referenceEdges } from "./refs.ts";
import { createHash } from "node:crypto";
import { readRepoFileBytes, repoFileExists } from "./repo-write.ts";
import { lstatSync } from "node:fs";
import { Database } from "bun:sqlite";
import { projectStateIsRegularFile, projectStatePath } from "./project-state.ts";

/** Repo-relative pages whose indexed dependencies changed since their last indexed edit.
 * This is a recheck signal, not a claim that the page is false. Ordinary page edits preserve
 * existing warnings. A future verification receipt can explicitly acknowledge rechecked sources.
 */
export function sourceChangedPages(root: string): ReadonlySet<string> {
  let db: Database | null = null;
  try {
    const indexPath = checkedIndexPath(root);
    db = new Database(indexPath, { readonly: true });
    const rows = db.query<{ relative_path: string }, []>(
      "SELECT relative_path FROM documents WHERE source_kind='wiki' AND stale_since IS NOT NULL",
    ).all();
    return new Set(rows.map((row) => row.relative_path));
  } catch {
    return new Set();
  } finally {
    db?.close();
  }
}

function checkedIndexPath(root: string): string {
    if (!projectStateIsRegularFile(root, "index.db")) throw new Error("Unsafe or missing index state");
    const path = projectStatePath(root, "index.db");
    const rel = relative(resolve(root), path);
    // Legacy in-repository state must also reject symlinked parent directories.
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !repoFileExists(root, rel)) throw new Error("Unsafe or missing index state");
    // Refuse planted journal links too: SQLite may access them even in readonly mode.
    for (const suffix of ["-wal", "-shm"]) {
      const path = projectStatePath(root, `index.db${suffix}`);
      try {
        lstatSync(path);
        if (!projectStateIsRegularFile(root, `index.db${suffix}`)) throw new Error("Unsafe or missing index state");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unsafe or missing index state");
      }
    }
  return projectStatePath(root, "index.db");
}

export type FreshnessSnapshot = {
  readonly schema_version: 1;
  readonly root: string;
  readonly page: { readonly path: string; readonly sha256: string };
  readonly dependencies: readonly { readonly path: string; readonly sha256: string }[];
  readonly stale_since: string | null;
};

function checkedHash(root: string, path: string, indexedHash: string | null): string {
  const bytes = readRepoFileBytes(root, path);
  if (bytes === null) throw new Error(`Cannot verify missing or unsafe source: ${path}`);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== indexedHash) throw new Error(`Index differs from disk; index current sources first: ${path}`);
  return hash;
}

function snapshotIn(db: Database, root: string, path: string): FreshnessSnapshot {
  if (!path.startsWith("docs/wiki/") || !path.endsWith(".md")) throw new Error("Expected a repo-relative wiki Markdown path");
  const page = db.query<{ id: string; content_hash: string | null; stale_since: string | null }, [string]>(
    "SELECT id, content_hash, stale_since FROM documents WHERE source_kind='wiki' AND relative_path=?",
  ).get(path);
  if (!page) throw new Error("Wiki page is not indexed");
  const pageBytes = readRepoFileBytes(root, path);
  if (pageBytes === null) throw new Error("Cannot read wiki page safely");
  const docs = db.query<Record<string, any>, []>("SELECT id, filename, path, relative_path, content_hash FROM documents WHERE status != 'failed'").all();
  const expectedIds = [...new Set(referenceEdges({ id: page.id, relative_path: path }, pageBytes.toString("utf8"), docs).map((edge) => edge[0]))].sort();
  const actualIds = db.query<{ target_document_id: string }, [string]>("SELECT DISTINCT target_document_id FROM document_references WHERE source_document_id=? AND reference_type IN ('cites','links_to')").all(page.id).map((r) => r.target_document_id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) throw new Error("Reference graph differs from page; rebuild references first");
  // Transcripts are insert-only virtual records with no repo file: they never mark a page stale,
  // so they are not revisions to verify — reading them as files made every session-cited page
  // impossible to acknowledge.
  const rows = db.query<{ relative_path: string; content_hash: string | null }, [string]>(
    "SELECT DISTINCT d.relative_path, d.content_hash FROM document_references r JOIN documents d " +
    "ON d.id=r.target_document_id WHERE r.source_document_id=? AND r.reference_type IN ('cites','links_to') " +
    "AND d.source_kind != 'transcript' ORDER BY d.relative_path",
  ).all(page.id);
  if (!rows.length) throw new Error("No indexed dependencies to verify; rebuild the reference graph first");
  return {
    schema_version: 1, root: resolve(root),
    page: { path, sha256: checkedHash(root, path, page.content_hash) },
    dependencies: rows.map((row) => ({ path: row.relative_path, sha256: checkedHash(root, row.relative_path, row.content_hash) })),
    stale_since: page.stale_since,
  };
}

/** Read the precise revisions a warm verifier must inspect; does not acknowledge anything. */
export function freshnessSnapshot(root: string, pageRel: string): FreshnessSnapshot {
  const db = new Database(checkedIndexPath(root), { readonly: true });
  try { return snapshotIn(db, root, pageRel); } finally { db.close(); }
}

/** Explicit acknowledgement only, after the caller has actually checked current source claims.
 * Hashes prevent applying that decision to changed material; they do not certify its semantics.
 */
export function acknowledgeFreshness(
  root: string, expected: FreshnessSnapshot, verification: { verifiedBy: string; evidence: string },
): { cleared: boolean; snapshot: FreshnessSnapshot; verifiedBy: string; evidence: string } {
  if (typeof verification?.verifiedBy !== "string" || typeof verification?.evidence !== "string" || !verification.verifiedBy.trim() || !verification.evidence.trim()) throw new Error("Verifier and verification evidence are required");
  if (expected?.schema_version !== 1 || expected.root !== resolve(root) || typeof expected.page?.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.page.sha256) || !Array.isArray(expected.dependencies) ||
      expected.dependencies.some((d) => !d || typeof d.path !== "string" || typeof d.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256)) ||
      !(expected.stale_since === null || typeof expected.stale_since === "string")) throw new Error("Invalid freshness snapshot");
  const db = new Database(checkedIndexPath(root), { readwrite: true });
  try {
    return db.transaction(() => {
      const current = snapshotIn(db, root, expected.page.path);
      const normalized = {
        schema_version: expected.schema_version, root: expected.root, page: { path: expected.page.path, sha256: expected.page.sha256 },
        dependencies: expected.dependencies?.map((d) => ({ path: d.path, sha256: d.sha256 })), stale_since: expected.stale_since,
      };
      if (JSON.stringify(current) !== JSON.stringify(normalized)) throw new Error("Freshness snapshot changed; inspect current revisions again");
      db.run("CREATE TABLE IF NOT EXISTS freshness_verifications (id INTEGER PRIMARY KEY, verified_at TEXT NOT NULL DEFAULT (datetime('now')), receipt TEXT NOT NULL)");
      const receipt = { cleared: current.stale_since !== null, snapshot: current, ...verification };
      db.run("INSERT INTO freshness_verifications (receipt) VALUES (?)", [JSON.stringify(receipt)]);
      db.run("UPDATE documents SET stale_since=NULL WHERE source_kind='wiki' AND relative_path=? AND content_hash=?", [current.page.path, current.page.sha256]);
      return receipt;
    }).immediate();
  } finally { db.close(); }
}
