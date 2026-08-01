// Opening SOMEONE ELSE'S live SQLite database for reading — the operation every harness adapter
// depends on, and the one that fails in the least obvious way.
//
// `new Database(path, { readonly: true })` is not as read-only as it sounds. A WAL database needs
// its `-shm` shared-memory index, and creating (or even attaching to) that file requires WRITE
// permission on the DIRECTORY the database sits in. So a read-only bind mount, a container running
// as a different uid, or a harness directory owned by another account all fail here — and they fail
// with an errno string that the caller reported as "not an OpenCode database", sending people to
// look for a schema problem that does not exist.
//
// The ladder, cheapest correct answer first:
//
//   direct     — the normal open. Sees everything, including uncheckpointed WAL content.
//   snapshot   — copy the database and its -wal into a private temp dir we DO own, and open that.
//                Costs a file copy, but the copy includes the WAL, so nothing recent is lost.
//   immutable  — `file:…?immutable=1` tells SQLite the file cannot change, so it skips the -shm
//                machinery entirely. Instant, needs no write permission anywhere — but it ignores
//                the WAL, so the newest sessions are invisible until the harness checkpoints. Last
//                resort precisely because that staleness is silent.
//
// Every rung is verified by an actual query before it is handed back: an open that has not touched
// the file yet has not proven anything.
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SNAP_PREFIX = "llmwiki-snap-";
const SNAP_STALE_MS = 60 * 60 * 1000;
const POSIX = process.platform !== "win32";

// Snapshot directories created by THIS process, removed on exit. `close()` is the primary
// disposal; this is the backstop for the paths close() cannot cover (process.exit from a CLI
// command, an uncaught throw). A SIGKILL still leaks — that is what the stale sweep is for.
const liveSnapshotDirs = new Set<string>();
let exitHookInstalled = false;

function trackSnapshotDir(dir: string): void {
  liveSnapshotDirs.add(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const d of liveSnapshotDirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* the stale sweep gets it next time */
        }
      }
    });
  }
}

/**
 * Remove snapshot leftovers from crashed processes. These are full plaintext copies of someone's
 * session database sitting in the world-readable-by-name /tmp namespace (the dirs themselves are
 * 0700) — nothing else ever reaps them, and systemd-tmpfiles takes ten days. Runs only when the
 * snapshot rung is actually reached, so the common path pays nothing.
 */
function sweepStaleSnapshots(): void {
  let names: string[];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - SNAP_STALE_MS;
  for (const name of names) {
    if (!name.startsWith(SNAP_PREFIX)) continue;
    const path = join(tmpdir(), name);
    if (liveSnapshotDirs.has(path)) continue;
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true });
    } catch {
      /* someone else's, or gone already */
    }
  }
}

export type OpenVia = "direct" | "snapshot" | "immutable" | "failed";

export interface ReadonlyHandle {
  /** Null only when every rung failed; `detail` then says what actually blocked it. */
  readonly db: Database | null;
  readonly via: OpenVia;
  /** One line of evidence — safe to print, names no database content. */
  readonly detail: string;
  /** Closes the connection and releases any snapshot. Always safe to call. */
  close(): void;
  /**
   * Release the snapshot WITHOUT closing the connection. Separate from `close()` so a caller that
   * owns the connection's lifetime (openReadonlyDatabase) can hook disposal onto `db.close()`
   * without the two paths calling each other in a loop.
   */
  dispose(): void;
}

const NOOP_CLOSE = (): void => {};

/** An open that has not read anything has not proven anything. */
function probe(db: Database): boolean {
  try {
    db.query("SELECT count(*) AS n FROM sqlite_master").get();
    return true;
  } catch {
    return false;
  }
}

function tryDirect(path: string): Database | null {
  try {
    const db = new Database(path, { readonly: true });
    if (probe(db)) return db;
    db.close();
  } catch {
    /* fall through to the next rung */
  }
  return null;
}

function trySnapshot(path: string): { db: Database; dir: string } | null {
  sweepStaleSnapshots();
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), SNAP_PREFIX), { encoding: "utf-8" });
  } catch {
    return null;
  }
  trackSnapshotDir(dir);
  try {
    const copy = join(dir, basename(path) || "snapshot.db");
    copyFileSync(path, copy);
    // The -wal carries everything not yet checkpointed into the main file. Copying it is what makes
    // this rung complete rather than merely available; -shm is derived and is rebuilt on open.
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, copy + suffix);
    }
    // copyFileSync PRESERVES the source's mode — a 0644 source database yields a 0644 copy of
    // someone's session history. The 0700 directory contains it, but the file's own mode should
    // not depend on how the harness happened to create the original.
    if (POSIX) {
      for (const suffix of ["", "-wal", "-journal"]) {
        if (existsSync(copy + suffix)) chmodSync(copy + suffix, 0o600);
      }
    }
    const db = new Database(copy);
    // quick_check, not just a sqlite_master read: the copy of a LIVE database plus its -wal is not
    // atomic, and a torn pair happily answers `SELECT count(*) FROM sqlite_master` while lying
    // about everything else. Runs on the snapshot rung only, where correctness beats speed.
    if (probe(db)) {
      try {
        const check = db.query("PRAGMA quick_check(1)").get() as { quick_check?: string } | null;
        if (check?.quick_check === "ok") return { db, dir };
      } catch {
        /* torn copy — fall through to disposal */
      }
    }
    db.close();
  } catch {
    /* fall through */
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    liveSnapshotDirs.delete(dir);
  } catch {
    /* best effort */
  }
  return null;
}

function tryImmutable(path: string): Database | null {
  try {
    // The path is DATA inside a URI, so URI syntax in it must be escaped. Unencoded, SQLite parses
    // everything after `?` as parameters (an attacker-shaped path can inject them), a `#` silently
    // drops immutable=1, and `%xx` sequences are DECODED — the file opened is then not the file
    // that was verified. Demonstrated with a literal `a%2f..%2f..` filename opening a different db.
    const uriPath = path.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
    const db = new Database(`file:${uriPath}?immutable=1`, { readonly: true });
    if (probe(db)) return db;
    db.close();
  } catch {
    /* every rung is exhausted */
  }
  return null;
}

/**
 * Open a foreign SQLite database for reading, trying progressively more defensive strategies.
 *
 * Callers get one uniform handle and never have to know which rung answered — except through
 * `via`/`detail`, which exist so a diagnostic can say "this worked, but you are seeing a snapshot".
 */
export function openReadonlySqlite(path: string): ReadonlyHandle {
  const handle = (db: Database, via: OpenVia, detail: string, dispose: () => void = NOOP_CLOSE): ReadonlyHandle => ({
    db,
    via,
    detail,
    dispose,
    close: () => {
      try {
        db.close();
      } finally {
        dispose();
      }
    },
  });

  if (!existsSync(path)) {
    return { db: null, via: "failed", detail: "path does not exist", close: NOOP_CLOSE, dispose: NOOP_CLOSE };
  }

  const direct = tryDirect(path);
  if (direct) return handle(direct, "direct", "opened read-only");

  const snapshot = trySnapshot(path);
  if (snapshot) {
    return handle(
      snapshot.db,
      "snapshot",
      "opened a private snapshot (the database's own directory is not writable, so SQLite could " +
        "not create the -shm index there; the WAL was copied too, so nothing recent is missing)",
      () => {
        try {
          rmSync(snapshot.dir, { recursive: true, force: true });
        } catch {
          /* the exit hook or the stale sweep reaps it */
        }
        liveSnapshotDirs.delete(snapshot.dir);
      },
    );
  }

  const immutable = tryImmutable(path);
  if (immutable) {
    return handle(
      immutable,
      "immutable",
      "opened immutably (no write access anywhere near the database) — WAL content is NOT " +
        "visible this way, so sessions written since the harness last checkpointed are missing " +
        "until it does",
    );
  }

  return {
    db: null,
    via: "failed",
    detail:
      "cannot be opened for reading — the file is unreadable by this user (a permissions problem, " +
      "not a schema one)",
    close: NOOP_CLOSE,
    dispose: NOOP_CLOSE,
  };
}

/**
 * The same ladder, shaped like the `new Database(path, { readonly: true })` it replaces: one
 * nullable connection whose `close()` also disposes of a snapshot if that is what answered.
 *
 * Binding cleanup to `close()` is deliberate. The alternative — handing every call site a handle
 * object — would have each of them remember to release a temp directory they never asked to create,
 * and the one that forgot would leak a copy of someone's session database into /tmp.
 */
export function openReadonlyDatabase(path: string): Database | null {
  const handle = openReadonlySqlite(path);
  if (handle.db === null) return null;
  const db = handle.db;
  const close = db.close.bind(db);
  db.close = ((...args: unknown[]) => {
    try {
      return (close as (...a: unknown[]) => unknown)(...args);
    } finally {
      handle.dispose();
    }
  }) as typeof db.close;
  return db;
}
