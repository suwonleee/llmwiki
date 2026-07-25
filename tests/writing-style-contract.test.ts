import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaText } from "../src/engine/autoupdate.ts";
import { defaults } from "../src/engine/config.ts";
import { ensureSkeleton } from "../src/engine/update.ts";

const ROOT = join(import.meta.dir, "..");
const FOUR = "`    -`";
const EIGHT = "`        -`";

describe("compact hierarchical wiki writing contract", () => {
  test("all engine-side model writers consume the shared compact rule", () => {
    expect(schemaText(defaults())).toContain(FOUR);
    expect(schemaText(defaults())).toContain(EIGHT);

    for (const file of ["src/engine/consolidate.ts", "src/engine/review.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8")).toContain("${renderBodyStyleRule()}");
    }
  });

  test("manual write workflows carry the same hierarchy without a long style essay", () => {
    const save = readFileSync(join(ROOT, "skill", "wiki-save.md"), "utf8");
    expect(save).toContain(FOUR);
    expect(save).toContain(EIGHT);
    expect(save).toContain("noun phrases or telegraphic endings");

    for (const file of ["wiki-ask.md", "wiki-quiz.md", "wiki-doctor.md"]) {
      const skill = readFileSync(join(ROOT, "skill", file), "utf8");
      expect(skill).toContain(FOUR);
      expect(skill).toContain(EIGHT);
    }
    expect(readFileSync(join(ROOT, "skill", "wiki-deep.md"), "utf8")).toContain(
      "Read `~/llmwiki/skill/wiki-save.md` before starting",
    );
  });

  test("a fresh L0 teaches the same main/detail indentation", () => {
    const repo = mkdtempSync(join(tmpdir(), "llmwiki-writing-style-"));
    try {
      ensureSkeleton(repo);
      const l0 = readFileSync(join(repo, "docs", "wiki", "current-state.md"), "utf8");
      expect(l0).toContain("- <current core state in one line>");
      expect(l0).toContain("    - <necessary evidence or condition>");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
