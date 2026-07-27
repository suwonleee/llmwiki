// The output contract the injection hooks must satisfy on every harness that runs them.
//
// Both harnesses DECLARE the same envelope — a zod variant per event on one side, a JSON schema
// with additionalProperties:false on the other — and both also accept bare stdout as a fallback
// (verified in live sessions: plain text and the envelope inject identically today). We emit the
// declared form because it is the one a third harness will implement, and because a fallback is a
// courtesy that can be withdrawn; an extra key or a wrong event name, on the other hand, fails the
// whole payload where additionalProperties:false applies. These tests pin the shape verbatim,
// including the part that matters most: silence must stay silence.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-envelope-"));
  dirs.push(d);
  return d;
}

function run(args: string[]): { out: string; code: number | null } {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, LLMWIKI_STATE_DIR: join(scratch(), "state") },
  });
  return { out: r.stdout?.toString() ?? "", code: r.exitCode };
}

/** A repository with enough wiki for cold start to have something to say. */
function enrolledRepoWithWiki(): string {
  const repo = makeGitRepo(tempDir("llmwiki-envelope-repo-"));
  dirs.push(repo);
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wiki", "current-state.md"),
    "---\ntitle: Current State\n---\n\nDIRECTION: ship the thing.\n",
  );
  return enrollRepo(repo);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("hook output envelope", () => {
  test("SessionStart wraps the cold start in exactly the two declared keys", () => {
    const repo = enrolledRepoWithWiki();

    const { out } = run(["context", repo, "--hook-event", "SessionStart"]);

    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    // additionalProperties:false on the Codex side — an extra key fails the whole payload there.
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("DIRECTION: ship the thing.");
  });

  test("UserPromptSubmit names its own event", () => {
    const repo = enrolledRepoWithWiki();

    const { out } = run(["turn-context", repo, "--prompt", "direction", "--session", "s1", "--hook-event", "UserPromptSubmit"]);

    if (out.trim() === "") return; // turn-context stays silent when unconfident — also valid
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  });

  test("an unenrolled repository still prints ZERO bytes — not an empty envelope", () => {
    const repo = makeGitRepo(tempDir("llmwiki-envelope-cold-"));
    dirs.push(repo);
    mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
    writeFileSync(join(repo, "docs", "wiki", "current-state.md"), "---\ntitle: x\n---\n\nbody\n");

    const { out } = run(["context", repo, "--hook-event", "SessionStart"]);

    expect(out).toBe(""); // an envelope with an empty string is still an injection
  });

  test("without --hook-event the output stays plain text", () => {
    const repo = enrolledRepoWithWiki();

    const { out } = run(["context", repo]);

    expect(out.startsWith("{")).toBe(false);
    expect(out).toContain("DIRECTION: ship the thing.");
  });

  test("an unknown event name fails loudly instead of shipping an invalid payload", () => {
    const repo = enrolledRepoWithWiki();

    const { code } = run(["context", repo, "--hook-event", "PreToolUse"]);

    expect(code).not.toBe(0);
  });
});
