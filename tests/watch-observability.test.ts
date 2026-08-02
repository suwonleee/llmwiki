import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

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
    // The sweep only materializes sessions belonging to an ENROLLED worktree, so the routed
    // repository is a real one here; "skipped_short" is then about volume, not about trust.
    const repo = enrollRepo(makeGitRepo(join(dir, "repo")));
    const rollout = join(codexHome, "sessions", "2026", "07", "22", "rollout-short.jsonl");
    const records = [{ type: "session_meta", payload: { id: "short", cwd: repo } }];
    while (records.length < 49) records.push({ type: "event_msg", payload: { type: "token_count" } } as any);
    writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const result = Bun.spawnSync(["bun", join(ROOT, "src", "daemon", "watch.ts"), "--once"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: join(dir, "home"),
        // USERPROFILE too: node's homedir() reads HOME on POSIX but USERPROFILE on Windows, so a
        // HOME-only override silently isolates nothing there — the sweep found this machine's real
        // OpenCode database and reported five sessions for a fixture that has one.
        USERPROFILE: join(dir, "home"),
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
