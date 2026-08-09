import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, PUBLIC_REFERENCE_FILES } from "../src/plugin/preflight.ts";

const ROOT = join(import.meta.dir, "..");
// Independent release oracle: production must match this reviewed list exactly. Do not derive this
// expectation from preflight's export or a newly added production allowlist entry self-approves.
const EXPECTED_PUBLIC_REFERENCES = [
  "reference/INSTALLATION_FLOW.md",
  "reference/support-contract.json",
  "reference/USABILITY_STUDY.md",
  "reference/usability-study-event.schema.json",
  "reference/usability-study-run.template.json",
  "reference/usability-study-task.md",
  "reference/RELEASE_GATES.md",
] as const;

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

  test("the actual release-candidate tree ships only the reviewed public references", () => {
    // Include tracked files plus unignored additions in THIS worktree so the boundary is testable
    // before the release commit as well as after it. Ignored private reference notes never enter
    // this list; after commit the same paths come from the cached half of the command.
    const result = Bun.spawnSync(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "reference/"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const candidate = new TextDecoder().decode(result.stdout).split("\0").filter(Boolean).sort();
    expect(candidate).toEqual([...EXPECTED_PUBLIC_REFERENCES].sort());
    expect([...PUBLIC_REFERENCE_FILES].sort()).toEqual([...EXPECTED_PUBLIC_REFERENCES].sort());
    expect(classify(ROOT, candidate).privateHits).toEqual([]);
  });
});
