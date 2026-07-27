// Central capture queue watermark flow.
// Redirect STATE_DIR to a temp dir so the real capture.db is never touched.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";

describe("capture queue", () => {
  let dir: string;
  let state: string;
  let transcript: string;

  beforeEach(() => {
    // Transcripts live OUTSIDE the state root: llmwiki refuses to adopt a state directory
    // holding files it did not create, so a fixture that mixes the two is not a valid setup.
    dir = mkdtempSync(join(tmpdir(), "llmwiki-cap-"));
    state = join(dir, "state");
    capture.setStateDir(state);
    transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, "line one\nline two\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("enqueue → pending → mark → get_offset flow", () => {
    capture.enqueue(transcript, "sess1", "/repo/x", 2);

    const pend = capture.pending();
    expect(pend.length).toBe(1);
    expect(pend[0]!.repo).toBe("/repo/x");
    expect(pend[0]!.session_id).toBe("sess1");

    expect(capture.getOffset(transcript)).toBe(0);

    const size = statSync(transcript).size;
    capture.mark(transcript, size, "distilled");

    expect(capture.getOffset(transcript)).toBe(size);
    expect(capture.pending()).toEqual([]);
    expect(capture.stats().distilled).toBe(1);
  });

  test("pending filtered by repo", () => {
    capture.enqueue(transcript, "sess1", "/repo/x", 2);
    expect(capture.pending("/repo/x").length).toBe(1);
    expect(capture.pending("/repo/other")).toEqual([]);
  });

  test("get_offset unknown path", () => {
    expect(capture.getOffset(join(dir, "nope.jsonl"))).toBe(0);
  });

  test("pending keeps a row whose file was compressed in place (.jsonl → .jsonl.zst)", () => {
    const transcript = join(dir, "cold.jsonl");
    writeFileSync(transcript, '{"type":"user"}\n');
    capture.enqueue(transcript, "sess-z", "/repo/z", 1);
    expect(capture.pending("/repo/z").length).toBe(1);
    // harness compresses the finished transcript in place
    writeFileSync(transcript + ".zst", "zzz");
    rmSync(transcript);
    const rows = capture.pending("/repo/z");
    expect(rows.length).toBe(1); // fallback keeps the session alive for parse() to resolve
    expect(rows[0]!.transcript_path).toBe(transcript);
  });
});
