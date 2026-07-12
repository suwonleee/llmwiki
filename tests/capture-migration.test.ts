// Additive source_kind migration: an old capture.db (pre-abstraction, no source_kind)
// must gain the column on first connect() and read every existing row back as
// 'claude-jsonl' (no data migration). Also covers enqueue writing an explicit kind.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as capture from "../src/engine/capture.ts";

describe("capture source_kind migration", () => {
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-mig-"));
    capture.setStateDir(dir);
    transcript = join(dir, "old.jsonl");
    writeFileSync(transcript, "line one\nline two\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("old-schema DB gains column; existing rows backfill to claude-jsonl", () => {
    // hand-build a pre-migration capture_queue WITHOUT source_kind, with one row.
    const db = new Database(join(dir, "capture.db"));
    db.exec(
      "CREATE TABLE capture_queue (transcript_path TEXT PRIMARY KEY, session_id TEXT, repo TEXT, " +
        "byte_offset INTEGER DEFAULT 0, lines INTEGER DEFAULT 0, " +
        "status TEXT DEFAULT 'pending', first_seen TEXT, distilled_at TEXT)",
    );
    db.run("INSERT INTO capture_queue (transcript_path, repo, status) VALUES (?, '/repo/x', 'pending')", [
      transcript,
    ]);
    db.close();

    // any capture call triggers connect() → guarded ALTER.
    const rows = capture.pending();
    expect(rows.length).toBe(1);
    expect(rows[0]!.source_kind).toBe("claude-jsonl"); // backfilled by column default
    expect(capture.getSourceKind(transcript)).toBe("claude-jsonl");
  });

  test("enqueue records an explicit source_kind", () => {
    const plainFile = join(dir, "drop.md");
    writeFileSync(plainFile, "some dropped content\n");
    capture.enqueue(plainFile, null, "/repo/y", 1, "plain");
    expect(capture.getSourceKind(plainFile)).toBe("plain");
    const row = capture.pending("/repo/y")[0]!;
    expect(row.source_kind).toBe("plain");
  });

  test("getSourceKind defaults to claude-jsonl for unknown path", () => {
    expect(capture.getSourceKind(join(dir, "ghost.jsonl"))).toBe("claude-jsonl");
  });

  test("transcriptsForRepo lists all of a repo's transcripts (for register-transcript)", () => {
    const t2 = join(dir, "t2.jsonl");
    writeFileSync(t2, "more\n");
    capture.enqueue(transcript, "s1", "/repo/z", 2);
    capture.enqueue(t2, "s2", "/repo/z", 1);
    capture.enqueue(join(dir, "other.jsonl"), "s3", "/repo/other", 1);
    const got = capture.transcriptsForRepo("/repo/z").map((x) => x.path).sort();
    expect(got).toEqual([t2, transcript].sort());
  });
});
