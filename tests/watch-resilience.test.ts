// The daemon IS the capture loop, so no single session may take it down.
//
// `process_` writes to SQLite. A locked database, a vanished file, an unwritable state dir — any
// throw propagated out of the poll loop and killed the process. Capture then stops SILENTLY:
// transcripts keep rotating per the harness's own retention and the sessions are simply gone,
// with a wiki that looks merely quiet. One bad session must be logged, counted, and skipped.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

const ROOT = join(import.meta.dir, "..");

describe("capture sweep resilience", () => {
  let dir: string;
  let codexHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-watch-resilience-"));
    codexHome = join(dir, "codex");
    mkdirSync(join(codexHome, "sessions", "2026", "07", "25"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a session that cannot be enqueued is counted and skipped, not fatal", () => {
    // Given: one capture-worthy session…
    // Enrolled, so the session reaches the enqueue step — which is where the broken state dir
    // must be survived rather than avoided.
    const repo = enrollRepo(makeGitRepo(join(dir, "repo")));
    const rollout = join(codexHome, "sessions", "2026", "07", "25", "rollout-long.jsonl");
    const records: unknown[] = [{ type: "session_meta", payload: { id: "long", cwd: repo } }];
    while (records.length < 80) records.push({ type: "event_msg", payload: { type: "agent_message" } });
    writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    // …and a state dir that cannot hold the queue database (it is a FILE).
    const stateDir = join(dir, "state-not-a-dir");
    writeFileSync(stateDir, "in the way\n");

    const result = Bun.spawnSync(["bun", join(ROOT, "src", "daemon", "watch.ts"), "--once"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: join(dir, "home"),
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        CODEX_HOME: codexHome,
        LLMWIKI_STATE_DIR: stateDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Then: the sweep completes and says what happened instead of dying on the first session.
    const stdout = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("discovered=1");
    expect(stdout).toContain("failed=1");
  });
});
