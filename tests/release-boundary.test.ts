import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("release boundary", () => {
  test("local credentials and raw transcripts are ignored", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const pattern of [".env", ".env.*", "auth.json", "*.jsonl", "*.jsonl.zst"]) {
      expect(ignore.split("\n")).toContain(pattern);
    }
  });

  test("no tracked file matches a private runtime artifact", () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const tracked = new TextDecoder()
      .decode(result.stdout)
      .split("\0")
      .filter(Boolean);
    const forbidden = tracked.filter(
      (path) =>
        (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith("/.env.example") && path !== ".env.example") ||
        /(^|\/)auth\.json$/.test(path) ||
        /(^|\/)capture\.db$/.test(path) ||
        /(^|\/)index\.db$/.test(path) ||
        /(^|\/)rollout-.*\.jsonl(\.zst)?$/.test(path),
    );
    expect(forbidden).toEqual([]);
  });
});
