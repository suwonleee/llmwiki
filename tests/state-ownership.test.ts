// The runtime state directory holds the most sensitive thing llmwiki keeps: which repositories
// you work in, when, and — for OpenCode — the conversation text itself. Two properties are under
// test here. It is PRIVATE by construction (0700/0600, not "whatever the umask was), and llmwiki
// only ever adopts, chmods, or deletes a directory it can prove it created.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as capture from "../src/engine/capture.ts";
import {
  EXPORT_TTL_DAYS,
  STATE_MARKER,
  StateRootError,
  bootstrapStateRoot,
  ensureOwnedStateRoot,
  expiredExportPairs,
  isOwnedStateDir,
  purgeOwnedState,
  stateMarkerBytes,
} from "../src/engine/state-dir.ts";

const dirs: string[] = [];
const POSIX = process.platform !== "win32";
const DAY = 86_400_000;

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-state-"));
  dirs.push(d);
  return d;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function modernExportPair(
  root: string,
  key = "a".repeat(64),
  ageDays = 0,
): { jsonl: string; meta: string } {
  const dir = join(root, "opencode-export");
  mkdirSync(dir, { recursive: true });
  const jsonl = join(dir, `${key}.jsonl`);
  const meta = join(dir, `${key}.meta.json`);
  const sourcePath = "/machine/opencode.db";
  writeFileSync(
    jsonl,
    JSON.stringify({
      kind: "opencode-meta",
      sessionID: "ses-modern",
      directory: "/repo",
      title: null,
      sourcePath,
      exportKey: key,
    }) + "\n" + JSON.stringify({ role: "user", text: "private transcript body", ts: "" }) + "\n",
  );
  writeFileSync(
    meta,
    JSON.stringify({
      kind: "opencode-progress",
      exportKey: key,
      sessionID: "ses-modern",
      sourcePath,
      lastSeq: 1,
    }),
  );
  const when = new Date(Date.now() - ageDays * DAY);
  for (const path of [jsonl, meta]) utimesSync(path, when, when);
  return { jsonl, meta };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("state root ownership", () => {
  test("a fresh root is created private and marked", () => {
    const root = join(scratch(), "state");
    const resolved = ensureOwnedStateRoot(root);
    expect(isOwnedStateDir(resolved)).toBe(true);
    expect(readFileSync(join(resolved, STATE_MARKER), "utf-8")).toBe(stateMarkerBytes(resolved));
    if (POSIX) {
      expect(mode(resolved)).toBe(0o700);
      expect(mode(join(resolved, STATE_MARKER))).toBe(0o600);
    }
  });

  test("an existing but EMPTY directory is adopted (nothing there to be wrong about)", () => {
    const root = join(scratch(), "empty");
    mkdirSync(root, { recursive: true, mode: 0o755 });
    ensureOwnedStateRoot(root);
    expect(isOwnedStateDir(root)).toBe(true);
    if (POSIX) expect(mode(root)).toBe(0o700);
  });

  test("a valid marker with loosened permissions is repaired before the root is used", () => {
    if (!POSIX) return;
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    chmodSync(join(root, STATE_MARKER), 0o644);

    expect(isOwnedStateDir(root)).toBe(false);
    expect(ensureOwnedStateRoot(root)).toBe(realpathSync(root));
    expect(isOwnedStateDir(root)).toBe(true);
    expect(mode(join(root, STATE_MARKER))).toBe(0o600);
  });

  test("every owned state and transcript path is re-verified at its exact private mode", () => {
    if (!POSIX) return;
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    const pair = modernExportPair(root);
    const exportDir = join(root, "opencode-export");
    for (const path of [root, exportDir]) chmodSync(path, 0o777);
    for (const path of [join(root, STATE_MARKER), pair.jsonl, pair.meta]) chmodSync(path, 0o666);

    expect(ensureOwnedStateRoot(root)).toBe(realpathSync(root));
    expect(mode(root)).toBe(0o700);
    expect(mode(exportDir)).toBe(0o700);
    expect(mode(join(root, STATE_MARKER))).toBe(0o600);
    expect(mode(pair.jsonl)).toBe(0o600);
    expect(mode(pair.meta)).toBe(0o600);
  });

  test("a repository .env cannot redirect machine-local state", () => {
    const repo = scratch();
    const poison = join(repo, "repo-chosen-state");
    writeFileSync(join(repo, ".env"), `LLMWIKI_STATE_DIR=${poison}\n`);
    const env = { ...process.env };
    delete env.LLMWIKI_STATE_DIR;

    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "purge-state", "--report"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
    );
    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

    expect(result.exitCode).toBe(0);
    expect(output).not.toContain(poison);
    expect(existsSync(poison)).toBe(false);
  });

  test("a symlinked repository .env cannot redirect machine-local state", () => {
    const repo = scratch();
    const poison = join(repo, "repo-chosen-state");
    writeFileSync(join(repo, "payload.env"), `LLMWIKI_STATE_DIR=${poison}\n`);
    symlinkSync("payload.env", join(repo, ".env"));
    const env = { ...process.env };
    delete env.LLMWIKI_STATE_DIR;

    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "purge-state", "--report"],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
    );
    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

    expect(result.exitCode).toBe(0);
    expect(output).not.toContain(poison);
    expect(existsSync(poison)).toBe(false);
  });

  test("reporting an absent state root does not initialize it", () => {
    const repo = scratch();
    const state = join(repo, "fresh-state");
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "purge-state", "--report"],
      {
        cwd: repo,
        env: { ...process.env, LLMWIKI_STATE_DIR: state },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(state)).toBe(false);
  });

  test("a NON-EMPTY directory llmwiki did not create is refused, not taken over", () => {
    const root = join(scratch(), "someone-elses");
    mkdirSync(root, { recursive: true, mode: 0o755 });
    const stranger = join(root, "important.txt");
    writeFileSync(stranger, "NOT-OURS\n", { mode: 0o644 });

    expect(() => ensureOwnedStateRoot(root)).toThrow(StateRootError);

    // untouched: still there, still readable, still with its own permissions
    expect(readFileSync(stranger, "utf-8")).toBe("NOT-OURS\n");
    expect(existsSync(join(root, STATE_MARKER))).toBe(false);
    if (POSIX) {
      expect(mode(root)).toBe(0o755); // NOT recursively chmodded
      expect(mode(stranger)).toBe(0o644);
    }
  });

  test("a state path that is a symlink or a file is refused", () => {
    const base = scratch();
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link);
    expect(() => ensureOwnedStateRoot(link)).toThrow(StateRootError);

    const file = join(base, "afile");
    writeFileSync(file, "x");
    expect(() => ensureOwnedStateRoot(file)).toThrow(StateRootError);
  });

  test("the legacy default root is adopted only when every entry validates as ours", () => {
    const base = scratch();
    const legacy = join(base, ".state");
    mkdirSync(join(legacy, "opencode-export"), { recursive: true });
    const db = new Database(join(legacy, "capture.db"));
    db.exec(
      "CREATE TABLE capture_queue (transcript_path TEXT PRIMARY KEY, session_id TEXT, repo TEXT, " +
        "byte_offset INTEGER DEFAULT 0, lines INTEGER DEFAULT 0, status TEXT DEFAULT 'pending')",
    );
    db.close();
    writeFileSync(join(legacy, "daemon.log"), "2026-07-26 INFO llmwiki-daemon: started\n");
    writeFileSync(
      join(legacy, "opencode-export", "ses_1.jsonl"),
      JSON.stringify({ kind: "opencode-meta", sessionID: "ses_1", directory: "/repo", title: null }) + "\n",
    );
    writeFileSync(join(legacy, "opencode-export", "ses_1.meta.json"), JSON.stringify({ lastSeq: 3 }));

    ensureOwnedStateRoot(legacy, { defaultRoot: legacy });
    expect(isOwnedStateDir(legacy)).toBe(true);
    if (POSIX) {
      expect(mode(legacy)).toBe(0o700);
      expect(mode(join(legacy, "capture.db"))).toBe(0o600);
      expect(mode(join(legacy, "daemon.log"))).toBe(0o600);
      expect(mode(join(legacy, "opencode-export"))).toBe(0o700);
      expect(mode(join(legacy, "opencode-export", "ses_1.jsonl"))).toBe(0o600);
    }
  });

  // Upgrade path. `.state` accumulates logs across engine versions — autodistill runs, dry-run
  // scans — and an allowlist of only today's four filenames refuses the directory llmwiki itself
  // filled. Measured on a real install: capture went to `enqueued=0, failed=76` every sweep while
  // doctor reported healthy, because three of these files were present.
  test("a log an older llmwiki wrote does not block adoption, and is made private", () => {
    const base = scratch();
    const legacy = join(base, ".state");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "daemon.log"), "log\n");
    writeFileSync(join(legacy, "autodistill.log"), "2026-06-11 INFO run\n", { mode: 0o644 });
    writeFileSync(join(legacy, "dryrun-scan-20260608.log"), "scan\n", { mode: 0o644 });

    ensureOwnedStateRoot(legacy, { defaultRoot: legacy });

    expect(isOwnedStateDir(legacy)).toBe(true);
    // Recognized for adoption, but NOT added to the deletion allowlist: purge still only removes
    // what this version writes.
    expect(existsSync(join(legacy, "autodistill.log"))).toBe(true);
    if (POSIX) {
      expect(mode(join(legacy, "autodistill.log"))).toBe(0o600);
      expect(mode(join(legacy, "dryrun-scan-20260608.log"))).toBe(0o600);
    }
  });

  test("a refusal names the entries that blocked it", () => {
    const legacy = join(scratch(), ".state");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "daemon.log"), "log\n");
    writeFileSync(join(legacy, "notes.txt"), "someone else's file\n");

    // "files this engine did not create" told an upgrading user nothing they could act on.
    expect(() => ensureOwnedStateRoot(legacy, { defaultRoot: legacy })).toThrow(/notes\.txt/);
  });

  test("a legacy default root holding anything unexpected is NOT adopted", () => {
    for (const plant of [
      (root: string) => writeFileSync(join(root, "notes.txt"), "someone else's file\n"),
      (root: string) => mkdirSync(join(root, "unexpected-dir")),
      (root: string) => writeFileSync(join(root, "capture.db"), "not a sqlite database at all"),
    ]) {
      const legacy = join(scratch(), ".state");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "daemon.log"), "log\n");
      plant(legacy);
      expect(() => ensureOwnedStateRoot(legacy, { defaultRoot: legacy })).toThrow(StateRootError);
      expect(existsSync(join(legacy, STATE_MARKER))).toBe(false);
    }
  });

  test("a symlinked opencode-export blocks legacy adoption", () => {
    const base = scratch();
    const legacy = join(base, ".state");
    mkdirSync(legacy, { recursive: true });
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(legacy, "opencode-export"));
    expect(() => ensureOwnedStateRoot(legacy, { defaultRoot: legacy })).toThrow(StateRootError);
  });

  test("capture's own database and its WAL siblings end up private", () => {
    const root = join(scratch(), "state");
    capture.setStateDir(root);
    capture.enqueue(join(scratch(), "t.jsonl"), "s1", "/repo/x", 10);
    if (POSIX) {
      expect(mode(root)).toBe(0o700);
      expect(mode(join(root, "capture.db"))).toBe(0o600);
      for (const sibling of ["capture.db-wal", "capture.db-shm"]) {
        if (existsSync(join(root, sibling))) expect(mode(join(root, sibling))).toBe(0o600);
      }
    }
  });

  test("daemon bootstrap creates the log privately and refuses a foreign root", () => {
    const root = join(scratch(), "state");
    bootstrapStateRoot(root);
    expect(readFileSync(join(root, "daemon.log"), "utf-8")).toBe("");
    if (POSIX) {
      expect(mode(root)).toBe(0o700);
      expect(mode(join(root, "daemon.log"))).toBe(0o600);
    }

    const foreign = join(scratch(), "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "important.txt"), "keep");
    expect(() => bootstrapStateRoot(foreign)).toThrow(StateRootError);
    expect(existsSync(join(foreign, "daemon.log"))).toBe(false);
  });
});

describe("owned-state purge", () => {
  function ownedRootWithContent(): string {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    writeFileSync(join(root, "capture.db"), "db");
    writeFileSync(join(root, "daemon.log"), "log");
    mkdirSync(join(root, "opencode-export"));
    writeFileSync(
      join(root, "opencode-export", "ses_1.jsonl"),
      JSON.stringify({
        kind: "opencode-meta",
        sessionID: "ses_1",
        directory: "/repo/legacy",
        title: null,
      }) + "\n",
    );
    writeFileSync(join(root, "opencode-export", "ses_1.meta.json"), JSON.stringify({ lastSeq: 1 }));
    return root;
  }

  test("removes exactly the owned artifacts and then the empty root", () => {
    const root = ownedRootWithContent();
    const result = purgeOwnedState(root);
    expect(result.error).toBeUndefined();
    expect(result.removed).toContain("capture.db");
    expect(result.removed).toContain("daemon.log");
    expect(result.removed).toContain(STATE_MARKER);
    expect(result.rootRemoved).toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  test("an unrelated file inside an owned root survives, and so does the root", () => {
    const root = ownedRootWithContent();
    writeFileSync(join(root, "unrelated.txt"), "KEEP ME\n");

    const result = purgeOwnedState(root);

    expect(result.rootRemoved).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(root, "unrelated.txt"), "utf-8")).toBe("KEEP ME\n");
    expect(result.retained).toContain("unrelated.txt");
    expect(existsSync(join(root, "capture.db"))).toBe(false); // ours still went
  });

  test("purging a root llmwiki does not own removes nothing", () => {
    const root = join(scratch(), "not-ours");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "capture.db"), "looks like ours, is not");

    const result = purgeOwnedState(root);

    expect(result.error).toContain("does not own");
    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, "capture.db"))).toBe(true);
  });

  test("purge never follows a symlink out of the export directory", () => {
    const base = scratch();
    const victim = join(base, "victim.jsonl");
    writeFileSync(victim, "PRIVATE\n");
    const root = ownedRootWithContent();
    symlinkSync(victim, join(root, "opencode-export", "linked.jsonl"));

    purgeOwnedState(root);

    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe("PRIVATE\n");
  });

  test("purge preserves matching filenames that are not a valid header/meta pair", () => {
    const root = ownedRootWithContent();
    const exportDir = join(root, "opencode-export");
    writeFileSync(join(exportDir, "notes.jsonl"), "someone else's notes\n");
    writeFileSync(join(exportDir, "notes.meta.json"), JSON.stringify({ lastSeq: 3 }));

    const result = purgeOwnedState(root);

    expect(readFileSync(join(exportDir, "notes.jsonl"), "utf-8")).toBe("someone else's notes\n");
    expect(existsSync(join(exportDir, "notes.meta.json"))).toBe(true);
    expect(result.retained).toContain("opencode-export/notes.jsonl");
  });

  test("purge removes a self-authenticating modern orphan but preserves a lookalike", () => {
    const root = ownedRootWithContent();
    const { jsonl, meta } = modernExportPair(root);
    unlinkSync(meta);
    const fake = join(root, "opencode-export", `${"b".repeat(64)}.jsonl`);
    writeFileSync(fake, JSON.stringify({ kind: "opencode-meta", sessionID: "not-bound" }) + "\n");

    const result = purgeOwnedState(root);

    expect(existsSync(jsonl)).toBe(false);
    expect(existsSync(fake)).toBe(true);
    expect(result.retained).toContain(`opencode-export/${"b".repeat(64)}.jsonl`);
  });

  test("purge removes a strict v0.8 export orphan but preserves a malformed lookalike", () => {
    const root = ownedRootWithContent();
    const exportDir = join(root, "opencode-export");
    const legacy = join(exportDir, "legacy-session.jsonl");
    writeFileSync(
      legacy,
      JSON.stringify({
        kind: "opencode-meta",
        sessionID: "legacy-session",
        directory: "/repo/legacy",
        title: null,
      }) + "\n",
    );
    const fake = join(exportDir, "fake-session.jsonl");
    writeFileSync(fake, JSON.stringify({ kind: "opencode-meta", sessionID: "fake-session" }) + "\n");

    const result = purgeOwnedState(root);

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(fake)).toBe(true);
    expect(result.retained).toContain("opencode-export/fake-session.jsonl");
  });
});

describe("transcript export retention", () => {
  function exportPair(root: string, id: string, ageDays: number): { jsonl: string; meta: string } {
    const dir = join(root, "opencode-export");
    mkdirSync(dir, { recursive: true });
    const jsonl = join(dir, `${id}.jsonl`);
    const meta = join(dir, `${id}.meta.json`);
    writeFileSync(
      jsonl,
      JSON.stringify({ kind: "opencode-meta", sessionID: id, directory: "/repo/legacy", title: null }) + "\n",
    );
    writeFileSync(meta, JSON.stringify({ lastSeq: 1 }));
    const when = new Date(Date.now() - ageDays * DAY);
    for (const p of [jsonl, meta]) utimesSync(p, when, when);
    return { jsonl, meta };
  }

  test("a pair past the TTL expires; a fresh one does not", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    exportPair(root, "old", EXPORT_TTL_DAYS + 1);
    exportPair(root, "fresh", 1);

    const expired = expiredExportPairs(root);
    expect(expired.map((e) => e.sessionId)).toEqual(["old"]);
  });

  test("age is the NEWEST member of the pair — an old meta beside a live export is not expired", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    const { meta } = exportPair(root, "mixed", 0);
    const ancient = new Date(Date.now() - (EXPORT_TTL_DAYS + 10) * DAY);
    utimesSync(meta, ancient, ancient);

    expect(expiredExportPairs(root)).toEqual([]);
  });

  test("an old modern orphan expires by its remaining member; a fresh one does not", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    const old = modernExportPair(root, "a".repeat(64), EXPORT_TTL_DAYS + 2);
    unlinkSync(old.meta);
    const fresh = modernExportPair(root, "b".repeat(64), 1);
    unlinkSync(fresh.meta);

    const expired = expiredExportPairs(root);

    expect(expired).toHaveLength(1);
    expect(expired[0]!.exportPath).toBe(realpathSync(old.jsonl));
    expect(expired[0]!.metaPath).toBeNull();
  });

  test("an old modern progress orphan expires without pretending an export exists", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    const old = modernExportPair(root, "c".repeat(64), EXPORT_TTL_DAYS + 2);
    unlinkSync(old.jsonl);

    const expired = expiredExportPairs(root);

    expect(expired).toHaveLength(1);
    expect(expired[0]!.exportPath).toBeNull();
    expect(expired[0]!.metaPath).toBe(realpathSync(old.meta));
  });

  test("an old strict v0.8 export orphan expires with its pending row; a fresh one remains", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    capture.setStateDir(root);
    const exportDir = join(root, "opencode-export");
    mkdirSync(exportDir, { recursive: true });
    const writeLegacy = (id: string, ageDays: number) => {
      const path = join(exportDir, `${id}.jsonl`);
      writeFileSync(
        path,
        JSON.stringify({ kind: "opencode-meta", sessionID: id, directory: "/repo/legacy", title: null }) + "\n",
      );
      const when = new Date(Date.now() - ageDays * DAY);
      utimesSync(path, when, when);
      return path;
    };
    const old = writeLegacy("legacy-old", EXPORT_TTL_DAYS + 2);
    const fresh = writeLegacy("legacy-fresh", 1);
    capture.enqueue(old, "legacy-old", "/repo/legacy", 80, "opencode");

    const result = capture.pruneExports();

    expect(result.pairs).toBe(1);
    expect(result.rows).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("expiry deletes both members and the pending row that pointed at them", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    capture.setStateDir(root);
    const unrelated = join(scratch(), "unrelated.jsonl");
    writeFileSync(unrelated, "{}\n"); // a live transcript, so the row stays pending
    capture.enqueue(unrelated, "keep", "/repo/keep", 60);
    const { jsonl, meta } = exportPair(root, "ses_expired", EXPORT_TTL_DAYS + 2);
    capture.enqueue(jsonl, "ses_expired", "/repo/x", 80, "opencode");

    const result = capture.pruneExports();

    expect(result.pairs).toBe(1);
    expect(result.rows).toBe(1);
    expect(existsSync(jsonl)).toBe(false);
    expect(existsSync(meta)).toBe(false);
    // the unrelated pending row is untouched — retention is about the export bodies
    expect(capture.pending("/repo/keep").length).toBe(1);
    expect(capture.pending("/repo/x")).toEqual([]);
  });

  test("expiry deletes an old modern export orphan and its matching pending row", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    capture.setStateDir(root);
    const { jsonl, meta } = modernExportPair(root, "d".repeat(64), EXPORT_TTL_DAYS + 2);
    unlinkSync(meta);
    capture.enqueue(jsonl, "ses-modern", "/repo/orphan", 80, "opencode");

    const result = capture.pruneExports();

    expect(result.pairs).toBe(1);
    expect(result.rows).toBe(1);
    expect(existsSync(jsonl)).toBe(false);
    expect(capture.pending("/repo/orphan")).toEqual([]);
  });

  test("a distilled row survives expiry as a ledger entry", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    capture.setStateDir(root);
    const { jsonl } = exportPair(root, "ses_filed", EXPORT_TTL_DAYS + 2);
    capture.enqueue(jsonl, "ses_filed", "/repo/y", 80);
    capture.mark(jsonl, 100, "distilled");

    capture.pruneExports();

    expect(capture.stats().distilled).toBe(1); // metadata ledger keeps what was filed
    expect(existsSync(jsonl)).toBe(false); // …but the conversation text is gone
  });

  test("an orphaned pending OpenCode row is removed without touching other missing rows", () => {
    const root = join(scratch(), "state");
    ensureOwnedStateRoot(root);
    capture.setStateDir(root);
    const exportPath = join(root, "opencode-export", "a".repeat(64) + ".jsonl");
    mkdirSync(join(root, "opencode-export"), { recursive: true });
    writeFileSync(exportPath, "{}\n");
    capture.enqueue(exportPath, "gone", "/repo/x", 80, "opencode");
    unlinkSync(exportPath);

    const other = join(scratch(), "missing.jsonl");
    writeFileSync(other, "{}\n");
    capture.enqueue(other, "keep", "/repo/y", 80, "claude-jsonl");
    unlinkSync(other);

    const result = capture.pruneExports();

    expect(result.rows).toBe(1);
    expect(capture.pending("/repo/x")).toEqual([]);
    const db = new Database(capture.getDbPath(), { readonly: true });
    const retained = db.query("SELECT COUNT(*) AS n FROM capture_queue WHERE repo = '/repo/y'").get() as { n: number };
    db.close();
    expect(retained.n).toBe(1);
  });
});
