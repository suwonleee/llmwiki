// Central capture queue (capture = central / content = per-repo).
// One small SQLite at <clone>/.state/capture.db records every session transcript
// the daemon sees, regardless of terminal/profile/repo. The update step (per-repo)
// reads its slice by repo path and advances the watermark here.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";

// Mutable module state (STATE_DIR/DB_PATH module globals that tests
// monkeypatch). Use setStateDir() in tests to redirect away from the real .state.
let STATE_DIR = process.env.LLMWIKI_STATE_DIR?.trim() || join(CLONE_ROOT, ".state");
let DB_PATH = join(STATE_DIR, "capture.db");

export function setStateDir(dir: string): void {
  STATE_DIR = dir;
  DB_PATH = join(dir, "capture.db");
}
export function getDbPath(): string {
  return DB_PATH;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS capture_queue (
    transcript_path TEXT PRIMARY KEY,
    session_id TEXT,
    repo TEXT,
    byte_offset INTEGER DEFAULT 0,
    lines INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','distilled','skipped')),
    source_kind TEXT DEFAULT 'claude-jsonl',
    first_seen TEXT DEFAULT (datetime('now')),
    distilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_repo ON capture_queue(repo);
CREATE INDEX IF NOT EXISTS idx_capture_status ON capture_queue(status);
`;

export interface CaptureRow {
  transcript_path: string;
  session_id: string | null;
  repo: string | null;
  byte_offset: number;
  lines: number;
  status: string;
  source_kind: string;
  first_seen: string;
  distilled_at: string | null;
}

function connect(): Database {
  mkdirSync(STATE_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(SCHEMA);
  // Additive, idempotent migration: DBs created before the source abstraction lack
  // source_kind. The default backfills every existing row as 'claude-jsonl' (correct —
  // they were all Claude transcripts), so no data migration is needed.
  const cols = db.query("PRAGMA table_info(capture_queue)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "source_kind")) {
    db.exec("ALTER TABLE capture_queue ADD COLUMN source_kind TEXT DEFAULT 'claude-jsonl'");
  }
  return db;
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

export function enqueue(
  transcriptPath: string,
  sessionId: string | null,
  repo: string | null,
  lines = 0,
  sourceKind = "claude-jsonl",
): void {
  const db = connect();
  const size = sizeOf(transcriptPath);
  const row = db
    .query("SELECT byte_offset FROM capture_queue WHERE transcript_path = ?")
    .get(transcriptPath) as { byte_offset: number } | null;
  if (row === null) {
    db.run(
      "INSERT INTO capture_queue (transcript_path, session_id, repo, lines, status, source_kind) VALUES (?, ?, ?, ?, 'pending', ?)",
      [transcriptPath, sessionId, repo, lines, sourceKind],
    );
  } else if (size > row.byte_offset) {
    db.run(
      "UPDATE capture_queue SET status='pending', repo=COALESCE(repo, ?), " +
        "session_id=COALESCE(session_id, ?), lines=? WHERE transcript_path=?",
      [repo, sessionId, lines, transcriptPath],
    );
  }
  db.close();
}

export function pending(repo: string | null = null): CaptureRow[] {
  const db = connect();
  const rows = repo
    ? (db
        .query("SELECT * FROM capture_queue WHERE status='pending' AND repo=? ORDER BY first_seen")
        .all(repo) as CaptureRow[])
    : (db
        .query("SELECT * FROM capture_queue WHERE status='pending' ORDER BY repo, first_seen")
        .all() as CaptureRow[]);
  const out = rows.filter((r) => {
    if (existsSync(r.transcript_path)) return statSync(r.transcript_path).size > r.byte_offset;
    // A harness may compress a finished transcript in place (Codex: foo.jsonl → foo.jsonl.zst).
    // Keep the row alive so the adapter's parse() can resolve the sibling — compressed size is
    // meaningless against a decompressed-byte watermark, so let parse decide (empty increment
    // → update-done advances and the row retires normally).
    return !r.transcript_path.endsWith(".zst") && existsSync(`${r.transcript_path}.zst`);
  });
  db.close();
  return out;
}

export function getOffset(transcriptPath: string): number {
  const db = connect();
  const row = db
    .query("SELECT byte_offset FROM capture_queue WHERE transcript_path = ?")
    .get(transcriptPath) as { byte_offset: number } | null;
  db.close();
  return row ? row.byte_offset : 0;
}

// Which adapter parses this row on the condense side. Defaults to 'claude-jsonl' for
// unknown/legacy rows so pre-migration queues keep parsing correctly.
export function getSourceKind(transcriptPath: string): string {
  const db = connect();
  const row = db
    .query("SELECT source_kind FROM capture_queue WHERE transcript_path = ?")
    .get(transcriptPath) as { source_kind: string | null } | null;
  db.close();
  return row?.source_kind || "claude-jsonl";
}

export function mark(transcriptPath: string, byteOffset: number, status = "distilled"): void {
  const db = connect();
  db.run(
    "UPDATE capture_queue SET byte_offset=?, status=?, distilled_at=datetime('now') WHERE transcript_path=?",
    [byteOffset, status, transcriptPath],
  );
  db.close();
}

// All transcripts the central queue has seen for a repo (any status). Used by
// `register-transcript` to make a warm /wiki-fast session's transcripts citable sources so
// decision/insight pages can cite the real session (not a repointed code file).
export function transcriptsForRepo(repo: string): { path: string; session: string | null }[] {
  const db = connect();
  const rows = db
    .query("SELECT transcript_path, session_id FROM capture_queue WHERE repo = ? ORDER BY first_seen")
    .all(repo) as { transcript_path: string; session_id: string | null }[];
  db.close();
  return rows.map((r) => ({ path: r.transcript_path, session: r.session_id }));
}

export function stats(): Record<string, number> {
  const db = connect();
  const rows = db
    .query("SELECT status, COUNT(*) n FROM capture_queue GROUP BY status")
    .all() as { status: string; n: number }[];
  db.close();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
