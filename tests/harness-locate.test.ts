// Harness data-location discovery (locate/connect) — the 3-tier install contract:
// deterministic resolution → schema-signature verification → persisted LLM fallback.
// Pins the fail-closed boundary (an unverified path is never recorded), the precedence
// order (env > persisted > default), and that every capture source actually honors a
// persisted override — the whole point of `connect` is that the daemon sees it too.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setExportDir, opencodeDbPaths } from "../src/engine/sources/opencode.ts";
import { codexHome } from "../src/engine/sources/codex.ts";
import { claudeConfigDirs } from "../src/engine/sources/claude.ts";
import {
  connectHarnessPath,
  forgetHarnessPath,
  persistedOpencodeDb,
  verifyHarnessPath,
} from "../src/engine/harness-locate.ts";
import { OWNED_FILES } from "../src/engine/state-dir.ts";

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODE_DB", "CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

function makeOpencodeDb(path: string, opts: { legacy?: number; projected?: number } = {}): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run("ses_1", "/w", "t", 1, null);
  for (let i = 0; i < (opts.legacy ?? 0); i++)
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(`m${i}`, "ses_1", 1, 1, "{}");
  for (let i = 0; i < (opts.projected ?? 0); i++)
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(`sm${i}`, "ses_1", "x", i, "{}", 1);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-locate-"));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  setExportDir(join(dir, "state", "opencode-export")); // state root → <dir>/state
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("schema-signature verification (tier ②)", () => {
  test("opencode: a legacy-only DB verifies with row evidence", () => {
    const db = join(dir, "opencode.db");
    makeOpencodeDb(db, { legacy: 3 });
    const v = verifyHarnessPath("opencode", db);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("legacy message=3");
    expect(v.detail).toContain("session_message=0");
  });

  test("opencode: a non-database file and a missing path both fail", () => {
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a database at all");
    expect(verifyHarnessPath("opencode", junk).ok).toBe(false);
    expect(verifyHarnessPath("opencode", join(dir, "absent.db")).ok).toBe(false);
  });

  test("opencode: a SQLite file without the session table is refused", () => {
    const db = join(dir, "other.db");
    const raw = new Database(db);
    raw.exec("CREATE TABLE unrelated (id TEXT)");
    raw.close();
    const v = verifyHarnessPath("opencode", db);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("session");
  });

  test("codex: a home holding a rollout verifies; an unrelated dir is refused", () => {
    const home = join(dir, "codex-home");
    mkdirSync(join(home, "sessions", "2026", "07", "29"), { recursive: true });
    writeFileSync(join(home, "sessions", "2026", "07", "29", "rollout-x-abc.jsonl"), "{}\n");
    expect(verifyHarnessPath("codex", home).ok).toBe(true);
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(verifyHarnessPath("codex", empty).ok).toBe(false);
  });

  test("codex: a state_*.sqlite alone is evidence (compressed-rollout machines)", () => {
    const home = join(dir, "codex-state-only");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "state_5.sqlite"), "");
    expect(verifyHarnessPath("codex", home).ok).toBe(true);
  });

  test("claude: a config dir holding a transcript verifies; one without is refused", () => {
    const cfg = join(dir, ".claude-x");
    mkdirSync(join(cfg, "projects", "p"), { recursive: true });
    writeFileSync(join(cfg, "projects", "p", "a.jsonl"), "{}\n");
    const v = verifyHarnessPath("claude", cfg);
    expect(v.ok).toBe(true);
    expect(v.detail).toContain("1 transcript");
    const bare = join(dir, ".claude-bare");
    mkdirSync(bare);
    expect(verifyHarnessPath("claude", bare).ok).toBe(false);
  });

  // A folder NAME is not a signature. The first nonstandard-local E2E verified a plain home
  // directory as a Claude profile purely because it contained a `projects/` folder — the exact
  // "existence, not content" failure tier 2 exists to prevent. Both name-based checks now
  // require the data itself; the schema-based OpenCode check does not, because a SQL schema
  // identifies its owner on its own.
  test("claude: a folder that merely CONTAINS projects/ is not a Claude profile", () => {
    const home = join(dir, "someones-home");
    mkdirSync(join(home, "projects", "payments-api"), { recursive: true });
    writeFileSync(join(home, "projects", "payments-api", "README.md"), "# not a transcript\n");
    const v = verifyHarnessPath("claude", home);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("no *.jsonl transcript");
  });

  test("codex: a folder that merely CONTAINS an empty sessions/ is not a Codex home", () => {
    const decoy = join(dir, "decoy");
    mkdirSync(join(decoy, "sessions"), { recursive: true });
    const v = verifyHarnessPath("codex", decoy);
    expect(v.ok).toBe(false);
    expect(v.detail).toContain("no rollout-*.jsonl");
  });

  test("opencode: a well-formed but empty store still verifies (schema is its own evidence)", () => {
    const db = join(dir, "fresh.db");
    makeOpencodeDb(db); // schema only, zero conversation rows
    expect(verifyHarnessPath("opencode", db).ok).toBe(true);
  });

  test("opencode: the file NAME is never the signature", () => {
    const oddly = join(dir, "oc-store.sqlite"); // matches no opencode*.db convention
    makeOpencodeDb(oddly, { legacy: 2 });
    expect(verifyHarnessPath("opencode", oddly).ok).toBe(true);
  });
});

describe("connect (tier ③ persistence, fail-closed)", () => {
  test("a verified path is persisted; an unverified one is refused without writing", () => {
    const db = join(dir, "opencode.db");
    makeOpencodeDb(db, { legacy: 1 });
    const ok = connectHarnessPath("opencode", db);
    expect(ok.ok).toBe(true);
    expect(persistedOpencodeDb()).toBe(db);

    const junk = join(dir, "junk.db");
    writeFileSync(junk, "garbage");
    const refused = connectHarnessPath("opencode", junk);
    expect(refused.ok).toBe(false);
    expect(refused.saved).toBeUndefined();
    expect(persistedOpencodeDb()).toBe(db); // prior verified value untouched
  });

  test("forget removes the override; forgetting twice reports nothing to do", () => {
    const db = join(dir, "opencode.db");
    makeOpencodeDb(db, { legacy: 1 });
    const saved = connectHarnessPath("opencode", db).saved!;
    expect(forgetHarnessPath("opencode")).toBe(true);
    expect(persistedOpencodeDb()).toBeNull();
    // The last forget takes the file with it — an empty husk reads like a setting someone made.
    expect(existsSync(saved)).toBe(false);
    expect(forgetHarnessPath("opencode")).toBe(false);
  });

  test("forgetting one harness keeps the others", () => {
    const db = join(dir, "opencode.db");
    makeOpencodeDb(db, { legacy: 1 });
    const cfg = join(dir, "claude-cfg");
    mkdirSync(join(cfg, "projects", "p"), { recursive: true });
    writeFileSync(join(cfg, "projects", "p", "s.jsonl"), "{}\n");
    connectHarnessPath("opencode", db);
    const saved = connectHarnessPath("claude", cfg).saved!;
    forgetHarnessPath("opencode");
    expect(existsSync(saved)).toBe(true);
    expect(persistedOpencodeDb()).toBeNull();
    expect(JSON.parse(readFileSync(saved, "utf-8")).claudeConfigDirs).toEqual([cfg]);
  });

  test("the persisted file is machine-local state, not repo content", () => {
    const db = join(dir, "opencode.db");
    makeOpencodeDb(db, { legacy: 1 });
    const r = connectHarnessPath("opencode", db);
    expect(r.saved).toBe(join(dir, "state", "harness-paths.json"));
    expect(existsSync(r.saved!)).toBe(true);
    expect(JSON.parse(readFileSync(r.saved!, "utf-8")).version).toBe(1);
  });

  // The state root's allowlist is both "what purge deletes" and "what adoption accepts". The
  // first E2E on a nonstandard local caught this file in neither: `--uninstall --purge-data`
  // left it behind, and the canonical default root would have counted it foreign — the same
  // shape that once turned every sweep into enqueued=0 while doctor stayed green.
  test("the persisted file is on the state root's owned-file allowlist", () => {
    expect(OWNED_FILES as readonly string[]).toContain("harness-paths.json");
  });
});

describe("sources honor the persisted override (env still wins)", () => {
  test("opencodeDbPaths: persisted DB is used; $OPENCODE_DB overrides it", () => {
    const persisted = join(dir, "persisted.db");
    makeOpencodeDb(persisted, { legacy: 1 });
    connectHarnessPath("opencode", persisted);
    // opencodeDbPaths realpaths its result (macOS /var → /private/var), so compare realpaths.
    expect(opencodeDbPaths()).toEqual([realpathSync(persisted)]);

    const envDb = join(dir, "env.db");
    makeOpencodeDb(envDb, { legacy: 1 });
    process.env.OPENCODE_DB = envDb;
    expect(opencodeDbPaths()).toEqual([realpathSync(envDb)]);
  });

  test("codexHome: persisted home is used; $CODEX_HOME overrides it", () => {
    const persisted = join(dir, "codex-home");
    mkdirSync(join(persisted, "sessions"), { recursive: true });
    writeFileSync(join(persisted, "sessions", "rollout-x-abc.jsonl"), "{}\n");
    connectHarnessPath("codex", persisted);
    expect(codexHome()).toBe(persisted);
    process.env.CODEX_HOME = join(dir, "env-codex");
    expect(codexHome()).toBe(join(dir, "env-codex"));
  });

  test("claudeConfigDirs: a persisted nonstandard dir joins the scan", () => {
    const cfg = join(dir, "weird-claude-location");
    mkdirSync(join(cfg, "projects", "p"), { recursive: true });
    writeFileSync(join(cfg, "projects", "p", "s.jsonl"), "{}\n");
    connectHarnessPath("claude", cfg);
    expect(claudeConfigDirs()).toContain(cfg);
  });
});
