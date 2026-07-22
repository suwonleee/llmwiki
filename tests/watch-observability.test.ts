import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("capture sweep observability", () => {
  let dir: string;
  let codexHome: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-watch-"));
    codexHome = join(dir, "codex");
    stateDir = join(dir, "state");
    mkdirSync(join(codexHome, "sessions", "2026", "07", "22"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("reports why a discovered Codex session was skipped", () => {
    const rollout = join(codexHome, "sessions", "2026", "07", "22", "rollout-short.jsonl");
    const records = [{ type: "session_meta", payload: { id: "short", cwd: join(dir, "repo") } }];
    while (records.length < 49) records.push({ type: "event_msg", payload: { type: "token_count" } } as any);
    writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

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

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("discovered=1 enqueued=0 skipped_short=1");
  });
});
