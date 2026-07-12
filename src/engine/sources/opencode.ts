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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession, ParseOpts, TranscriptSource } from "../source.ts";
import { readTail, type Increment, type Turn } from "../extract.ts";
import { CLONE_ROOT } from "../paths.ts";

const HOME = homedir();

// ---- locations -----------------------------------------------------------------

// OpenCode data root is XDG-based; the DB may be channel-suffixed (opencode-<channel>.db)
// and $OPENCODE_DB overrides everything (database.ts:44-55). Lazy so tests can redirect.
export function opencodeDbPaths(): string[] {
  const override = process.env.OPENCODE_DB?.trim();
  if (override) return existsSync(override) ? [override] : [];
  const dataDir =
    process.env.XDG_DATA_HOME?.trim() || join(HOME, ".local", "share");
  const root = join(dataDir, "opencode");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // no OpenCode on this machine — normal
  }
  return entries
    .filter((f) => /^opencode(-[A-Za-z0-9_.-]+)?\.db$/.test(f))
    .map((f) => join(root, f));
}

// Export dir under the engine clone's .state (same home as capture.db). Tests redirect it.
let EXPORT_DIR = join(CLONE_ROOT, ".state", "opencode-export");
export function setExportDir(dir: string): void {
  EXPORT_DIR = dir;
}

// ---- neutral export format -------------------------------------------------------
// line 1: {"kind":"opencode-meta","sessionID":…,"directory":…,"title":…}
// lines:  {"role":"user"|"assistant","text":…,"ts":…}
interface ExportMeta {
  kind: "opencode-meta";
  sessionID: string;
  directory: string | null;
  title: string | null;
}

function metaPath(sessionID: string): string {
  return join(EXPORT_DIR, `${sessionID}.meta.json`);
}
function exportPath(sessionID: string): string {
  return join(EXPORT_DIR, `${sessionID}.jsonl`);
}

function lastSeq(sessionID: string): number {
  try {
    return JSON.parse(readFileSync(metaPath(sessionID), "utf-8")).lastSeq ?? -1;
  } catch {
    return -1;
  }
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

// Append new messages (seq > lastSeq) for one session; returns total exported line count.
function exportSession(db: Database, sessionID: string, directory: string | null, title: string | null): number {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const ep = exportPath(sessionID);
  const since = lastSeq(sessionID);
  let rows: any[];
  try {
    rows = db
      .query(
        "SELECT seq, type, data, time_created FROM session_message WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
      )
      .all(sessionID, since) as any[];
  } catch {
    return 0; // schema drift — degrade silently
  }
  if (!existsSync(ep)) {
    const meta: ExportMeta = { kind: "opencode-meta", sessionID, directory, title };
    writeFileSync(ep, JSON.stringify(meta) + "\n");
  }
  let maxSeq = since;
  let appended = "";
  for (const r of rows) {
    let data: any;
    try {
      data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    } catch {
      data = null;
    }
    const m = messageText(String(r.type ?? ""), data);
    if (m) {
      const ts = r.time_created ? new Date(Number(r.time_created)).toISOString().slice(0, 16) : "";
      appended += JSON.stringify({ role: m.role, text: m.text, ts }) + "\n";
    }
    if (typeof r.seq === "number" && r.seq > maxSeq) maxSeq = r.seq;
  }
  if (appended) appendFileSync(ep, appended);
  if (maxSeq > since) writeFileSync(metaPath(sessionID), JSON.stringify({ lastSeq: maxSeq }));
  try {
    return readFileSync(ep, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function openRO(path: string): Database | null {
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
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

  // Sweep = export new DB rows to append-only files, then report the files. Runs inside the
  // daemon's poll cycle; a machine without OpenCode pays one readdir and returns [].
  discover(): DiscoveredSession[] {
    const out: DiscoveredSession[] = [];
    for (const dbPath of opencodeDbPaths()) {
      const db = openRO(dbPath);
      if (!db) continue;
      try {
        let sessions: any[];
        try {
          sessions = db
            .query(
              "SELECT id, directory, title FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC",
            )
            .all() as any[];
        } catch {
          continue; // schema drift
        }
        for (const s of sessions) {
          const id = String(s.id ?? "");
          if (!id) continue;
          const lines = exportSession(db, id, s.directory ?? null, s.title ?? null);
          if (lines <= 1) continue; // meta-only export = no conversation yet
          out.push({ path: exportPath(id), sessionId: id, repo: s.directory ?? null, lines });
        }
      } finally {
        db.close();
      }
    }
    return out;
  },

  probe(path: string): DiscoveredSession | null {
    const p = path.replace(/\\/g, "/");
    if (!p.endsWith(".jsonl") || !p.startsWith(EXPORT_DIR.replace(/\\/g, "/") + "/")) return null;
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
      for (const dbPath of opencodeDbPaths()) {
        const db = openRO(dbPath);
        if (!db) continue;
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
          /* schema drift / not found — try next db */
        } finally {
          db.close();
        }
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
