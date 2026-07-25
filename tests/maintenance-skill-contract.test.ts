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

function sourceSkill(name: "wiki-save" | "wiki-deep"): string {
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
});
