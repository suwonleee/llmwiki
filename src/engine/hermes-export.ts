// Hermes session export (kind stays "plain" downstream) — the write loop for a harness the
// capture daemon does not watch.
//
// WHY NOT A TranscriptSource. Every registered source materializes into the state root's export
// directory, and that directory is load-bearing security machinery: ownership detection
// (`unownedEntries`), permission re-assertion, and TTL cleanup all key on the single
// `EXPORT_DIR_NAME` constant. Adding a second export directory means editing those three code
// paths, which guard the user's existing local state on every sweep. Hermes does not earn that
// risk yet: it is a personal-assistant runtime where repo-scoped coding sessions are the
// secondary use case, and there is no live installation here to verify an adapter against.
//
// So this is a plain EXPORTER, not a source: it reads Hermes' SQLite read-only, writes one
// Markdown transcript, and hands off to the existing `llmwiki ingest` drop-a-source path. Nothing
// registers, nothing is auto-discovered, nothing in the daemon sweep changes — a machine without
// Hermes cannot behave differently because this file exists.
//
// Promote it to a real source when Hermes proves worth it; the schema read here is the hard part
// and carries over.
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalWorktree } from "./enrollment.ts";
import { envValueOutsideRepoFiles } from "./env-policy.ts";
import { openReadonlyDatabase } from "./sqlite-open.ts";
import { screenSecrets } from "./screen.ts";

/**
 * Where Hermes keeps its state database.
 *
 * `hermes_state.py:250` — `get_hermes_home() / "state.db"`, and HERMES_HOME is the documented
 * override. The env read goes through `envValueOutsideRepoFiles` for the same reason every other
 * env read in this engine does: Bun autoloads the cwd's `.env`, the cwd is the user's repository,
 * and a tracked file must not be able to redirect which database the engine reads.
 */
export function hermesDbPath(): string | null {
  const home = envValueOutsideRepoFiles("HERMES_HOME")?.trim() || join(homedir(), ".hermes");
  const db = join(home, "state.db");
  return existsSync(db) ? db : null;
}

export interface HermesSession {
  id: string;
  repo: string | null;
  title: string | null;
  startedAt: number | null;
  messages: number;
}

interface HermesMessage {
  role: string;
  content: string;
  timestamp: number | null;
}

/**
 * Sessions that ran inside a repository, newest first.
 *
 * `git_repo_root` is Hermes' own answer and is preferred; `cwd` is the fallback for a session
 * recorded before that column was populated. A session with neither is skipped rather than
 * guessed at — an unrouted session has no wiki to be filed into.
 */
export function hermesSessions(repo?: string): HermesSession[] {
  const dbPath = hermesDbPath();
  if (!dbPath) return [];
  const db = openReadonlyDatabase(dbPath);
  if (!db) return [];
  try {
    let rows: any[];
    try {
      rows = db
        .query(
          "SELECT id, cwd, git_repo_root, title, started_at, message_count FROM sessions ORDER BY started_at DESC",
        )
        .all() as any[];
    } catch {
      return []; // schema drift — degrade to "no sessions", never throw into a caller's command
    }
    // "No repo asked for" and "a repo was asked for but does not canonicalize" are different
    // answers. Collapsing them into one nullable made a non-repository argument skip the filter
    // entirely and return every session on the machine — the caller asked to narrow and silently
    // got the opposite.
    let want: string | null = null;
    if (repo) {
      want = canonicalWorktree(repo);
      if (!want) return [];
    }
    const out: HermesSession[] = [];
    for (const r of rows) {
      const id = String(r.id ?? "");
      if (!id) continue;
      const raw = typeof r.git_repo_root === "string" && r.git_repo_root ? r.git_repo_root : r.cwd;
      const rootPath = typeof raw === "string" && raw ? canonicalWorktree(raw) : null;
      if (!rootPath) continue;
      if (want && rootPath !== want) continue;
      out.push({
        id,
        repo: rootPath,
        title: typeof r.title === "string" ? r.title : null,
        startedAt: typeof r.started_at === "number" ? r.started_at : null,
        messages: typeof r.message_count === "number" ? r.message_count : 0,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Conversation turns of one session, in order.
 *
 * `active = 1` excludes rewound/superseded rows, and `compacted = 1` rows are dropped because
 * their content has already been folded into a compaction summary — exporting both would file the
 * same material twice. Tool rows are not conversation and are left out entirely.
 */
function hermesMessages(db: Database, sessionId: string): HermesMessage[] {
  let rows: any[];
  try {
    rows = db
      .query(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? AND active = 1 AND compacted = 0 " +
          "AND role IN ('user', 'assistant') AND content IS NOT NULL AND content <> '' ORDER BY id ASC",
      )
      .all(sessionId) as any[];
  } catch {
    return [];
  }
  return rows.map((r) => ({
    role: String(r.role ?? ""),
    content: String(r.content ?? ""),
    timestamp: typeof r.timestamp === "number" ? r.timestamp : null,
  }));
}

function stamp(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  try {
    return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "";
  }
}

export interface HermesExport {
  path: string;
  sessionId: string;
  repo: string;
  turns: number;
  redacted: boolean;
}

/**
 * Write one Hermes session to `out` as a Markdown transcript.
 *
 * Credential-shaped material is screened on the way out, for the same reason `update-next`
 * screens it: this file leaves the harness's own store and becomes an input a model reads. A
 * turn that is nothing but a secret is dropped, since redaction leaves no evidence behind.
 */
export function exportHermesSession(sessionId: string, out: string): HermesExport | null {
  const dbPath = hermesDbPath();
  if (!dbPath) return null;
  const session = hermesSessions().find((s) => s.id === sessionId);
  if (!session?.repo) return null;
  const db = openReadonlyDatabase(dbPath);
  if (!db) return null;
  let messages: HermesMessage[];
  try {
    messages = hermesMessages(db, sessionId);
  } finally {
    db.close();
  }
  if (!messages.length) return null;

  let redacted = false;
  const blocks: string[] = [];
  for (const m of messages) {
    const screened = screenSecrets(m.content);
    if (screened.gutted) {
      redacted = true;
      continue;
    }
    if (screened.text !== m.content) redacted = true;
    const who = m.role === "user" ? "user" : "assistant";
    const ts = stamp(m.timestamp);
    blocks.push(`### ${who}${ts ? ` · ${ts}` : ""}\n\n${screened.text.trim()}`);
  }
  if (!blocks.length) return null;

  // `null` marks an absent optional line; "" is a deliberate blank separator. Filtering on
  // emptiness would collapse both and glue the blockquote onto the bullet list.
  const header = [
    `# Hermes session ${sessionId}`,
    "",
    `- repo: ${session.repo}`,
    session.title ? `- title: ${session.title}` : null,
    session.startedAt ? `- started: ${stamp(session.startedAt)}` : null,
    `- turns: ${blocks.length}`,
    "",
    "> Exported from Hermes' own store (`state.db`) by `llmwiki hermes-export`. Read-only export;",
    "> Hermes' database is never modified.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  writeFileSync(out, `${header}\n\n${blocks.join("\n\n")}\n`, { mode: 0o600 });
  return { path: out, sessionId, repo: session.repo, turns: blocks.length, redacted };
}
