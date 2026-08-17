import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const HOOK_CLI = join(import.meta.dir, "..", "src", "hook-cli.ts");

const FULL_CLI = join(import.meta.dir, "..", "src", "cli.ts");

function run(repo: string, payload: Record<string, unknown> | string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([process.execPath, HOOK_CLI, "context-hook", repo], {
    cwd: repo,
    stdin: Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function seedProject(prefix: string, marker: string, roots: string[]): string {
  const root = tempDir(prefix);
  roots.push(root);
  const repo = enrollRepo(makeGitRepo(join(root, "repo")));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wiki", "current-state.md"),
    `---\ntitle: Current State\n---\n\n## Now\n\n- ${marker}\n`,
  );
  return repo;
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

  // The payload is how a harness names the session; it is not permission to read the wiki. Losing
  // it must cost the route hint only. `cli.ts context --hook-event SessionStart` has always fallen
  // back to the positional project, and this entrypoint replaced that call in the shipped hook —
  // so a harness that fires SessionStart without a payload would otherwise go from "work memory
  // injected" to "completely silent", which is indistinguishable from llmwiki not being installed.
  for (const [name, body] of [
    ["an absent payload", ""],
    ["a malformed payload", "not json at all"],
  ] as const) {
    test(`${name} still injects the positional project's memory`, () => {
      const roots: string[] = [];
      try {
        const repo = seedProject(`llmwiki-sessionstart-hook-${name.split(" ")[1]}-`, "PAYLOADLESS-MEMORY", roots);

        const hook = run(repo, body);
        expect(hook.exitCode).toBe(0);
        const injected = JSON.parse(hook.stdout?.toString() ?? "");
        expect(injected.hookSpecificOutput.hookEventName).toBe("SessionStart");
        expect(injected.hookSpecificOutput.additionalContext).toContain("PAYLOADLESS-MEMORY");

        // …and it says exactly what the full CLI would have said, which is the contract this
        // lightweight entrypoint claims to preserve.
        const full = Bun.spawnSync(
          [process.execPath, FULL_CLI, "context", repo, "--hook-event", "SessionStart"],
          { cwd: repo, stdin: Buffer.from(body), stdout: "pipe", stderr: "pipe" },
        );
        expect(full.exitCode).toBe(0);
        expect(JSON.parse(full.stdout?.toString() ?? "").hookSpecificOutput.additionalContext).toBe(
          injected.hookSpecificOutput.additionalContext,
        );
      } finally {
        for (const root of roots) rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
