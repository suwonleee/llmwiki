import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const HOOK_CLI = join(import.meta.dir, "..", "src", "hook-cli.ts");

function run(repo: string, payload: Record<string, unknown>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, HOOK_CLI, "context-hook", repo], {
    cwd: repo,
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("lightweight SessionStart entrypoint", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("emits the declared SessionStart envelope for an enrolled project", () => {
    const root = tempDir("llmwiki-sessionstart-hook-");
    roots.push(root);
    const repo = enrollRepo(makeGitRepo(join(root, "repo")));
    mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "wiki", "current-state.md"),
      "---\ntitle: Current State\n---\n\n## Now\n\n- LIGHTWEIGHT-SESSIONSTART-MEMORY\n",
    );

    const result = run(repo, { cwd: repo, session_id: "sessionstart-main" });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout?.toString() ?? "");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("LIGHTWEIGHT-SESSIONSTART-MEMORY");
  });

  test("an unenrolled project stays zero-byte silent", () => {
    const root = tempDir("llmwiki-sessionstart-hook-off-");
    roots.push(root);
    const repo = makeGitRepo(join(root, "repo"));
    mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
    writeFileSync(join(repo, "docs", "wiki", "current-state.md"), "private clone memory\n");

    const result = run(repo, { cwd: repo, session_id: "sessionstart-off" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout?.toString() ?? "").toBe("");
  });
});
