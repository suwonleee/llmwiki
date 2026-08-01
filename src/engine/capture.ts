// Central capture queue (capture = central / content = per-repo).
// One small SQLite at <clone>/.state/capture.db records every session transcript
// the daemon sees, regardless of terminal/profile/repo. The update step (per-repo)
// reads its slice by repo path and advances the watermark here.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { captureBucket } from "./wiki-root.ts";
import {
  EXPORT_TTL_DAYS,
  effectiveStateRoot,
  ensureOwnedStateRoot,
  expiredExportPairs,
  isOwnedExportPath,
  reassertPrivateModes,
  setEffectiveStateRoot,
} from "./state-dir.ts";

// Mutable module state (STATE_DIR/DB_PATH module globals that tests
// monkeypatch). Use setStateDir() in tests to redirect away from the real .state.
let STATE_DIR = effectiveStateRoot();
let DB_PATH = join(STATE_DIR, "capture.db");

function syncStatePaths(): void {
  const root = effectiveStateRoot();
  if (root === STATE_DIR) return;
  STATE_DIR = root;
  DB_PATH = join(root, "capture.db");
}

export function setStateDir(dir: string): void {
  STATE_DIR = dir;
  DB_PATH = join(dir, "capture.db");
  setEffectiveStateRoot(dir);
}
export function getDbPath(): string {
  syncStatePaths();
  return DB_PATH;
}
/** Where the machine-local runtime state lives (reported and purged by the uninstall path). */
export function stateDir(): string {
  syncStatePaths();
  return STATE_DIR;
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS capture_queue (
    transcript_path TEXT PRIMARY KEY,
    session_id TEXT,
    repo TEXT,
    byte_offset INTEGER DEFAULT 0,
    lines INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','distilled','skipped','lost')),
    source_kind TEXT DEFAULT 'claude-jsonl',
    file_id TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    distilled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_repo ON capture_queue(repo);
CREATE INDEX IF NOT EXISTS idx_capture_status ON capture_queue(status);
CREATE TABLE IF NOT EXISTS route_hint (
    transcript_path TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    session_id TEXT,
    source_kind TEXT,
    seen_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS opencode_progress (
    source_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_seq INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source_path, session_id)
);
CREATE TABLE IF NOT EXISTS opencode_append (
    source_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    export_path TEXT NOT NULL,
    base_size INTEGER NOT NULL,
    from_seq INTEGER NOT NULL,
    through_seq INTEGER NOT NULL,
    expected_bytes INTEGER NOT NULL,
    expected_sha256 TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_token TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source_path, session_id)
);
CREATE TABLE IF NOT EXISTS opencode_v1_progress (
    source_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    last_message_id TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source_path, session_id)
);
CREATE TABLE IF NOT EXISTS opencode_v1_append (
    source_path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    export_path TEXT NOT NULL,
    base_size INTEGER NOT NULL,
    from_message_id TEXT NOT NULL,
    through_message_id TEXT NOT NULL,
    expected_bytes INTEGER NOT NULL,
    expected_sha256 TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_token TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source_path, session_id)
);
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

// Every open of this file — the 30s daemon sweep, both session hooks, and any `llmwiki`
// subcommand — runs the schema block above as a write transaction. Without a busy timeout SQLite's
// default is 0: the loser of any overlap fails INSTANTLY with SQLITE_BUSY, and both the daemon
// (a counter) and the hooks (`2>/dev/null; exit 0`) absorb that silently, so contention presents
// as missing capture rather than as an error. Wait instead — the per-repo index has made the same
// choice since its first WAL day (db.ts).
const BUSY_TIMEOUT_MS = 5000;

function applyBusyTimeout(db: Database): Database {
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  return db;
}

/** Readers wait too: a WAL checkpoint or a schema migration briefly locks them out as well. */
function openReadonly(): Database {
  return applyBusyTimeout(new Database(DB_PATH, { readonly: true }));
}

function connect(): Database {
  syncStatePaths();
  // The state root is created (or adopted) under the ownership contract, so the queue database
  // never lands in a directory this engine does not own — and never with default permissions.
  ensureOwnedStateRoot(STATE_DIR);
  const db = new Database(DB_PATH);
  applyBusyTimeout(db);
  db.exec(SCHEMA);
  // SQLite creates capture.db plus its -wal/-shm siblings with the process umask; re-assert the
  // private modes right after they exist rather than hoping the umask was strict.
  reassertPrivateModes(STATE_DIR);
  // Additive, idempotent migration: DBs created before the source abstraction lack
  // source_kind. The default backfills every existing row as 'claude-jsonl' (correct —
  // they were all Claude transcripts), so no data migration is needed.
  const cols = db.query("PRAGMA table_info(capture_queue)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "source_kind")) {
    db.exec("ALTER TABLE capture_queue ADD COLUMN source_kind TEXT DEFAULT 'claude-jsonl'");
  }
  if (!cols.some((c) => c.name === "file_id")) {
    db.exec("ALTER TABLE capture_queue ADD COLUMN file_id TEXT");
  }
  // A CHECK constraint cannot be altered in place, so widening it to accept the `lost` tombstone
  // means rebuilding the table. Idempotent and transactional: detect the old constraint by reading
  // the stored DDL, copy every row across, restore the indexes. Deleting the rows instead would be
  // simpler and is exactly what the 2026-07-22 decision rejected — a session that expired unfiled
  // is a record worth keeping, precisely because nobody will ever be able to reconstruct it.
  const ddl = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='capture_queue'").get() as
    | { sql: string | null }
    | null)?.sql;
  if (ddl && !ddl.includes("'lost'")) {
    db.exec("BEGIN");
    try {
      db.exec(
        "CREATE TABLE capture_queue_v2 (" +
          "transcript_path TEXT PRIMARY KEY, session_id TEXT, repo TEXT, byte_offset INTEGER DEFAULT 0, " +
          "lines INTEGER DEFAULT 0, " +
          "status TEXT DEFAULT 'pending' CHECK (status IN ('pending','distilled','skipped','lost')), " +
          "source_kind TEXT DEFAULT 'claude-jsonl', file_id TEXT, " +
          "first_seen TEXT DEFAULT (datetime('now')), distilled_at TEXT)",
      );
      db.exec(
        "INSERT INTO capture_queue_v2 (transcript_path, session_id, repo, byte_offset, lines, status, " +
          "source_kind, file_id, first_seen, distilled_at) SELECT transcript_path, session_id, repo, " +
          "byte_offset, lines, status, source_kind, file_id, first_seen, distilled_at FROM capture_queue",
      );
      db.exec("DROP TABLE capture_queue");
      db.exec("ALTER TABLE capture_queue_v2 RENAME TO capture_queue");
      db.exec("CREATE INDEX IF NOT EXISTS idx_capture_repo ON capture_queue(repo)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_capture_status ON capture_queue(status)");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const appendCols = db.query("PRAGMA table_info(opencode_append)").all() as { name: string }[];
  if (!appendCols.some((c) => c.name === "owner_pid")) {
    // Preserve the append evidence. A negative owner is an explicitly claimable legacy journal;
    // deleting the row independently of a partial/full export append would corrupt or duplicate it.
    db.exec("ALTER TABLE opencode_append ADD COLUMN owner_pid INTEGER NOT NULL DEFAULT -1");
  }
  if (!appendCols.some((c) => c.name === "owner_token")) {
    db.exec("ALTER TABLE opencode_append ADD COLUMN owner_token TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

/** Durable, non-body OpenCode watermark. Export bodies may expire without losing this progress. */
export function getOpenCodeProgress(sourcePath: string, sessionId: string): number | null {
  const db = connect();
  const row = db
    .query("SELECT last_seq FROM opencode_progress WHERE source_path = ? AND session_id = ?")
    .get(sourcePath, sessionId) as { last_seq: number } | null;
  db.close();
  return row && Number.isFinite(row.last_seq) ? row.last_seq : null;
}

export function advanceOpenCodeProgress(sourcePath: string, sessionId: string, lastSeq: number): void {
  if (!Number.isFinite(lastSeq)) return;
  const db = connect();
  db.run(
    "INSERT INTO opencode_progress (source_path, session_id, last_seq) VALUES (?, ?, ?) " +
      "ON CONFLICT(source_path, session_id) DO UPDATE SET " +
      "last_seq = MAX(opencode_progress.last_seq, excluded.last_seq), updated_at = datetime('now')",
    [sourcePath, sessionId, lastSeq],
  );
  db.close();
}

export interface OpenCodeAppendJournal {
  readonly exportPath: string;
  readonly baseSize: number;
  readonly fromSeq: number;
  readonly throughSeq: number;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly ownerPid: number;
  readonly ownerToken: string;
}

export interface OpenCodeOwner {
  readonly pid: number;
  readonly token: string;
}

// A process-identity token: PID plus the moment that PID started, so a recycled PID never reads as
// the original owner. Two ways to learn a start time, because neither is available everywhere:
//
//   proc-starttime — /proc/<pid>/stat field 22 (jiffies since boot). Linux only, but no spawn at
//                    all, and present in the minimal containers where `ps` is BusyBox's and has no
//                    `-o`. Before this, such a machine produced an empty token forever, which made
//                    openCodeOwnerLive answer "cannot prove" for eternity and no interrupted append
//                    was ever reclaimed.
//   ps-lstart      — `ps -p <pid> -o lstart=`. The macOS/BSD answer, and the original scheme.
//
// Tokens are compared ONLY within the same scheme: the two spellings of "when did this start" are
// not equal to each other, and treating a scheme change as a mismatch would report a live owner as
// dead. Liveness therefore regenerates in the STORED token's scheme when it can.
const PROC_START_TOKEN_PREFIX = "proc-starttime-v1:";
const PS_START_TOKEN_PREFIX = "ps-lstart-c-v1:";
const START_TOKEN_PREFIXES = [PROC_START_TOKEN_PREFIX, PS_START_TOKEN_PREFIX] as const;

function procStartToken(pid: number): string {
  let text: string;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return ""; // no procfs (macOS/BSD), or the process is gone
  }
  // comm (field 2) is parenthesized and may itself contain spaces or ')', so every field after it
  // is read relative to the LAST ')'. state (field 3) then lands at index 0, starttime (22) at 19.
  const close = text.lastIndexOf(")");
  if (close < 0) return "";
  const starttime = text.slice(close + 1).trim().split(/\s+/)[19];
  return starttime && /^\d+$/.test(starttime) ? PROC_START_TOKEN_PREFIX + starttime : "";
}

function psStartToken(pid: number): string {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const started = result.exitCode === 0 ? result.stdout.toString().trim() : "";
    return started ? PS_START_TOKEN_PREFIX + started : "";
  } catch {
    return "";
  }
}

function processStartToken(pid: number, prefer?: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  const order = prefer === PS_START_TOKEN_PREFIX ? [psStartToken, procStartToken] : [procStartToken, psStartToken];
  for (const read of order) {
    const token = read(pid);
    if (token) return token;
  }
  return "";
}

export function openCodeOwner(pid = process.pid): OpenCodeOwner {
  return { pid, token: processStartToken(pid) };
}

/** true = same live process, false = dead/reused PID, null = live state cannot be proven. */
export function openCodeOwnerLive(owner: OpenCodeOwner): boolean | null {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  const storedScheme = START_TOKEN_PREFIXES.find((prefix) => owner.token.startsWith(prefix));
  const currentToken = processStartToken(owner.pid, storedScheme);
  if (storedScheme && currentToken.startsWith(storedScheme)) {
    return currentToken === owner.token;
  }
  // Legacy/unversioned tokens and lookup failures cannot prove PID reuse. If that PID is still
  // alive, fail closed until it exits instead of taking over a possibly active append.
  try {
    process.kill(owner.pid, 0);
    return null;
  } catch (error: any) {
    return error?.code === "ESRCH" ? false : null;
  }
}

/**
 * Record an append before touching the plaintext export. The journal contains no conversation
 * body; it is only enough metadata to decide whether a restarted append is absent, partial, or
 * complete.
 */
export function beginOpenCodeAppend(
  sourcePath: string,
  sessionId: string,
  journal: Omit<OpenCodeAppendJournal, "ownerPid" | "ownerToken">,
  owner: OpenCodeOwner = openCodeOwner(),
): void {
  const db = connect();
  db.run(
    "INSERT INTO opencode_append " +
      "(source_path, session_id, export_path, base_size, from_seq, through_seq, expected_bytes, expected_sha256, owner_pid, owner_token) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sourcePath,
      sessionId,
      journal.exportPath,
      journal.baseSize,
      journal.fromSeq,
      journal.throughSeq,
      journal.expectedBytes,
      journal.expectedSha256,
      owner.pid,
      owner.token,
    ],
  );
  db.close();
}

export function getOpenCodeAppend(sourcePath: string, sessionId: string): OpenCodeAppendJournal | null {
  const db = connect();
  const row = db
    .query(
      "SELECT export_path, base_size, from_seq, through_seq, expected_bytes, expected_sha256, owner_pid, owner_token " +
        "FROM opencode_append WHERE source_path = ? AND session_id = ?",
    )
    .get(sourcePath, sessionId) as {
      export_path: string;
      base_size: number;
      from_seq: number;
      through_seq: number;
      expected_bytes: number;
      expected_sha256: string;
      owner_pid: number;
      owner_token: string;
    } | null;
  db.close();
  return row
    ? {
        exportPath: row.export_path,
        baseSize: row.base_size,
        fromSeq: row.from_seq,
        throughSeq: row.through_seq,
        expectedBytes: row.expected_bytes,
        expectedSha256: row.expected_sha256,
        ownerPid: row.owner_pid,
        ownerToken: row.owner_token,
      }
    : null;
}

/** Atomically claim a dead/legacy journal. Exactly one contender can match the prior owner. */
export function claimOpenCodeAppend(
  sourcePath: string,
  sessionId: string,
  expected: OpenCodeOwner,
  next: OpenCodeOwner = openCodeOwner(),
): boolean {
  const db = connect();
  const result = db.run(
    "UPDATE opencode_append SET owner_pid = ?, owner_token = ? " +
      "WHERE source_path = ? AND session_id = ? AND owner_pid = ? AND owner_token = ?",
    [next.pid, next.token, sourcePath, sessionId, expected.pid, expected.token],
  );
  db.close();
  return Number(result.changes ?? 0) === 1;
}

/** Commit the durable watermark and remove the append journal in one SQLite transaction. */
export function finishOpenCodeAppend(sourcePath: string, sessionId: string, lastSeq: number): void {
  const db = connect();
  const finish = db.transaction(() => {
    db.run(
      "INSERT INTO opencode_progress (source_path, session_id, last_seq) VALUES (?, ?, ?) " +
        "ON CONFLICT(source_path, session_id) DO UPDATE SET " +
        "last_seq = MAX(opencode_progress.last_seq, excluded.last_seq), updated_at = datetime('now')",
      [sourcePath, sessionId, lastSeq],
    );
    db.run("DELETE FROM opencode_append WHERE source_path = ? AND session_id = ?", [sourcePath, sessionId]);
  });
  finish();
  db.close();
}

// ---- OpenCode v1 (legacy `message`+`part`) watermark + append journal ------------------
//
// Installed OpenCode (1.18.4) still projects every ordinary session through the v1 event
// family into `message`/`part`; `session_message` stays empty until the `session.next.*`
// event-sourced path ships. The v1 cursor is the last fully-exported MESSAGE ID: OpenCode's
// own code (`MessageV2.latest`, cursor pagination) relies on message ids being
// lexicographically ascending, and a real installed DB agrees (across every legacy row, none
// orders differently from time_created). A TEXT id needs its own tables — the seq machinery
// above is INTEGER.

/** Durable, non-body v1 watermark: the last fully-exported message id (lexicographic max). */
export function getOpenCodeV1Progress(sourcePath: string, sessionId: string): string | null {
  const db = connect();
  const row = db
    .query("SELECT last_message_id FROM opencode_v1_progress WHERE source_path = ? AND session_id = ?")
    .get(sourcePath, sessionId) as { last_message_id: string } | null;
  db.close();
  return row && typeof row.last_message_id === "string" && row.last_message_id ? row.last_message_id : null;
}

export function advanceOpenCodeV1Progress(sourcePath: string, sessionId: string, lastMessageId: string): void {
  if (!lastMessageId) return;
  const db = connect();
  db.run(
    "INSERT INTO opencode_v1_progress (source_path, session_id, last_message_id) VALUES (?, ?, ?) " +
      "ON CONFLICT(source_path, session_id) DO UPDATE SET " +
      "last_message_id = MAX(opencode_v1_progress.last_message_id, excluded.last_message_id), " +
      "updated_at = datetime('now')",
    [sourcePath, sessionId, lastMessageId],
  );
  db.close();
}

export interface OpenCodeV1AppendJournal {
  readonly exportPath: string;
  readonly baseSize: number;
  readonly fromMessageId: string;
  readonly throughMessageId: string;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
  readonly ownerPid: number;
  readonly ownerToken: string;
}

export function beginOpenCodeV1Append(
  sourcePath: string,
  sessionId: string,
  journal: Omit<OpenCodeV1AppendJournal, "ownerPid" | "ownerToken">,
  owner: OpenCodeOwner = openCodeOwner(),
): void {
  const db = connect();
  db.run(
    "INSERT INTO opencode_v1_append " +
      "(source_path, session_id, export_path, base_size, from_message_id, through_message_id, expected_bytes, expected_sha256, owner_pid, owner_token) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sourcePath,
      sessionId,
      journal.exportPath,
      journal.baseSize,
      journal.fromMessageId,
      journal.throughMessageId,
      journal.expectedBytes,
      journal.expectedSha256,
      owner.pid,
      owner.token,
    ],
  );
  db.close();
}

export function getOpenCodeV1Append(sourcePath: string, sessionId: string): OpenCodeV1AppendJournal | null {
  const db = connect();
  const row = db
    .query(
      "SELECT export_path, base_size, from_message_id, through_message_id, expected_bytes, expected_sha256, owner_pid, owner_token " +
        "FROM opencode_v1_append WHERE source_path = ? AND session_id = ?",
    )
    .get(sourcePath, sessionId) as {
      export_path: string;
      base_size: number;
      from_message_id: string;
      through_message_id: string;
      expected_bytes: number;
      expected_sha256: string;
      owner_pid: number;
      owner_token: string;
    } | null;
  db.close();
  return row
    ? {
        exportPath: row.export_path,
        baseSize: row.base_size,
        fromMessageId: row.from_message_id,
        throughMessageId: row.through_message_id,
        expectedBytes: row.expected_bytes,
        expectedSha256: row.expected_sha256,
        ownerPid: row.owner_pid,
        ownerToken: row.owner_token,
      }
    : null;
}

/** Atomically claim a dead/legacy v1 journal. Exactly one contender can match the prior owner. */
export function claimOpenCodeV1Append(
  sourcePath: string,
  sessionId: string,
  expected: OpenCodeOwner,
  next: OpenCodeOwner = openCodeOwner(),
): boolean {
  const db = connect();
  const result = db.run(
    "UPDATE opencode_v1_append SET owner_pid = ?, owner_token = ? " +
      "WHERE source_path = ? AND session_id = ? AND owner_pid = ? AND owner_token = ?",
    [next.pid, next.token, sourcePath, sessionId, expected.pid, expected.token],
  );
  db.close();
  return Number(result.changes ?? 0) === 1;
}

/** Commit the v1 watermark and remove the v1 append journal in one SQLite transaction. */
export function finishOpenCodeV1Append(sourcePath: string, sessionId: string, lastMessageId: string): void {
  const db = connect();
  const finish = db.transaction(() => {
    db.run(
      "INSERT INTO opencode_v1_progress (source_path, session_id, last_message_id) VALUES (?, ?, ?) " +
        "ON CONFLICT(source_path, session_id) DO UPDATE SET " +
        "last_message_id = MAX(opencode_v1_progress.last_message_id, excluded.last_message_id), " +
        "updated_at = datetime('now')",
      [sourcePath, sessionId, lastMessageId],
    );
    db.run("DELETE FROM opencode_v1_append WHERE source_path = ? AND session_id = ?", [sourcePath, sessionId]);
  });
  finish();
  db.close();
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

function hasUnreadTail(row: { transcript_path: string; byte_offset: number }): boolean {
  if (existsSync(row.transcript_path)) return statSync(row.transcript_path).size > row.byte_offset;
  return !row.transcript_path.endsWith(".zst") && existsSync(`${row.transcript_path}.zst`);
}

export function enqueue(
  transcriptPath: string,
  sessionId: string | null,
  repo: string | null,
  lines = 0,
  sourceKind = "claude-jsonl",
): void {
  // File the row under the wiki root the session's READS bind to — one answer for both halves
  // (the hook-binding rule, applied to the write side it was missing from). A raw cwd keys the
  // row under a bare subdirectory that no update-status or cold-start backlog ever queries:
  // captured, invisible, unselectable — and self-selection cannot happen to a session nobody sees.
  if (repo) repo = captureBucket(repo);
  const db = connect();
  const size = sizeOf(transcriptPath);
  const currentFileId = fileIdentity(transcriptPath);
  const row = db
    .query("SELECT byte_offset, source_kind, file_id FROM capture_queue WHERE transcript_path = ?")
    .get(transcriptPath) as { byte_offset: number; source_kind: string | null; file_id: string | null } | null;
  if (row === null) {
    db.run(
      "INSERT INTO capture_queue " +
        "(transcript_path, session_id, repo, lines, status, source_kind, file_id) " +
        "VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      [transcriptPath, sessionId, repo, lines, sourceKind, currentFileId],
    );
  } else if (
    sourceKind === "opencode" &&
    row.source_kind === "opencode" &&
    row.file_id !== null &&
    currentFileId !== null &&
    row.file_id !== currentFileId
  ) {
    // A retained distilled ledger row may outlive the 30-day plaintext export. If that logical
    // path is later recreated with only newer messages, inode identity—not byte size—proves it is
    // a new generation. This remains correct across a crash between file creation and enqueue.
    db.run(
      "UPDATE capture_queue SET byte_offset=0, status='pending', distilled_at=NULL, " +
        "repo=COALESCE(repo, ?), session_id=COALESCE(session_id, ?), lines=?, file_id=? " +
        "WHERE transcript_path=?",
      [repo, sessionId, lines, currentFileId, transcriptPath],
    );
  } else if (size > row.byte_offset) {
    db.run(
      "UPDATE capture_queue SET status='pending', repo=COALESCE(repo, ?), " +
        "session_id=COALESCE(session_id, ?), lines=?, file_id=COALESCE(file_id, ?) WHERE transcript_path=?",
      [repo, sessionId, lines, currentFileId, transcriptPath],
    );
  } else if (row.file_id === null && currentFileId !== null) {
    // Additive migration for a live row created before file identity was recorded. Do not reset
    // its watermark: there is no earlier identity to compare against.
    db.run("UPDATE capture_queue SET file_id=? WHERE transcript_path=?", [currentFileId, transcriptPath]);
  }
  db.close();
}

export function pending(repo: string | null = null): CaptureRow[] {
  // Readers pass whatever spelling they were handed; rows are keyed by the canonical bucket.
  // The same normalizer on both sides is the whole invariant — /var vs /private/var split a
  // bucket into two on macOS, and the half the reader missed simply did not exist for them.
  if (repo) repo = captureBucket(repo);
  const db = connect();
  const rows = repo
    ? (db
        .query("SELECT * FROM capture_queue WHERE status='pending' AND repo=? ORDER BY first_seen")
        .all(repo) as CaptureRow[])
    : (db
        .query("SELECT * FROM capture_queue WHERE status='pending' ORDER BY repo, first_seen")
        .all() as CaptureRow[]);
  const out = rows.filter(hasUnreadTail);
  db.close();
  return out;
}

/** Read the live pending slice without creating or migrating the central capture database.
 *
 * `wiki-doctor` is diagnostic by default. Calling the normal `pending()` helper would create
 * `.state/capture.db` on a machine that has never installed the daemon, so the read-only path
 * opens an existing database explicitly and otherwise reports an empty queue.
 */
export interface PendingReadOnlyInspection {
  readonly status: "absent" | "current" | "unreadable";
  readonly rows: readonly CaptureRow[];
  readonly error: string | null;
}

export function inspectPendingReadOnly(repo: string | null = null): PendingReadOnlyInspection {
  if (repo) repo = captureBucket(repo); // same normalizer as the writers — see pending()
  syncStatePaths();
  if (!existsSync(DB_PATH)) return { status: "absent", rows: [], error: null };
  let db: Database | null = null;
  try {
    db = openReadonly();
    const rows = repo
      ? (db
          .query("SELECT * FROM capture_queue WHERE status='pending' AND repo=? ORDER BY first_seen")
          .all(repo) as CaptureRow[])
      : (db
          .query("SELECT * FROM capture_queue WHERE status='pending' ORDER BY repo, first_seen")
          .all() as CaptureRow[]);
    return { status: "current", rows: rows.filter(hasUnreadTail), error: null };
  } catch (error) {
    return {
      status: "unreadable",
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

export function pendingReadOnly(repo: string | null = null): CaptureRow[] {
  return [...inspectPendingReadOnly(repo).rows];
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
// `register-transcript` to make a warm /wiki-save session's transcripts citable sources so
// decision/insight pages can cite the real session (not a repointed code file).
export function transcriptsForRepo(repo: string): { path: string; session: string | null }[] {
  repo = captureBucket(repo); // same normalizer as the writers — see pending()
  const db = connect();
  const rows = db
    .query("SELECT transcript_path, session_id FROM capture_queue WHERE repo = ? ORDER BY first_seen")
    .all(repo) as { transcript_path: string; session_id: string | null }[];
  db.close();
  return rows.map((r) => ({ path: r.transcript_path, session: r.session_id }));
}

/**
 * Read transcript identities only when the queue already exists. Language detection and status
 * output use this path so observing a fresh installation never creates a state root or database.
 */
export function transcriptsForRepoReadOnly(repo: string): { path: string; session: string | null }[] {
  repo = captureBucket(repo); // same normalizer as the writers — see pending()
  syncStatePaths();
  if (!existsSync(DB_PATH)) return [];
  let db: Database | null = null;
  try {
    db = openReadonly();
    const rows = db
      .query("SELECT transcript_path, session_id FROM capture_queue WHERE repo = ? ORDER BY first_seen")
      .all(repo) as { transcript_path: string; session_id: string | null }[];
    return rows.map((r) => ({ path: r.transcript_path, session: r.session_id }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Record what the HARNESS said about the session currently running: this transcript belongs to
 * this repository.
 *
 * Stage-1 routing infers the same fact by reading a bounded prefix of the transcript, which is an
 * inference about someone else's file format — and that inference silently resolved 22 of 2,687
 * real sessions when the format's key order stopped matching an assumption. Both hook-based
 * harnesses hand us the answer directly in the hook payload (`transcript_path`, required in
 * Codex's schema), so the engine no longer has to guess for the session you are actually in.
 *
 * This is a HINT, not an enqueue: the daemon consults it only when its own routing came back
 * empty, and every downstream gate (enrollment re-check, work threshold, materialize) still runs.
 * So a hint can never enqueue a trivial session, and never a repository the human did not enroll.
 *
 * Written only for an enrolled repository — the caller checks, and so does the reader.
 */
export function recordRouteHint(
  transcriptPath: string,
  repo: string,
  sessionId: string | null,
  sourceKind: string | null,
): void {
  // Same normalization as enqueue, so a hint can never re-introduce the raw-cwd bucket: pass the
  // session's cwd and the hint records the repository whose wiki that session actually reads.
  repo = captureBucket(repo);
  const db = connect();
  try {
    db.run(
      "INSERT INTO route_hint (transcript_path, repo, session_id, source_kind) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(transcript_path) DO UPDATE SET repo=excluded.repo, session_id=excluded.session_id, " +
        "source_kind=excluded.source_kind, seen_at=datetime('now')",
      [transcriptPath, repo, sessionId, sourceKind],
    );
  } finally {
    db.close();
  }
}

/**
 * Every transcript a harness explicitly attributed to this SESSION ID (SessionStart hooks write
 * the mapping). This is the manual `save-current` lookup: an exact identity match, never recency.
 */
export function routeHintsForSession(
  sessionId: string,
): { transcriptPath: string; repo: string; sourceKind: string | null }[] {
  syncStatePaths();
  if (!sessionId || !existsSync(DB_PATH)) return [];
  let db: Database | null = null;
  try {
    db = openReadonly();
    const rows = db
      .query("SELECT transcript_path, repo, source_kind FROM route_hint WHERE session_id = ? ORDER BY seen_at")
      .all(sessionId) as { transcript_path: string; repo: string; source_kind: string | null }[];
    return rows.map((r) => ({ transcriptPath: r.transcript_path, repo: r.repo, sourceKind: r.source_kind }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Queue rows already recorded for this session id (any status) — the second exact-match source. */
export function queueRowsForSession(sessionId: string): CaptureRow[] {
  syncStatePaths();
  if (!sessionId || !existsSync(DB_PATH)) return [];
  let db: Database | null = null;
  try {
    db = openReadonly();
    return db
      .query("SELECT * FROM capture_queue WHERE session_id = ? ORDER BY first_seen")
      .all(sessionId) as CaptureRow[];
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** The harness-supplied repository for a transcript, or null when we were never told. */
export function routeHintFor(transcriptPath: string): { repo: string; sessionId: string | null } | null {
  syncStatePaths();
  if (!existsSync(DB_PATH)) return null;
  let db: Database | null = null;
  try {
    db = openReadonly();
    const row = db
      .query("SELECT repo, session_id FROM route_hint WHERE transcript_path = ?")
      .get(transcriptPath) as { repo: string; session_id: string | null } | null;
    return row ? { repo: row.repo, sessionId: row.session_id } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export interface CaptureHealth {
  /** Rows per source adapter, newest observation first seen at `lastSeen` (UTC text). */
  readonly byKind: { kind: string; rows: number; lastSeen: string | null }[];
  /** Distinct repositories the queue has ever routed to. */
  readonly repos: string[];
  readonly lastSeen: string | null;
}

/**
 * Read-only snapshot for `doctor`. Returns null when there is no queue yet — observing an
 * installation must never create its state.
 *
 * This exists because the two capture failures found in the field (a router that resolved 22 of
 * 2,687 sessions, a state root the engine refused to adopt) were both INVISIBLE: the daemon kept
 * running, cold start kept injecting, and doctor reported every surface healthy while nothing was
 * being captured. A health check that cannot see "last capture: 3 weeks ago" cannot catch the next
 * one either.
 */
export function healthReadOnly(): CaptureHealth | null {
  syncStatePaths();
  if (!existsSync(DB_PATH)) return null;
  let db: Database | null = null;
  try {
    db = openReadonly();
    const byKind = db
      .query(
        "SELECT COALESCE(source_kind,'(unknown)') kind, COUNT(*) rows, MAX(first_seen) lastSeen " +
          "FROM capture_queue GROUP BY 1 ORDER BY rows DESC",
      )
      .all() as { kind: string; rows: number; lastSeen: string | null }[];
    const repos = (
      db.query("SELECT DISTINCT repo FROM capture_queue WHERE repo IS NOT NULL").all() as {
        repo: string;
      }[]
    ).map((r) => r.repo);
    const lastSeen = byKind.reduce<string | null>(
      (max, k) => (k.lastSeen && (max === null || k.lastSeen > max) ? k.lastSeen : max),
      null,
    );
    return { byKind, repos, lastSeen };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** How long before the deadline a session starts being worth mentioning. */
export const EXPIRY_WARN_DAYS = 7;

export interface RetentionBacklog {
  /** Inside the window, but the deadline lands within EXPIRY_WARN_DAYS — the only actionable band. */
  expiringSoon: number;
  /** Past the retention window but still on disk — condensing these is a race still worth running. */
  atRisk: number;
  /** Past it and already deleted. Nothing is recoverable; the rows are dead weight in the queue. */
  lost: number;
}

/**
 * The part of a backlog that has a DEADLINE, counted from rows the caller already has.
 *
 * A backlog count answers "how much is undone", which is background noise once it stops changing.
 * "Three of these disappear this week" is a different sentence: it can be acted on, and it stops
 * being true if it is ignored. Only rows whose retention we actually know are counted — a deadline
 * we cannot compute must not be announced — and a transcript that is already gone is not expiring.
 */
export function expiringWithin(
  rows: readonly CaptureRow[],
  retentionDays: number,
  kind = "claude-jsonl",
  warnDays = EXPIRY_WARN_DAYS,
): number {
  const cutoffMs = Date.now() - Math.max(0, retentionDays - warnDays) * 86_400_000;
  let n = 0;
  for (const row of rows) {
    if (row.source_kind !== kind) continue;
    const seen = Date.parse(`${row.first_seen}Z`.replace(" ", "T"));
    if (!Number.isFinite(seen) || seen > cutoffMs) continue;
    if (hasUnreadTail(row)) n += 1;
  }
  return n;
}

/**
 * Pending rows whose transcript is older than the harness's retention window, split by whether the
 * evidence still exists. Age alone cannot answer that: the harness deletes on its own schedule, so
 * "older than retention" is a mix of "hurry" and "too late". Counting them together turns a deadline
 * into a permanent nag — the row never leaves `pending`, so it is reported forever while the only
 * honest instruction changed from "condense it" to "there is nothing left to condense".
 * Read-only; zeroes when there is no queue.
 */
export function pendingPastRetentionReadOnly(days: number, kind = "claude-jsonl"): RetentionBacklog {
  syncStatePaths();
  const empty = { expiringSoon: 0, atRisk: 0, lost: 0 };
  if (!existsSync(DB_PATH)) return empty;
  const window = Math.max(0, Math.floor(days));
  let db: Database | null = null;
  try {
    db = openReadonly();
    // One query for both bands: everything old enough that the deadline is in sight, split below.
    const rows = db
      .query(
        "SELECT transcript_path, byte_offset, first_seen FROM capture_queue WHERE status='pending' " +
          "AND source_kind = ? AND first_seen < datetime('now', ?)",
      )
      .all(kind, `-${Math.max(0, window - EXPIRY_WARN_DAYS)} days`) as {
      transcript_path: string;
      byte_offset: number;
      first_seen: string;
    }[];
    const deadlineMs = Date.now() - window * 86_400_000;
    const out = { expiringSoon: 0, atRisk: 0, lost: 0 };
    for (const row of rows) {
      const seen = Date.parse(`${row.first_seen}Z`.replace(" ", "T"));
      const past = Number.isFinite(seen) && seen <= deadlineMs;
      if (!hasUnreadTail(row)) {
        if (past) out.lost += 1; // only a passed deadline can explain a missing transcript
        continue;
      }
      if (past) out.atRisk += 1;
      else out.expiringSoon += 1;
    }
    return out;
  } catch {
    return empty;
  } finally {
    db?.close();
  }
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

// Delete queue rows that can never condense again: still pending, transcript gone (no .zst
// sibling either — same liveness rule as pending()), and old enough that "gone" means the
// harness rotated it rather than a volume that happens to be unreachable right now — deleting
// a merely-unreachable row would reset its watermark and re-condense already-filed content
// when the file reappears. Distilled/skipped rows stay regardless of the file: they are the
// ledger of what was filed (register-transcript reads them for citations).
/**
 * Delete OpenCode export/meta pairs past the retention window, together with any still-pending
 * queue row that pointed at them.
 *
 * The exports are the only place this engine keeps conversation BODIES, so they are the only
 * thing with an automatic expiry. Both members of a pair go together (a lone .meta.json would
 * make the next sweep re-export the whole session from seq 0), and the pending row goes with
 * them — leaving it would keep a row that can never condense in the backlog forever. Rows
 * already distilled/skipped stay: they are the ledger of what was filed, not data.
 */
export function pruneExports(ttlDays = EXPORT_TTL_DAYS, now = Date.now()): { pairs: number; rows: number } {
  syncStatePaths();
  ensureOwnedStateRoot(STATE_DIR);
  const expired = expiredExportPairs(STATE_DIR, now, ttlDays);
  const db = connect();
  let rows = 0;
  const pending = db
    .query("SELECT transcript_path FROM capture_queue WHERE status = 'pending' AND source_kind = 'opencode'")
    .all() as { transcript_path: string }[];
  for (const pair of expired) {
    if (pair.exportPath !== null) {
      // A session can disappear from OpenCode discovery (for example, be archived) while an
      // append journal is awaiting recovery. Once its owned plaintext export expires, discard
      // that body-free journal too; if the session returns, the durable watermark safely
      // re-materializes the uncommitted range.
      db.run("DELETE FROM opencode_append WHERE export_path = ?", [pair.exportPath]);
      db.run("DELETE FROM opencode_v1_append WHERE export_path = ?", [pair.exportPath]);
      for (const row of pending) {
        if (!isOwnedExportPath(row.transcript_path)) continue;
        let same = row.transcript_path === pair.exportPath;
        if (!same) {
          try {
            same = statSync(row.transcript_path).ino === statSync(pair.exportPath).ino;
          } catch {
            same = false;
          }
        }
        if (!same) continue;
        const r = db.run("DELETE FROM capture_queue WHERE transcript_path = ? AND status = 'pending'", [
          row.transcript_path,
        ]);
        rows += Number(r.changes ?? 0);
      }
    }
    for (const path of [pair.exportPath, pair.metaPath]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        /* already gone */
      }
    }
  }
  // If a previously owned export pair was externally removed, its pending queue row can never
  // make progress. Remove only OpenCode rows whose paths are still confined to our owned export
  // directory; unrelated missing transcript rows retain the normal age-based prune behavior.
  for (const row of pending) {
    if (!isOwnedExportPath(row.transcript_path) || existsSync(row.transcript_path)) continue;
    const r = db.run("DELETE FROM capture_queue WHERE transcript_path = ? AND status = 'pending'", [row.transcript_path]);
    rows += Number(r.changes ?? 0);
  }
  db.close();
  return { pairs: expired.length, rows };
}

export function prune(olderThanDays = 30): { removed: number; kept: number } {
  const db = connect();
  const rows = db
    .query("SELECT transcript_path, first_seen FROM capture_queue WHERE status='pending'")
    .all() as { transcript_path: string; first_seen: string | null }[];
  const cutoffMs = Date.now() - olderThanDays * 86_400_000;
  let removed = 0;
  for (const r of rows) {
    const alive =
      existsSync(r.transcript_path) ||
      (!r.transcript_path.endsWith(".zst") && existsSync(`${r.transcript_path}.zst`));
    if (alive) continue;
    // first_seen is sqlite datetime('now') — UTC "YYYY-MM-DD HH:MM:SS"
    const seenMs = r.first_seen ? Date.parse(`${r.first_seen.replace(" ", "T")}Z`) : NaN;
    if (Number.isNaN(seenMs) || seenMs > cutoffMs) continue;
    // Tombstone, not deletion (2026-07-22 decision, device 2): the transcript is gone, so this row
    // is the ONLY remaining evidence that the session existed at all. It leaves `pending` — nothing
    // will ever condense it — but stays auditable, and stays silent.
    db.run("UPDATE capture_queue SET status='lost' WHERE transcript_path = ?", [r.transcript_path]);
    removed++;
  }
  const kept = rows.length - removed;
  // Hints outlive nothing: once the harness has deleted the transcript there is no session left to
  // route, and the row is only a path→repository pair we were told about. Dropping them here keeps
  // the table the same size as "sessions that still exist", not "sessions that ever existed".
  for (const h of db.query("SELECT transcript_path FROM route_hint").all() as { transcript_path: string }[]) {
    const alive =
      existsSync(h.transcript_path) ||
      (!h.transcript_path.endsWith(".zst") && existsSync(`${h.transcript_path}.zst`));
    if (!alive) db.run("DELETE FROM route_hint WHERE transcript_path = ?", [h.transcript_path]);
  }
  db.close();
  return { removed, kept };
}
