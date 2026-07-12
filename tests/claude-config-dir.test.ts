// $CLAUDE_CONFIG_DIR support: config-dir discovery + capture probe must both honor an
// explicit Claude config dir living outside ~/.claude* — otherwise wire silently skips
// the hooks ("non-Claude harness") and the daemon captures nothing for such setups.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDirs, claudeJsonlSource } from "../src/engine/sources/claude.ts";

let home: string;
let cfg: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmwiki-home-"));
  cfg = mkdtempSync(join(tmpdir(), "llmwiki-cfg-"));
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

describe("claudeConfigDirs", () => {
  test("finds ~/.claude* dirs (baseline, env unset)", () => {
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".claude-work"));
    writeFileSync(join(home, ".claude.json"), "{}"); // file, not dir → excluded
    expect(claudeConfigDirs(home)).toEqual([join(home, ".claude"), join(home, ".claude-work")]);
  });

  test("includes $CLAUDE_CONFIG_DIR outside home / non-.claude name", () => {
    mkdirSync(join(home, ".claude"));
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const dirs = claudeConfigDirs(home);
    expect(dirs).toContain(cfg);
    expect(dirs).toContain(join(home, ".claude"));
  });

  test("dedupes when $CLAUDE_CONFIG_DIR points at an already-found profile", () => {
    mkdirSync(join(home, ".claude"));
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude") + "/"; // trailing slash normalized
    expect(claudeConfigDirs(home)).toEqual([join(home, ".claude")]);
  });

  test("ignores a $CLAUDE_CONFIG_DIR that doesn't exist", () => {
    process.env.CLAUDE_CONFIG_DIR = join(cfg, "nope");
    expect(claudeConfigDirs(home)).toEqual([]);
  });
});

describe("probe under $CLAUDE_CONFIG_DIR", () => {
  test("accepts <cfg>/projects/**.jsonl only when the env is set", () => {
    const proj = join(cfg, "projects", "-tmp-repo");
    mkdirSync(proj, { recursive: true });
    const t = join(proj, "abc.jsonl");
    writeFileSync(t, JSON.stringify({ cwd: "/tmp/repo", sessionId: "s1" }) + "\n");

    expect(claudeJsonlSource.probe(t)).toBeNull(); // env unset → rejected (pre-existing behavior)

    process.env.CLAUDE_CONFIG_DIR = cfg;
    const hit = claudeJsonlSource.probe(t);
    expect(hit).not.toBeNull();
    expect(hit!.repo).toBe("/tmp/repo");
    expect(hit!.sessionId).toBe("s1");
  });

  test("still rejects subagent transcripts under <cfg>/projects", () => {
    process.env.CLAUDE_CONFIG_DIR = cfg;
    const sub = join(cfg, "projects", "-tmp-repo", "subagents");
    mkdirSync(sub, { recursive: true });
    const t = join(sub, "abc.jsonl");
    writeFileSync(t, JSON.stringify({ cwd: "/tmp/repo", sessionId: "s2" }) + "\n");
    expect(claudeJsonlSource.probe(t)).toBeNull();
  });
});
