import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const ROOT = join(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("plugin-declared shell adapter gates a matching write once and stays silent for read-only Bash", () => {
  const root = tempDir("llmwiki-plugin-edit-");
  roots.push(root);
  const repo = enrollRepo(makeGitRepo(join(root, "repo")));
  const rules = join(repo, "docs/wiki/3_decision");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "boundary.md"), [
    "---", "type: Decision", "title: Adapter boundary", "status: stable",
    "x-llmwiki:", '  applies_to: ["src/**"]', '  rule: "SYNTHETIC RULE: preserve request metadata."', "---", "", "Grounded boundary.", "",
  ].join("\n"));
  const declared = JSON.parse(readFileSync(join(ROOT, "hooks/hooks.json"), "utf8"))
    .hooks.PreToolUse[0].hooks[0].command as string;
  // Resolve exactly the shipped plugin command. Omit plugin context here because a full
  // machine install legitimately suppresses the plugin copy; this tests the shared adapter.
  const adapter = declared.replaceAll('"', "").replace("$" + "{CLAUDE_PLUGIN_ROOT}", ROOT);
  const env: NodeJS.ProcessEnv = { ...process.env, LLMWIKI_STATE_DIR: join(root, "state"), LLMWIKI_EDIT_RULES: "gate" };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.LLMWIKI_ENGINE_SUBPROCESS;
  const call = (tool_name: string, tool_input: Record<string, string>) => {
    const result = Bun.spawnSync(["bash", adapter], {
      cwd: repo, env,
      stdin: Buffer.from(JSON.stringify({ cwd: repo, session_id: root, tool_name, tool_input })),
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  const first = JSON.parse(call("Write", { file_path: join(repo, "src/handler.ts"), content: "sentinel" }));
  expect(first.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(first.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(first.hookSpecificOutput.permissionDecisionReason).toContain("SYNTHETIC RULE");
  expect(call("Write", { file_path: join(repo, "src/handler.ts"), content: "sentinel" })).toBe("");
  expect(call("Bash", { command: "rg metadata src" })).toBe("");
});
