// Guard for tests/support/preload.ts: a test run must never resolve the developer's real state
// root, in this process or in any child it starts without an explicit env.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

const PROBE = ["sh", "-c", 'printf %s "$LLMWIKI_STATE_DIR"'];

describe("test state isolation", () => {
  test("the pinned state root is a temp directory, never the machine default", () => {
    // Lexical on purpose: an earlier file in the same process may have pointed the variable at
    // its own temp root and deleted it already — still temp, just no longer on disk.
    const pinned = process.env.LLMWIKI_STATE_DIR ?? "";
    expect(pinned).not.toBe("");
    const roots = [tmpdir(), realpathSync(tmpdir())];
    expect(roots.some((root) => pinned.startsWith(root + sep))).toBe(true);
    expect(pinned.startsWith(join(homedir(), ".local", "share", "llmwiki"))).toBe(false);
  });

  test("children spawned without an env inherit the pinned root", () => {
    const pinned = process.env.LLMWIKI_STATE_DIR;
    expect(Bun.spawnSync(PROBE, { stdout: "pipe" }).stdout.toString()).toBe(pinned!);
    expect(Bun.spawnSync({ cmd: PROBE, stdout: "pipe" }).stdout.toString()).toBe(pinned!);
    expect(spawnSync(PROBE[0]!, PROBE.slice(1), { encoding: "utf-8" }).stdout).toBe(pinned!);
    expect(execFileSync(PROBE[0]!, PROBE.slice(1), { encoding: "utf-8" })).toBe(pinned!);
  });

  test("an explicit env is still honored as given", () => {
    const r = Bun.spawnSync(PROBE, { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe" });
    expect(r.stdout.toString()).toBe("");
  });
});
