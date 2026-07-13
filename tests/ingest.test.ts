// ingest repo bucketing: a plain drop has no probeable provenance, so its capture-queue
// row must bucket under the target workspace — never the caller's cwd, which would
// pollute another repo's backlog (regression: repo fell back to process.cwd()).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { ingest } from "../src/engine/ingest.ts";

describe("ingest repo bucketing", () => {
  let dir: string;
  let ws: string;
  let prevCwd: string;
  let prevCmd: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-ingest-"));
    capture.setStateDir(join(dir, "state"));
    ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    prevCwd = process.cwd();
    process.chdir(dir); // caller's cwd ≠ ws — the regression trigger
    prevCmd = process.env.LLMWIKI_LLM_CMD;
    process.env.LLMWIKI_LLM_CMD = "false"; // exits 1 → fail-write; no real LLM call
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevCmd === undefined) delete process.env.LLMWIKI_LLM_CMD;
    else process.env.LLMWIKI_LLM_CMD = prevCmd;
    rmSync(dir, { recursive: true, force: true });
  });

  test("plain drop buckets under the workspace, not the caller's cwd", async () => {
    const note = join(dir, "note.md");
    writeFileSync(note, "# session note\nWe fixed the CSV importer timezone bug.\n");

    const r = await ingest(ws, note);

    expect(r.repo).toBe(resolve(ws));
    const wsRows = capture.transcriptsForRepo(resolve(ws));
    expect(wsRows.map((t) => t.path)).toContain(resolve(note));
    expect(capture.transcriptsForRepo(process.cwd())).toEqual([]);
  });

  test("--repo flag still wins over the workspace default", async () => {
    const note = join(dir, "note2.md");
    writeFileSync(note, "# another note\n");
    const other = join(dir, "other-repo");
    mkdirSync(other, { recursive: true });

    const r = await ingest(ws, note, { repo: other });

    expect(r.repo).toBe(resolve(other));
    expect(capture.transcriptsForRepo(resolve(other)).map((t) => t.path)).toContain(resolve(note));
  });
});
