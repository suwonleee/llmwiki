import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportHermesSession, hermesDbPath, hermesSessions } from "../src/engine/hermes-export.ts";

// The schema is transcribed from Hermes itself (hermes_state_common.py:195 `sessions`, :253
// `messages`) rather than invented — only the columns this exporter reads are kept, because a
// fixture that drifts from the real table teaches nothing. There is no Hermes installation here,
// so this is the strongest available evidence: correct against the published schema.
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT,
  started_at REAL NOT NULL,
  message_count INTEGER DEFAULT 0,
  cwd TEXT,
  git_branch TEXT,
  git_repo_root TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  compacted INTEGER NOT NULL DEFAULT 0
);
`;

let home: string;
let repo: string;
let savedHome: string | undefined;

function seed(rows: (db: Database) => void): void {
  const db = new Database(join(home, "state.db"));
  db.exec(SCHEMA);
  rows(db);
  db.close();
}

function addSession(db: Database, id: string, root: string | null, cwd: string | null, at: number): void {
  db.query("INSERT INTO sessions (id, source, title, started_at, message_count, cwd, git_repo_root) VALUES (?,?,?,?,?,?,?)")
    .run(id, "cli", `session ${id}`, at, 2, cwd, root);
}

function addMessage(
  db: Database,
  session: string,
  role: string,
  content: string,
  opts: { active?: number; compacted?: number } = {},
): void {
  db.query("INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?,?,?,?,?,?)").run(
    session,
    role,
    content,
    1_760_000_000,
    opts.active ?? 1,
    opts.compacted ?? 0,
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hermes-home-"));
  repo = mkdtempSync(join(tmpdir(), "hermes-repo-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  savedHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("hermes export", () => {
  test("a machine without Hermes is silent, not an error", () => {
    delete process.env.HERMES_HOME; // resolves to ~/.hermes, which the test machine may not have
    process.env.HERMES_HOME = join(home, "absent");
    expect(hermesDbPath()).toBeNull();
    expect(hermesSessions()).toEqual([]);
    expect(exportHermesSession("whatever", join(home, "out.md"))).toBeNull();
  });

  test("routes sessions by git_repo_root, newest first, and skips unrouted ones", () => {
    seed((db) => {
      addSession(db, "old", repo, repo, 1_000);
      addSession(db, "new", repo, repo, 2_000);
      addSession(db, "nowhere", null, null, 3_000); // no repo → cannot be filed anywhere
    });
    const all = hermesSessions();
    expect(all.map((s) => s.id)).toEqual(["new", "old"]);
    expect(hermesSessions(repo).map((s) => s.id)).toEqual(["new", "old"]);
    expect(hermesSessions(join(home, "other")).length).toBe(0);
  });

  test("falls back to cwd when git_repo_root was never populated", () => {
    seed((db) => addSession(db, "s1", null, repo, 1_000));
    expect(hermesSessions(repo).map((s) => s.id)).toEqual(["s1"]);
  });

  test("exports conversation turns in order and leaves out what is not conversation", () => {
    seed((db) => {
      addSession(db, "s1", repo, repo, 1_000);
      addMessage(db, "s1", "user", "why did we pick the union merge?");
      addMessage(db, "s1", "tool", "git log output nobody needs in a wiki page");
      addMessage(db, "s1", "assistant", "because log.md is append-only and a conflict there is never a real one");
      addMessage(db, "s1", "user", "rewound question", { active: 0 });
      addMessage(db, "s1", "assistant", "already folded into a compaction summary", { compacted: 1 });
    });
    const out = join(home, "s1.md");
    const result = exportHermesSession("s1", out)!;
    expect(result.turns).toBe(2);
    expect(result.repo).toBe(hermesSessions()[0]!.repo!);

    const text = readFileSync(out, "utf-8");
    expect(text).toContain("why did we pick the union merge?");
    expect(text).toContain("log.md is append-only");
    expect(text).not.toContain("git log output"); // tool rows are not dialogue
    expect(text).not.toContain("rewound question"); // active = 0
    expect(text).not.toContain("already folded"); // compacted = 1
    expect(text.indexOf("union merge")).toBeLessThan(text.indexOf("append-only")); // id order preserved
  });

  test("credential-shaped material never reaches the exported file", () => {
    const credential = `AKIA${"A".repeat(16)}`;
    seed((db) => {
      addSession(db, "s1", repo, repo, 1_000);
      addMessage(db, "s1", "user", `keep the decision but not ${credential}`);
      addMessage(db, "s1", "assistant", credential.repeat(12)); // nothing but a secret
    });
    const out = join(home, "s1.md");
    const result = exportHermesSession("s1", out)!;
    const text = readFileSync(out, "utf-8");
    expect(text).not.toContain(credential);
    expect(text).toContain("keep the decision"); // the surrounding evidence survives redaction
    expect(result.turns).toBe(1); // the secret-only turn has no evidence left, so it is dropped
    expect(result.redacted).toBe(true);
  });

  test("a session with no exportable turns produces no file", () => {
    seed((db) => {
      addSession(db, "s1", repo, repo, 1_000);
      addMessage(db, "s1", "tool", "only tool traffic");
    });
    expect(exportHermesSession("s1", join(home, "s1.md"))).toBeNull();
  });

  test("schema drift degrades to no sessions instead of throwing into the caller", () => {
    const db = new Database(join(home, "state.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)"); // a future Hermes without our columns
    db.close();
    expect(hermesSessions()).toEqual([]);
  });

  test("reads Hermes' database without modifying it", () => {
    seed((db) => {
      addSession(db, "s1", repo, repo, 1_000);
      addMessage(db, "s1", "user", "a question long enough to be worth filing into the wiki");
    });
    const dbFile = join(home, "state.db");
    const before = readFileSync(dbFile);
    exportHermesSession("s1", join(home, "s1.md"));
    expect(readFileSync(dbFile).equals(before)).toBe(true);
  });

  test("the exported transcript is private on disk", () => {
    seed((db) => {
      addSession(db, "s1", repo, repo, 1_000);
      addMessage(db, "s1", "user", "verbatim conversation text belongs to the user, not the filesystem");
    });
    const out = join(home, "s1.md");
    exportHermesSession("s1", out);
    expect(statSync(out).mode & 0o077).toBe(0); // no group/other access
  });
});

// The exporter must not be reachable from the daemon: registering it would change what every
// sweep touches on machines that have nothing to do with Hermes.
describe("hermes stays out of the capture registry", () => {
  test("no transcript source claims the hermes kind", async () => {
    const { sources } = await import("../src/engine/source.ts");
    expect(sources().map((s) => s.kind)).not.toContain("hermes");
  });

  test("the export directory machinery is untouched", async () => {
    const { EXPORT_DIR_NAME } = await import("../src/engine/state-dir.ts");
    expect(EXPORT_DIR_NAME).toBe("opencode-export"); // one export dir, one ownership rule
  });
});
