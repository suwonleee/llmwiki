import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function commandBlocks(skill: string): string {
  const blocks: string[] = [];
  let isCommandBlock = false;
  let lines: string[] = [];
  for (const line of skill.split("\n")) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence !== null) {
      if (isCommandBlock) blocks.push(lines.join("\n"));
      isCommandBlock = fence[1] === "sh" || fence[1] === "bash";
      lines = [];
      continue;
    }
    if (isCommandBlock) lines.push(line);
  }
  return blocks.join("\n");
}

function commandOffset(commands: string, command: string, start = 0): number {
  return commands.indexOf(command, start);
}

function sourceSkill(name: "wiki-save" | "wiki-deep" | "wiki-doctor"): string {
  return readFileSync(join(ROOT, "skill", `${name}.md`), "utf8");
}

describe("maintenance skill command contracts", () => {
  test("keeps wiki-save on the notice-only maintenance path", () => {
    // Given: the source close-out skill.
    const commands = commandBlocks(sourceSkill("wiki-save"));

    // When: its maintenance instructions are installed into a harness.
    const health = commandOffset(commands, "llmwiki db-health <repo> --notice");

    // Then: the only maintenance command is the opt-in health notice.
    expect(health).toBeGreaterThanOrEqual(0);
    expect(commands).not.toContain("llmwiki compact <repo> --commit");
    expect(commands).not.toContain("llmwiki wiki-clean <repo>");
  });

  test("runs wiki-deep maintenance in the safe escalation order", () => {
    // Given: the source deep-pass skill.
    const commands = commandBlocks(sourceSkill("wiki-deep"));

    // When: maintenance needs deterministic escalation.
    const indexed = commandOffset(commands, "llmwiki index <repo>");
    const linted = commandOffset(commands, "llmwiki lint <repo> --errors-only", indexed);
    const noticed = commandOffset(commands, "llmwiki db-health <repo> --notice", linted);
    const compacted = commandOffset(commands, "llmwiki compact <repo> --commit", noticed);
    const rechecked = commandOffset(commands, "llmwiki db-health <repo>", compacted + 1);
    const cleanupRecommendation = commandOffset(commands, "llmwiki wiki-clean <repo>", rechecked);

    // Then: health gates compaction, and cleanup stays a manual dry-run recommendation.
    expect(indexed).toBeGreaterThanOrEqual(0);
    expect(linted).toBeGreaterThan(indexed);
    expect(noticed).toBeGreaterThan(linted);
    expect(compacted).toBeGreaterThan(noticed);
    expect(rechecked).toBeGreaterThan(compacted);
    expect(cleanupRecommendation).toBeGreaterThan(rechecked);
    expect(commands).not.toContain("llmwiki wiki-clean <repo> --commit");
  });

  test("checks and repairs the active harness installation before the project wiki", () => {
    const skill = sourceSkill("wiki-doctor");
    const commands = commandBlocks(skill);

    const codexDoctor = commandOffset(commands, "llmwiki doctor --harness codex");
    const claudeDoctor = commandOffset(commands, "bun ~/llmwiki/src/cli.ts doctor --harness claude --fix");
    const openCodeDoctor = commandOffset(commands, "llmwiki doctor --harness opencode");
    const projectDoctor = commandOffset(commands, "llmwiki wiki-doctor <repo> --fix");

    expect(codexDoctor).toBeGreaterThanOrEqual(0);
    expect(claudeDoctor).toBeGreaterThanOrEqual(0);
    expect(openCodeDoctor).toBeGreaterThanOrEqual(0);
    expect(projectDoctor).toBeGreaterThan(codexDoctor);
    expect(projectDoctor).toBeGreaterThan(claudeDoctor);
    expect(projectDoctor).toBeGreaterThan(openCodeDoctor);
    expect(skill).toMatch(/Never run the installation doctor without an\s+explicit `--harness`/);
    expect(skill).toMatch(/A nonzero exit alone does not mean the active\s+harness wiring is broken\./);
    expect(skill).toMatch(
      /continue to the project check when the\s+selected harness's llmwiki-owned files are current/,
    );
  });
});

// The deep pass once read "lossless safety net · process EVERY pending transcript" and answered a
// 557-row backlog by bulk-marking it done in ten minutes (~48% durable coverage afterwards). The
// contract is now: file what is important, skip the rest explicitly, report engine counts.
describe("wiki-deep backlog contract", () => {
  test("no drain-everything framing; read-before-filing, triage and engine-counted report are pinned", () => {
    const deep = sourceSkill("wiki-deep");
    expect(deep).not.toMatch(/lossless|EVERY pending/);
    expect(deep).toContain("Never mark `update-done` without `--skipped` on a session whose extract you did not read");
    expect(deep).toContain("triage deterministically first");
    expect(deep).toContain("`ledger:` line of `llmwiki update-status <repo>`");
    expect(deep).toContain("⚠ route sessions:");
    expect(sourceSkill("wiki-save")).not.toMatch(/lossless/);
  });
});
