// OpenCode transcript adapter (kind="opencode") — the third harness, and the first whose
// sessions live in a DATABASE, not files: a single SQLite (`~/.local/share/opencode/
// opencode.db`, WAL) with event-sourced projections (`session`, `session_message`).
//
// Strategy: EXPORT MATERIALIZATION. The byte-offset watermark / capture_queue / condense
// core all assume append-only files, and that seam is load-bearing (P0 recap, pending()
// size checks, readTail). So discover() materializes each session into an append-only
// neutral jsonl under <clone>/.state/opencode-export/<sessionID>.jsonl (new messages only,
// tracked by a per-session .meta.json sidecar holding the last exported seq). Downstream,
// the export file behaves exactly like a Claude transcript — ZERO core changes.
//
// Schema access is defensive throughout: OpenCode migrates its Drizzle schema often, and
// this adapter must degrade to "no sessions" rather than crash a daemon sweep. DB is opened
// read-only (WAL allows concurrent readers) and never written.
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DiscoveredRoute, DiscoveredSession, ParseOpts, TranscriptSource } from "../source.ts";
import { discoverViaRoutes } from "./routing.ts";
import { readTail, type Increment, type Turn } from "../extract.ts";
import { canonicalWorktree, isEnrolledFresh } from "../enrollment.ts";
import * as capture from "../capture.ts";
import {
  EXPORT_DIR_NAME,
  effectiveExportDir,
  ensureOwnedStateRoot,
  reassertPrivateModes,
  setEffectiveStateRoot,
} from "../state-dir.ts";
import { persistedOpencodeDb } from "../harness-locate.ts";
import { openReadonlyDatabase } from "../sqlite-open.ts";
import { envValueOutsideRepoFiles } from "../env-policy.ts";

const HOME = homedir();
// ---- locations -----------------------------------------------------------------

// OpenCode data root is XDG-based; the DB may be channel-suffixed (opencode-<channel>.db)
// and $OPENCODE_DB overrides everything (database.ts:44-55). Lazy so tests can redirect.
export function opencodeDbPaths(): string[] {
  // env > persisted (`llmwiki connect opencode <db>`, verified at connect time) > XDG scan.
  // Both env reads are guarded: Bun autoloads the cwd's `.env` and the cwd is the user's
  // repository, so an unguarded read would let a tracked file redirect which database this engine
  // reads sessions out of.
  const override = envValueOutsideRepoFiles("OPENCODE_DB")?.trim() || persistedOpencodeDb() || "";
  if (override) {
    try {
      return existsSync(override) ? [realpathSync(override)] : [];
    } catch {
      return [];
    }
  }
  const dataDir =
    envValueOutsideRepoFiles("XDG_DATA_HOME")?.trim() || join(HOME, ".local", "share");
  const root = join(dataDir, "opencode");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // no OpenCode on this machine — normal
  }
  return entries
    .filter((f) => /^opencode(-[A-Za-z0-9_.-]+)?\.db$/.test(f))
    .map((f) => {
      try {
        return realpathSync(join(root, f));
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

// Tests may redirect the process-wide state root through the historical export-dir seam.
export function setExportDir(dir: string): void {
  setEffectiveStateRoot(dirname(dir));
}

function exportDir(): string {
  return effectiveExportDir();
}

// ---- neutral export format -------------------------------------------------------
// line 1: {"kind":"opencode-meta","sessionID":…,"directory":…,"title":…}
// lines:  {"role":"user"|"assistant","text":…,"ts":…}
interface ExportMeta {
  kind: "opencode-meta";
  sessionID: string;
  directory: string | null;
  title: string | null;
  sourcePath?: string;
  exportKey?: string;
}

function exportKey(sourcePath: string, sessionID: string): string {
  return createHash("sha256").update(sourcePath).update("\0").update(sessionID).digest("hex");
}

function metaPath(key: string): string {
  return join(exportDir(), `${key}.meta.json`);
}
function exportPath(key: string): string {
  return join(exportDir(), `${key}.jsonl`);
}

interface ExportProgress {
  readonly kind?: string;
  readonly exportKey?: string;
  readonly sessionID?: string;
  readonly sourcePath?: string;
  readonly lastSeq: number;
}

function readProgress(key: string): ExportProgress | null {
  try {
    const value = JSON.parse(readFileSync(metaPath(key), "utf-8"));
    return typeof value === "object" && value !== null && typeof value.lastSeq === "number"
      ? value as ExportProgress
      : null;
  } catch {
    return null;
  }
}

function assertSafeLeaf(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`unsafe OpenCode export path: ${path}`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

function safeRegular(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function legacyHeaderMatches(meta: ExportMeta | null, sessionID: string, directory: string): boolean {
  const keys = meta ? Object.keys(meta).sort() : [];
  if (
    !meta ||
    keys.length !== 4 ||
    keys[0] !== "directory" ||
    keys[1] !== "kind" ||
    keys[2] !== "sessionID" ||
    keys[3] !== "title" ||
    meta.sessionID !== sessionID ||
    meta.sourcePath !== undefined ||
    meta.exportKey !== undefined ||
    typeof meta.directory !== "string"
  ) {
    return false;
  }
  return canonicalWorktree(meta.directory) === directory;
}

function modernProgressMatches(
  progress: ExportProgress | null,
  key: string,
  sessionID: string,
  sourcePath: string,
): progress is Required<ExportProgress> {
  return (
    progress !== null &&
    progress.kind === "opencode-progress" &&
    progress.exportKey === key &&
    progress.sessionID === sessionID &&
    progress.sourcePath === sourcePath
  );
}

function legacyProgressMatches(progress: ExportProgress | null): progress is ExportProgress {
  if (progress === null) return false;
  return (
    progress.kind === undefined &&
    progress.exportKey === undefined &&
    progress.sessionID === undefined &&
    progress.sourcePath === undefined &&
    Object.keys(progress).length === 1
  );
}

// Sidecar progress for the v1 schema: same identity fields, message-id watermark instead of seq.
interface ExportProgressV1 {
  readonly kind?: string;
  readonly exportKey?: string;
  readonly sessionID?: string;
  readonly sourcePath?: string;
  readonly lastMessageId: string;
}

function readProgressV1(key: string): ExportProgressV1 | null {
  try {
    const value = JSON.parse(readFileSync(metaPath(key), "utf-8"));
    return typeof value === "object" && value !== null && typeof value.lastMessageId === "string"
      ? (value as ExportProgressV1)
      : null;
  } catch {
    return null;
  }
}

function v1ProgressMatches(
  progress: ExportProgressV1 | null,
  key: string,
  sessionID: string,
  sourcePath: string,
): progress is Required<ExportProgressV1> {
  return (
    progress !== null &&
    progress.kind === "opencode-progress-v1" &&
    progress.exportKey === key &&
    progress.sessionID === sessionID &&
    progress.sourcePath === sourcePath
  );
}

function renderRow(row: any): string | null {
  let data: any;
  try {
    data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  } catch {
    data = null;
  }
  const message = messageText(String(row.type ?? ""), data);
  if (!message) return null;
  const ts = row.time_created ? new Date(Number(row.time_created)).toISOString().slice(0, 16) : "";
  return JSON.stringify({ role: message.role, text: message.text, ts });
}

// A projected assistant row is UPDATED in place while the answer streams (step.started appends an
// empty row, text deltas rewrite `data`, and `seq` never changes). A cursor that advances past it
// mid-generation therefore never sees the finished text — the row's seq is already behind the
// watermark when the final update lands. So the export boundary stops at the first row that is
// not yet SETTLED, and only settled rows advance the cursor.
//
// Past this grace, a row with no completion marker is a crashed/abandoned turn: its partial text
// is all there will ever be, so it settles rather than stranding the tail of the session forever.
const STREAM_SETTLE_GRACE_MS = 6 * 60 * 60 * 1000;

function rowSettled(row: any, hasLater: boolean): boolean {
  if (String(row.type ?? "") !== "assistant") return true;
  // The projector "never resume[s] an older assistant projection": once any later row exists,
  // this one is final.
  if (hasLater) return true;
  let data: any;
  try {
    data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  } catch {
    data = null;
  }
  if (data?.time?.completed) return true;
  const created = Number(row.time_created ?? 0);
  return created > 0 && Date.now() - created > STREAM_SETTLE_GRACE_MS;
}

function renderedRange(
  db: Database,
  sessionID: string,
  afterSeq: number,
  throughSeq?: number,
): { appended: string; maxSeq: number } {
  const upper = throughSeq === undefined ? "" : " AND seq <= ?";
  const args = throughSeq === undefined ? [sessionID, afterSeq] : [sessionID, afterSeq, throughSeq];
  const rows = db
    .query(
      "SELECT seq, type, data, time_created FROM session_message " +
        `WHERE session_id = ? AND seq > ?${upper} ORDER BY seq ASC`,
    )
    .all(...args) as any[];
  // The settled boundary applies only to the LIVE sweep. Journal recovery re-renders an explicit
  // range whose rows were already settled when the journal was written; re-judging them against
  // the clock would make the byte-exact re-render nondeterministic.
  let boundary = rows.length;
  if (throughSeq === undefined) {
    for (let i = 0; i < rows.length; i++) {
      if (!rowSettled(rows[i], i < rows.length - 1)) {
        boundary = i;
        break;
      }
    }
  }
  let maxSeq = afterSeq;
  let appended = "";
  for (const row of rows.slice(0, boundary)) {
    const line = renderRow(row);
    if (line) appended += line + "\n";
    if (typeof row.seq === "number" && row.seq > maxSeq) maxSeq = row.seq;
  }
  return { appended, maxSeq };
}

// ---- v1 (legacy `message` + `part`) schema ---------------------------------------------
//
// Installed OpenCode (through at least 1.18.4) projects ordinary sessions via the v1 event
// family: `MessageUpdated` upserts `message`, `PartUpdated` upserts `part`, and the
// event-sourced `session_message` projection stays EMPTY (verified against a real installed
// DB: every session's conversation lives in message/part, session_message has zero rows).
// Reading only `session_message` therefore captured nothing. The v1 cursor is the last
// fully-exported message id — OpenCode itself relies on message ids sorting lexicographically
// in creation order (MessageV2.latest, its pagination cursor), and the same real DB agrees:
// across every legacy row, none orders differently from time_created.

type SessionSchemaKind = "next" | "v1";

function countRows(db: Database, table: "session_message" | "message", sessionID: string): number {
  try {
    const row = db
      .query(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
      .get(sessionID) as { n: number } | null;
    return Number(row?.n ?? 0);
  } catch {
    return 0; // table missing / schema drift — this schema simply has no rows
  }
}

// Which projection holds THIS session's conversation. Presence of a table is not evidence (the
// real 1.18.4 DB has an empty session_message table); rows for this session are. Existing durable
// progress pins the choice so a hypothetical mid-session projection switch can never double-export
// the overlap under a fresh cursor.
function sessionSchema(db: Database, sourcePath: string, sessionID: string): SessionSchemaKind | null {
  if (capture.getOpenCodeProgress(sourcePath, sessionID) !== null) return "next";
  if (capture.getOpenCodeV1Progress(sourcePath, sessionID) !== null) return "v1";
  if (countRows(db, "session_message", sessionID) > 0) return "next";
  if (countRows(db, "message", sessionID) > 0) return "v1";
  return null;
}

// One dialog line per v1 message, following MessageV2's own hydrate rules: text parts only
// (ordered by part id), a user part is dropped when `ignored` (synthetic stays — MessageV2 sends
// it), an errored assistant is dropped unless it was merely aborted and still carries text, and a
// `summary` assistant is the compaction summary — summaryFor's material, never a dialog turn.
function renderV1Row(row: any, data: any, parts: any[]): string | null {
  const role = data?.role;
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant") {
    if (data.summary === true) return null;
    if (data.error && String(data.error?.name ?? "") !== "MessageAbortedError") return null;
  }
  const texts: string[] = [];
  for (const p of parts) {
    let pd: any;
    try {
      pd = typeof p.data === "string" ? JSON.parse(p.data) : p.data;
    } catch {
      continue;
    }
    if (pd?.type !== "text" || typeof pd.text !== "string") continue;
    if (role === "user" && pd.ignored) continue;
    if (pd.text.trim()) texts.push(pd.text);
  }
  const text = texts.join(" ");
  if (!text.trim()) return null;
  const ts = row.time_created ? new Date(Number(row.time_created)).toISOString().slice(0, 16) : "";
  return JSON.stringify({ role, text, ts });
}

// v1 settled rule. Events project strictly in order, so any LATER message row proves this one is
// final (an assistant is never resumed once the turn moved on; a prompt's parts land before the
// next event). Without a later row: a completed assistant is settled; a user message is settled
// once it has any part row; otherwise wait out the streaming grace.
function v1RowSettled(row: any, data: any, partCount: number, hasLater: boolean): boolean {
  if (hasLater) return true;
  if (data?.role === "assistant") {
    if (data?.time?.completed) return true;
  } else if (partCount > 0) {
    return true;
  }
  const created = Number(row.time_created ?? 0);
  return created > 0 && Date.now() - created > STREAM_SETTLE_GRACE_MS;
}

function renderedRangeV1(
  db: Database,
  sessionID: string,
  afterId: string,
  throughId?: string,
): { appended: string; maxId: string } {
  const upper = throughId === undefined ? "" : " AND id <= ?";
  const args = throughId === undefined ? [sessionID, afterId] : [sessionID, afterId, throughId];
  const rows = db
    .query(
      "SELECT id, time_created, data FROM message " +
        `WHERE session_id = ? AND id > ?${upper} ORDER BY id ASC`,
    )
    .all(...args) as any[];
  // Message ids ascend, so the same id bounds select exactly the fetched messages' parts.
  const partUpper = throughId === undefined ? "" : " AND message_id <= ?";
  const partRows = db
    .query(
      "SELECT id, message_id, data FROM part " +
        `WHERE session_id = ? AND message_id > ?${partUpper} ORDER BY message_id ASC, id ASC`,
    )
    .all(...args) as any[];
  const partsByMessage = new Map<string, any[]>();
  for (const p of partRows) {
    const mid = String(p.message_id ?? "");
    const list = partsByMessage.get(mid);
    if (list) list.push(p);
    else partsByMessage.set(mid, [p]);
  }
  const datas = rows.map((row) => {
    try {
      return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    } catch {
      return null;
    }
  });
  // Same live-only settled boundary as renderedRange — recovery re-renders a settled range.
  let boundary = rows.length;
  if (throughId === undefined) {
    for (let i = 0; i < rows.length; i++) {
      const parts = partsByMessage.get(String(rows[i].id ?? "")) ?? [];
      if (!v1RowSettled(rows[i], datas[i], parts.length, i < rows.length - 1)) {
        boundary = i;
        break;
      }
    }
  }
  let maxId = afterId;
  let appended = "";
  for (let i = 0; i < boundary; i++) {
    const row = rows[i];
    const id = String(row.id ?? "");
    const line = renderV1Row(row, datas[i], partsByMessage.get(id) ?? []);
    if (line) appended += line + "\n";
    if (id > maxId) maxId = id;
  }
  return { appended, maxId };
}

/**
 * Finish an append interrupted between the durable journal and its queue enqueue. The journal
 * stores only a byte count/hash; message bodies are reconstructed from the enrolled source DB.
 */
function recoverPendingAppend(
  db: Database,
  sourcePath: string,
  sessionID: string,
  ep: string,
  durable: number | null,
): number | null {
  const pending = capture.getOpenCodeAppend(sourcePath, sessionID);
  if (!pending) return durable;
  const previousOwner = { pid: pending.ownerPid, token: pending.ownerToken };
  const thisOwner = capture.openCodeOwner();
  if (previousOwner.pid !== thisOwner.pid || previousOwner.token !== thisOwner.token) {
    const live = capture.openCodeOwnerLive(previousOwner);
    if (live !== false) {
      throw new Error(`OpenCode append is still owned by a live or unverifiable process ${pending.ownerPid}`);
    }
    if (!capture.claimOpenCodeAppend(sourcePath, sessionID, previousOwner, thisOwner)) {
      // Another live contender claimed or completed it after our read. Never recover against a
      // stale snapshot; the next sweep observes the winner's durable state.
      throw new Error(`OpenCode append ownership changed during recovery: ${ep}`);
    }
  }
  if (pending.exportPath !== ep || pending.fromSeq !== (durable ?? -1) || !safeRegular(ep)) {
    throw new Error(`refusing to reconcile an inconsistent OpenCode append journal: ${ep}`);
  }
  const reconstructed = renderedRange(db, sessionID, pending.fromSeq, pending.throughSeq);
  const bytes = Buffer.from(reconstructed.appended);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    reconstructed.maxSeq !== pending.throughSeq ||
    bytes.length !== pending.expectedBytes ||
    hash !== pending.expectedSha256
  ) {
    throw new Error(`refusing to reconcile a changed OpenCode append source: ${ep}`);
  }
  const body = readFileSync(ep);
  if (body.length < pending.baseSize || body.length > pending.baseSize + bytes.length) {
    throw new Error(`refusing to reconcile an unexpected OpenCode export size: ${ep}`);
  }
  const written = body.subarray(pending.baseSize);
  if (!written.equals(bytes.subarray(0, written.length))) {
    throw new Error(`refusing to reconcile an unexpected OpenCode export tail: ${ep}`);
  }
  if (written.length < bytes.length) appendFileSync(ep, bytes.subarray(written.length));
  capture.finishOpenCodeAppend(sourcePath, sessionID, pending.throughSeq);
  return pending.throughSeq;
}

/** v1 twin of recoverPendingAppend: identical ownership contract over a message-id range. */
function recoverPendingV1Append(
  db: Database,
  sourcePath: string,
  sessionID: string,
  ep: string,
  durable: string | null,
): string | null {
  const pending = capture.getOpenCodeV1Append(sourcePath, sessionID);
  if (!pending) return durable;
  const previousOwner = { pid: pending.ownerPid, token: pending.ownerToken };
  const thisOwner = capture.openCodeOwner();
  if (previousOwner.pid !== thisOwner.pid || previousOwner.token !== thisOwner.token) {
    const live = capture.openCodeOwnerLive(previousOwner);
    if (live !== false) {
      throw new Error(`OpenCode append is still owned by a live or unverifiable process ${pending.ownerPid}`);
    }
    if (!capture.claimOpenCodeV1Append(sourcePath, sessionID, previousOwner, thisOwner)) {
      throw new Error(`OpenCode append ownership changed during recovery: ${ep}`);
    }
  }
  if (pending.exportPath !== ep || pending.fromMessageId !== (durable ?? "") || !safeRegular(ep)) {
    throw new Error(`refusing to reconcile an inconsistent OpenCode append journal: ${ep}`);
  }
  const reconstructed = renderedRangeV1(db, sessionID, pending.fromMessageId, pending.throughMessageId);
  const bytes = Buffer.from(reconstructed.appended);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    reconstructed.maxId !== pending.throughMessageId ||
    bytes.length !== pending.expectedBytes ||
    hash !== pending.expectedSha256
  ) {
    throw new Error(`refusing to reconcile a changed OpenCode append source: ${ep}`);
  }
  const body = readFileSync(ep);
  if (body.length < pending.baseSize || body.length > pending.baseSize + bytes.length) {
    throw new Error(`refusing to reconcile an unexpected OpenCode export size: ${ep}`);
  }
  const written = body.subarray(pending.baseSize);
  if (!written.equals(bytes.subarray(0, written.length))) {
    throw new Error(`refusing to reconcile an unexpected OpenCode export tail: ${ep}`);
  }
  if (written.length < bytes.length) appendFileSync(ep, bytes.subarray(written.length));
  capture.finishOpenCodeV1Append(sourcePath, sessionID, pending.throughMessageId);
  return pending.throughMessageId;
}

/**
 * Import only the numeric v0.8 watermark, never its path identity. The old body is evidence for
 * which database produced it: every rendered message through lastSeq must match byte-for-byte.
 * This makes migration independent of DB discovery order when session ids collide.
 */
function migrateLegacyProgress(
  db: Database,
  sourcePath: string,
  sessionID: string,
  directory: string,
): number | null {
  if (!/^[A-Za-z0-9_.:-]+$/.test(sessionID)) return null;
  const ep = exportPath(sessionID);
  const mp = metaPath(sessionID);
  if (!safeRegular(ep) || !safeRegular(mp)) return null;
  if (!legacyHeaderMatches(readMeta(ep), sessionID, directory)) return null;
  const progress = readProgress(sessionID);
  if (!legacyProgressMatches(progress)) return null;
  let rows: any[];
  try {
    rows = db
      .query(
        "SELECT seq, type, data, time_created FROM session_message " +
          "WHERE session_id = ? AND seq <= ? ORDER BY seq ASC",
      )
      .all(sessionID, progress.lastSeq) as any[];
  } catch {
    return null;
  }
  const maxSeq = rows.reduce(
    (max, row) => (typeof row.seq === "number" && row.seq > max ? row.seq : max),
    -1,
  );
  if (maxSeq !== progress.lastSeq) return null;
  const rendered = rows.map(renderRow).filter((line): line is string => line !== null);
  let legacyBody: string[];
  try {
    legacyBody = readFileSync(ep, "utf-8").split("\n").filter(Boolean).slice(1);
  } catch {
    return null;
  }
  if (rendered.length !== legacyBody.length || rendered.some((line, index) => line !== legacyBody[index])) return null;
  capture.advanceOpenCodeProgress(sourcePath, sessionID, progress.lastSeq);
  return progress.lastSeq;
}

// data(JSON blob) → plain text per message type (schema/session-message.ts shapes).
function messageText(type: string, data: any): { role: "user" | "assistant"; text: string } | null {
  if (type === "user") {
    const t = typeof data?.text === "string" ? data.text : "";
    return t.trim() ? { role: "user", text: t } : null;
  }
  if (type === "assistant") {
    const parts = Array.isArray(data?.content) ? data.content : [];
    const t = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join(" ");
    return t.trim() ? { role: "assistant", text: t } : null;
  }
  // compaction/tool/system/synthetic… — not conversation turns (compaction is surfaced via
  // summaryFor instead, so the condense pass reuses it rather than re-reading it as dialog).
  return null;
}

// Append new messages for one session; returns total exported line count. The shared preamble
// proves the export pair's identity, then the session's OWN projection (sessionSchema) picks the
// seq-cursor (`session_message`) or message-id-cursor (`message`+`part`) branch.
function exportSession(
  db: Database,
  sourcePath: string,
  sessionID: string,
  directory: string,
  title: string | null,
): { path: string; lines: number } {
  // These files are verbatim conversation text kept on disk, so they are created private and
  // stay private — 0700 directory, 0600 files, re-asserted after every append (the umask of
  // whatever process ran the sweep is not a security policy).
  const root = ensureOwnedStateRoot(dirname(exportDir()));
  const dir = join(root, EXPORT_DIR_NAME);
  const existing = existsSync(dir);
  if (!existing) mkdirSync(dir, { mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error(`unsafe OpenCode export directory: ${dir}`);
  reassertPrivateModes(root);
  const key = exportKey(sourcePath, sessionID);
  const ep = exportPath(key);
  const mp = metaPath(key);
  assertSafeLeaf(ep);
  assertSafeLeaf(mp);
  const exportExists = existsSync(ep);
  const progressExists = existsSync(mp);
  if (!exportExists && progressExists) {
    throw new Error(`refusing to append to an incomplete OpenCode export pair: ${ep}`);
  }
  if (exportExists) {
    const existing = readMeta(ep);
    const modernHeader =
      existing?.sessionID === sessionID && existing.sourcePath === sourcePath && existing.exportKey === key;
    if (!modernHeader) {
      throw new Error(`refusing to append to an unrecognized OpenCode export: ${ep}`);
    }
  }
  const schema = sessionSchema(db, sourcePath, sessionID);
  if (schema === null) return { path: ep, lines: 0 }; // nothing projected for this session yet
  const loc = { key, ep, mp, root };
  return schema === "v1"
    ? exportSessionV1(db, sourcePath, sessionID, directory, title, loc)
    : exportSessionNext(db, sourcePath, sessionID, directory, title, loc);
}

// The `session_message` (event-sourced, seq-cursor) branch.
function exportSessionNext(
  db: Database,
  sourcePath: string,
  sessionID: string,
  directory: string,
  title: string | null,
  loc: { key: string; ep: string; mp: string; root: string },
): { path: string; lines: number } {
  const { key, ep, mp, root } = loc;
  const progressExists = existsSync(mp);
  let progress = progressExists ? readProgress(key) : null;
  if (progressExists) {
    const current = modernProgressMatches(progress, key, sessionID, sourcePath);
    if (!current) {
      throw new Error(`refusing to replace an unrecognized OpenCode progress file: ${mp}`);
    }
  }
  let durable = capture.getOpenCodeProgress(sourcePath, sessionID);
  if (progress && (durable === null || progress.lastSeq > durable)) {
    capture.advanceOpenCodeProgress(sourcePath, sessionID, progress.lastSeq);
    durable = progress.lastSeq;
  }
  if (durable === null) durable = migrateLegacyProgress(db, sourcePath, sessionID, directory);
  durable = recoverPendingAppend(db, sourcePath, sessionID, ep, durable);
  const since = durable ?? -1;
  let rendered: { appended: string; maxSeq: number };
  try {
    rendered = renderedRange(db, sessionID, since);
  } catch {
    return { path: ep, lines: 0 }; // schema drift — degrade silently
  }
  const { appended, maxSeq } = rendered;
  if (appended) {
    if (!existsSync(ep)) {
      const meta: ExportMeta = { kind: "opencode-meta", sessionID, directory, title, sourcePath, exportKey: key };
      writeFileSync(ep, JSON.stringify(meta) + "\n", { flag: "wx", mode: 0o600 });
    }
    const bytes = Buffer.from(appended);
    capture.beginOpenCodeAppend(sourcePath, sessionID, {
      exportPath: ep,
      baseSize: readFileSync(ep).length,
      fromSeq: since,
      throughSeq: maxSeq,
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    appendFileSync(ep, appended);
    capture.finishOpenCodeAppend(sourcePath, sessionID, maxSeq);
    durable = maxSeq;
  } else if (maxSeq > since) {
    capture.advanceOpenCodeProgress(sourcePath, sessionID, maxSeq);
    durable = maxSeq;
  }
  if (existsSync(ep) && (!progressExists || (durable ?? since) > (progress?.lastSeq ?? -1))) {
    writeFileSync(
      mp,
      JSON.stringify({ kind: "opencode-progress", exportKey: key, sessionID, sourcePath, lastSeq: durable ?? since }),
      { mode: 0o600 },
    );
  }
  if (!existsSync(ep)) return { path: ep, lines: 0 };
  try {
    reassertPrivateModes(root);
    const exportLines = readFileSync(ep, "utf-8").split("\n").filter(Boolean).length;
    // The export may contain only a post-migration/post-TTL tail. Threshold against total
    // session activity so a proven long session is not stranded until 50 brand-new lines arrive.
    return { path: ep, lines: Math.max(exportLines, countRows(db, "session_message", sessionID) + 1) };
  } catch {
    return { path: ep, lines: 0 };
  }
}

// The v1 (`message`+`part`, message-id-cursor) branch — the schema every installed OpenCode
// session actually uses today. Mirrors exportSessionNext step for step; only the cursor type
// and the renderer differ. No v0.8 sidecar migration here: that format predates v1 exports.
function exportSessionV1(
  db: Database,
  sourcePath: string,
  sessionID: string,
  directory: string,
  title: string | null,
  loc: { key: string; ep: string; mp: string; root: string },
): { path: string; lines: number } {
  const { key, ep, mp, root } = loc;
  const progressExists = existsSync(mp);
  const progress = progressExists ? readProgressV1(key) : null;
  if (progressExists && !v1ProgressMatches(progress, key, sessionID, sourcePath)) {
    throw new Error(`refusing to replace an unrecognized OpenCode progress file: ${mp}`);
  }
  let durable = capture.getOpenCodeV1Progress(sourcePath, sessionID);
  if (progress && (durable === null || progress.lastMessageId > durable)) {
    capture.advanceOpenCodeV1Progress(sourcePath, sessionID, progress.lastMessageId);
    durable = progress.lastMessageId;
  }
  durable = recoverPendingV1Append(db, sourcePath, sessionID, ep, durable);
  const since = durable ?? "";
  let rendered: { appended: string; maxId: string };
  try {
    rendered = renderedRangeV1(db, sessionID, since);
  } catch {
    return { path: ep, lines: 0 }; // schema drift — degrade silently
  }
  const { appended, maxId } = rendered;
  if (appended) {
    if (!existsSync(ep)) {
      const meta: ExportMeta = { kind: "opencode-meta", sessionID, directory, title, sourcePath, exportKey: key };
      writeFileSync(ep, JSON.stringify(meta) + "\n", { flag: "wx", mode: 0o600 });
    }
    const bytes = Buffer.from(appended);
    capture.beginOpenCodeV1Append(sourcePath, sessionID, {
      exportPath: ep,
      baseSize: readFileSync(ep).length,
      fromMessageId: since,
      throughMessageId: maxId,
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    appendFileSync(ep, appended);
    capture.finishOpenCodeV1Append(sourcePath, sessionID, maxId);
    durable = maxId;
  } else if (maxId > since) {
    capture.advanceOpenCodeV1Progress(sourcePath, sessionID, maxId);
    durable = maxId;
  }
  if (existsSync(ep) && (!progressExists || (durable ?? since) > (progress?.lastMessageId ?? ""))) {
    writeFileSync(
      mp,
      JSON.stringify({
        kind: "opencode-progress-v1",
        exportKey: key,
        sessionID,
        sourcePath,
        lastMessageId: durable ?? since,
      }),
      { mode: 0o600 },
    );
  }
  if (!existsSync(ep)) return { path: ep, lines: 0 };
  try {
    reassertPrivateModes(root);
    const exportLines = readFileSync(ep, "utf-8").split("\n").filter(Boolean).length;
    // Same long-session rule as the next branch, counted from this session's own projection.
    return { path: ep, lines: Math.max(exportLines, countRows(db, "message", sessionID) + 1) };
  } catch {
    return { path: ep, lines: 0 };
  }
}

// A plain read-only open needs write permission on the DIRECTORY (SQLite has to attach the WAL's
// -shm index there). On a read-only mount, or when OpenCode's data belongs to another uid, that
// fails and this adapter reported "no OpenCode sessions" for what is a permissions problem. The
// ladder in sqlite-open.ts falls back to a private snapshot, then to an immutable open.
function openRO(path: string): Database | null {
  return openReadonlyDatabase(path);
}

function readMeta(path: string): ExportMeta | null {
  try {
    const first = readFileSync(path, "utf-8").split("\n", 1)[0] ?? "";
    const o = JSON.parse(first);
    return o?.kind === "opencode-meta" ? (o as ExportMeta) : null;
  } catch {
    return null;
  }
}

export const opencodeSource: TranscriptSource = {
  kind: "opencode",

  // Stage 1 — routing ONLY. Two columns, one table: `session.id` and `session.directory`. Not
  // `title` (harness-generated text about the conversation), never `session_message`, and no
  // export file is created. OpenCode is the harness where the difference is starkest: before
  // this split, a daemon sweep wrote a full plaintext transcript to disk for every session on
  // the machine — including projects the user had never enrolled — merely to discover them.
  discoverRoutes(): DiscoveredRoute[] {
    const out: DiscoveredRoute[] = [];
    for (const dbPath of opencodeDbPaths()) {
      const db = openRO(dbPath);
      if (!db) continue;
      try {
        let sessions: any[];
        try {
          sessions = db
            .query("SELECT id, directory FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC")
            .all() as any[];
        } catch {
          continue; // schema drift
        }
        for (const s of sessions) {
          const id = String(s.id ?? "");
          if (!id) continue;
          const repo = typeof s.directory === "string" ? s.directory : null;
          out.push({
            path: exportPath(exportKey(dbPath, id)),
            sessionId: id,
            repo,
            sourcePath: dbPath,
            alwaysMaterialize: true,
          });
        }
      } finally {
        db.close();
      }
    }
    return out;
  },

  // Stage 2 — only for an ENROLLED repository: read the title, export the new message rows to
  // the append-only file, and report its size.
  materialize(route: DiscoveredRoute): DiscoveredSession | null {
    const id = route.sessionId;
    if (!id || !route.repo || !route.sourcePath) return null;
    let sourcePath: string;
    try {
      sourcePath = realpathSync(route.sourcePath);
    } catch {
      return null;
    }
    if (!opencodeDbPaths().includes(sourcePath)) return null;
    const db = openRO(sourcePath);
    if (!db) return null;
    try {
      let row: any;
      try {
        row = db.query("SELECT id, directory, title FROM session WHERE id = ?").get(id);
      } catch {
        return null;
      }
      if (!row || typeof row.directory !== "string") return null;
      const routedRepo = canonicalWorktree(route.repo);
      const currentRepo = canonicalWorktree(row.directory);
      if (!routedRepo || !currentRepo || routedRepo !== currentRepo || !isEnrolledFresh(currentRepo)) return null;
      const result = exportSession(db, sourcePath, id, currentRepo, row.title ?? null);
      if (result.lines <= 1) return null;
      return { path: result.path, sessionId: id, repo: currentRepo, lines: result.lines };
    } finally {
      db.close();
    }
  },

  discover(): DiscoveredSession[] {
    return discoverViaRoutes(opencodeSource);
  },

  // The watched file IS our own export, which only exists for a session that was already
  // enrolled and materialized — its meta line is the routing metadata.
  routeFor(path: string): DiscoveredRoute | null {
    const p = path.replace(/\\/g, "/");
    if (!p.endsWith(".jsonl") || !p.startsWith(exportDir().replace(/\\/g, "/") + "/")) return null;
    const meta = readMeta(path);
    return meta ? { path, sessionId: meta.sessionID, repo: meta.directory } : null;
  },

  probe(path: string): DiscoveredSession | null {
    const p = path.replace(/\\/g, "/");
    if (!p.endsWith(".jsonl") || !p.startsWith(exportDir().replace(/\\/g, "/") + "/")) return null;
    const meta = readMeta(path);
    if (!meta) return null;
    let lines = 0;
    try {
      lines = readFileSync(path, "utf-8").split("\n").filter(Boolean).length;
    } catch {
      /* keep 0 */
    }
    return { path, sessionId: meta.sessionID, repo: meta.directory, lines };
  },

  parse(path: string, startOffset: number, opts?: ParseOpts): Increment {
    const minChars = opts?.minChars ?? 180;
    const cap = opts?.cap ?? 700;
    const { raw, newOffset } = readTail(path, startOffset);
    const meta = readMeta(path);
    const users: Turn[] = [];
    const assistants: Turn[] = [];
    for (let line of raw.toString("utf-8").split("\n")) {
      line = line.trim();
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.kind === "opencode-meta") continue;
      const t = String(o.text ?? "").split(/\s+/).filter(Boolean).join(" ").trim();
      if (!t) continue;
      const ts = String(o.ts ?? "");
      if (o.role === "user") users.push({ ts, role: "user", text: t.slice(0, cap) });
      else if (o.role === "assistant" && t.length >= minChars)
        assistants.push({ ts, role: "assistant", text: t.slice(0, cap) });
    }
    return { users, assistants, newOffset, cwd: meta?.directory ?? null, sessionId: meta?.sessionID ?? null };
  },

  // P2: OpenCode persists its context-compaction summary as a session_message row
  // (type='compaction', data.summary) — reuse it instead of re-summarizing.
  summaryFor(path: string): string | null {
    try {
      const meta = readMeta(path);
      if (!meta) return null;
      const filename = basename(path);
      const key = filename.endsWith(".jsonl") ? filename.slice(0, -".jsonl".length) : "";
      const progress = key ? readProgress(key) : null;
      const hintedSource =
        meta.sourcePath ??
        (progress?.sessionID === meta.sessionID && progress.kind === "opencode-progress"
          ? progress.sourcePath
          : undefined);
      if (!hintedSource) return null;
      const sourcePath = realpathSync(hintedSource);
      if (!opencodeDbPaths().includes(sourcePath)) return null;
      const db = openRO(sourcePath);
      if (!db) return null;
      try {
        try {
          const row = db
            .query(
              "SELECT data FROM session_message WHERE session_id = ? AND type = 'compaction' ORDER BY seq DESC LIMIT 1",
            )
            .get(meta.sessionID) as any;
          if (row?.data) {
            const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
            const s = typeof data?.summary === "string" ? data.summary.trim() : "";
            if (s) return s.length > 4000 ? s.slice(0, 4000) : s;
          }
        } catch {
          /* session_message drift/absent — fall through to the v1 shape */
        }
        // v1: the compaction summary is the newest assistant row with data.summary === true; its
        // body is that row's text parts (the same shape MessageV2.filterCompacted keys on).
        const rows = db
          .query("SELECT id, data FROM message WHERE session_id = ? ORDER BY id DESC LIMIT 50")
          .all(meta.sessionID) as any[];
        for (const row of rows) {
          let data: any;
          try {
            data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
          } catch {
            continue;
          }
          if (data?.role !== "assistant" || data?.summary !== true) continue;
          const parts = db
            .query("SELECT id, data FROM part WHERE message_id = ? ORDER BY id ASC")
            .all(row.id) as any[];
          const texts: string[] = [];
          for (const p of parts) {
            let pd: any;
            try {
              pd = typeof p.data === "string" ? JSON.parse(p.data) : p.data;
            } catch {
              continue;
            }
            if (pd?.type === "text" && typeof pd.text === "string" && pd.text.trim()) texts.push(pd.text);
          }
          const s = texts.join(" ").trim();
          if (s) return s.length > 4000 ? s.slice(0, 4000) : s;
          break; // newest summary row had no text — nothing older is fresher
        }
      } catch {
        /* schema drift / not found */
      } finally {
        db.close();
      }
      return null;
    } catch {
      return null;
    }
  },

  // recap for cold-start: the harness-generated session title from the export meta line.
  recapFor(path: string): string | null {
    const meta = readMeta(path);
    const t = meta?.title?.replace(/\s+/g, " ").trim();
    return t ? (t.length > 72 ? `${t.slice(0, 71)}…` : t) : null;
  },
};
