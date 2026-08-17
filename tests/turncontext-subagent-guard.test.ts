// Subagent turns stay silent: Codex fires UserPromptSubmit for subagent threads too, and marks
// them with agent_id/agent_type in the hook payload (null on the main thread; Claude Code sends
// neither field). A subagent's "prompt" is the orchestrator's instruction, not the human's — so
// the CLI must not inject wiki pointers into it. These tests drive the real hook entrypoint
// (stdin payload, --hook-event) end to end against an indexed wiki.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const HOOK_CLI = join(import.meta.dir, "..", "src", "hook-cli.ts");

function runTurnContext(repo: string, payload: Record<string, unknown>): string {
  const r = Bun.spawnSync(["bun", HOOK_CLI, "turn-context-hook", repo], {
    stdin: Buffer.from(JSON.stringify(payload)),
    env: { ...process.env },
  });
  return r.stdout?.toString() ?? "";
}

describe("turn-context subagent guard", () => {
  let repo: string;

  beforeEach(() => {
    repo = enrollRepo(makeGitRepo(tempDir("llmwiki-subagent-")));
    const wiki = join(repo, "docs", "wiki", "3_decision");
    mkdirSync(wiki, { recursive: true });
    // Body repeated past the chunk floor so the page is FTS-searchable.
    writeFileSync(
      join(wiki, "turbowidget-rollout.md"),
      "---\ntitle: Turbowidget rollout\n---\n" +
        "The turbowidget rollout checklist gates the deployment pipeline stages. ".repeat(10),
    );
    new WikiIndex(repo).indexAll();
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const prompt = "how does the turbowidget rollout work";

  test("a subagent payload (agent_type) gets ZERO bytes, not pointers", () => {
    const out = runTurnContext(repo, {
      prompt,
      session_id: "s-guard",
      cwd: repo,
      agent_id: "agent-1",
      agent_type: "explore",
    });
    expect(out).toBe("");
  });

  test("agent_id alone also marks a subagent turn", () => {
    const out = runTurnContext(repo, { prompt, session_id: "s-guard", cwd: repo, agent_id: "agent-2" });
    expect(out).toBe("");
  });

  test("null agent fields (Codex main thread) still retrieve", () => {
    const out = runTurnContext(repo, {
      prompt,
      session_id: "s-main",
      cwd: repo,
      agent_id: null,
      agent_type: null,
    });
    expect(out).toContain("turbowidget-rollout.md"); // the guard must not eat the main thread
  });
});
