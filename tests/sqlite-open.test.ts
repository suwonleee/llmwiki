// The read ladder for foreign harness databases (src/engine/sqlite-open.ts).
//
// The rung that matters is the middle one. A plain `{ readonly: true }` open of a WAL database
// needs WRITE permission on the containing DIRECTORY, because SQLite has to attach the `-shm`
// index there — so a read-only mount, or a harness directory owned by another account, failed with
// an errno the caller reported as "not an OpenCode database". These tests pin the recovery, and
// pin that a genuinely unreadable file still fails closed.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadonlyDatabase, openReadonlySqlite } from "../src/engine/sqlite-open.ts";

const POSIX = process.platform !== "win32";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** A WAL database with one row, in its own directory whose mode the caller can change. */
function fixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-sqlite-open-"));
  const path = join(dir, "harness.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE session (id TEXT)");
  db.run("INSERT INTO session (id) VALUES ('s1')");
  db.close();
  cleanups.push(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path };
}

function sessionCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n;
}

describe("openReadonlySqlite", () => {
  test("opens a normal database directly", () => {
    const { path } = fixture();
    const handle = openReadonlySqlite(path);
    try {
      expect(handle.via).toBe("direct");
      expect(handle.db).not.toBeNull();
      expect(sessionCount(handle.db!)).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("reports a missing path as failed rather than throwing", () => {
    const handle = openReadonlySqlite(join(tmpdir(), "llmwiki-absent-does-not-exist.db"));
    expect(handle.via).toBe("failed");
    expect(handle.db).toBeNull();
    expect(handle.detail).toContain("does not exist");
    handle.close();
  });

  test.if(POSIX && process.getuid?.() !== 0)(
    "falls back off `direct` when the database's directory is not writable, and still reads every row",
    () => {
      const { dir, path } = fixture();
      chmodSync(dir, 0o500); // r-x: the file is readable, the directory is not writable
      const handle = openReadonlySqlite(path);
      try {
        // Which rung answers is an implementation detail of the platform's SQLite; that it is NOT
        // the direct one, and that the data still arrives, is the contract.
        expect(handle.via).not.toBe("failed");
        expect(handle.db).not.toBeNull();
        expect(sessionCount(handle.db!)).toBe(1);
      } finally {
        handle.close();
      }
    },
  );

  test.if(POSIX && process.getuid?.() !== 0)("fails closed when the file itself cannot be read", () => {
    const { path } = fixture();
    chmodSync(path, 0o000);
    const handle = openReadonlySqlite(path);
    try {
      expect(handle.db).toBeNull();
      expect(handle.via).toBe("failed");
      // The whole point of the rewrite: say "permissions", not "not a harness database".
      expect(handle.detail).toContain("permissions");
    } finally {
      handle.close();
      chmodSync(path, 0o600);
    }
  });

  // The real-world shape of the bug, which needs a SECOND process to reproduce: the reader must not
  // already hold the shared-memory mapping. A live -wal the reader cannot attach to is exactly what
  // a read-only mount or a foreign-uid harness directory produces.
  test.if(POSIX && process.getuid?.() !== 0)(
    "reaches a live WAL database through a snapshot when -shm cannot be attached",
    () => {
      const { path } = fixture();
      const writer = new Database(path);
      try {
        writer.exec("PRAGMA journal_mode=WAL");
        writer.run("INSERT INTO session (id) VALUES ('uncheckpointed')");
        chmodSync(`${path}-shm`, 0o000);

        const reader = join(mkdtempSync(join(tmpdir(), "llmwiki-reader-")), "reader.ts");
        cleanups.push(() => rmSync(reader, { recursive: true, force: true }));
        writeFileSync(
          reader,
          `import { openReadonlySqlite } from ${JSON.stringify(join(import.meta.dir, "..", "src", "engine", "sqlite-open.ts"))};\n` +
            "const h = openReadonlySqlite(process.argv[2]);\n" +
            "console.log(JSON.stringify({ via: h.via, rows: h.db ? h.db.query('SELECT COUNT(*) AS n FROM session').get().n : null }));\n" +
            "h.close();\n",
        );
        const r = Bun.spawnSync([process.execPath, reader, path], { stdout: "pipe", stderr: "pipe" });
        const out = JSON.parse(r.stdout.toString().trim() || "{}");

        expect(out.via).toBe("snapshot");
        // Both the checkpointed row and the one still only in the -wal: copying the WAL is what
        // makes this rung complete rather than merely available.
        expect(out.rows).toBe(2);
      } finally {
        try {
          chmodSync(`${path}-shm`, 0o600);
        } catch {
          /* already gone */
        }
        writer.close();
      }
    },
  );

  test("is not fooled by a file that is not SQLite at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-sqlite-open-junk-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "not-a-database.db");
    writeFileSync(path, "this is plain text, not a database\n");
    const handle = openReadonlySqlite(path);
    try {
      expect(handle.db).toBeNull();
    } finally {
      handle.close();
    }
  });
});

describe("openReadonlyDatabase", () => {
  test("hands back a plain connection whose close() also releases any snapshot", () => {
    const { path } = fixture();
    const db = openReadonlyDatabase(path);
    expect(db).not.toBeNull();
    expect(sessionCount(db!)).toBe(1);
    // close() is patched for the snapshot rung; calling it must not recurse or throw on any rung.
    expect(() => db!.close()).not.toThrow();
  });

  test("returns null instead of throwing when nothing can open the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-sqlite-open-dir-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "a-directory.db"));
    expect(openReadonlyDatabase(join(dir, "a-directory.db"))).toBeNull();
  });

  test.if(POSIX && process.getuid?.() !== 0)("leaves no snapshot behind in the temp dir", () => {
    const { dir, path } = fixture();
    chmodSync(dir, 0o500);
    const before = snapshotDirs();
    const db = openReadonlyDatabase(path);
    expect(db).not.toBeNull();
    db!.close();
    expect(snapshotDirs()).toEqual(before);
  });
});

/** Snapshot scratch directories currently on disk — none may survive a close(). */
function snapshotDirs(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  try {
    return readdirSync(tmpdir())
      .filter((name) => name.startsWith("llmwiki-snap-"))
      .sort();
  } catch {
    return [];
  }
}
