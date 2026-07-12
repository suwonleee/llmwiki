// Slice 2: registerTranscript records the real source extension as file_type (was
// hardcoded 'jsonl') so a non-Claude / dropped source is reflected correctly.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";

describe("registerTranscript file_type", () => {
  let root: string;
  let idx: WikiIndex;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-rt-"));
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    idx = new WikiIndex(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fileType(rel: string): string {
    const conn = idx.connect();
    const row = conn
      .query("SELECT file_type FROM documents WHERE relative_path = ?")
      .get(rel) as { file_type: string } | null;
    conn.close();
    return row!.file_type;
  }

  test("claude rollout → jsonl", () => {
    idx.registerTranscript("/home/u/.claude/projects/x/sess.jsonl", "s1");
    expect(fileType("__transcript__/sess.jsonl")).toBe("jsonl");
  });

  test("dropped markdown → md", () => {
    idx.registerTranscript("/tmp/notes.md", null);
    expect(fileType("__transcript__/notes.md")).toBe("md");
  });

  test("extensionless path → defaults to jsonl", () => {
    idx.registerTranscript("/tmp/rollout", null);
    expect(fileType("__transcript__/rollout")).toBe("jsonl");
  });
});
