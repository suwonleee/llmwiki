import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaText } from "../src/engine/autoupdate.ts";
import { defaults, _resetForTests } from "../src/engine/config.ts";
import { ensureSkeleton } from "../src/engine/update.ts";

const ROOT = join(import.meta.dir, "..");
const FOUR = "`    -`";
const SECTION = "`## 1. <label>`";
const SUBSECTION = "`### 1-1. <label>`";
const EIGHT = "`        -`";

describe("numbered-section wiki writing contract", () => {
  test("all engine-side model writers consume the shared structure rule", () => {
    const schema = schemaText(defaults());
    expect(schema).toContain(SECTION); // numbered sections carry the skeleton
    expect(schema).toContain(SUBSECTION);
    expect(schema).toContain(FOUR); // and the bullet hierarchy lives inside them
    expect(schema).toContain(EIGHT);
    expect(schema).toContain("more than three items"); // no enumeration crammed into one line

    for (const file of ["src/engine/consolidate.ts", "src/engine/review.ts"]) {
      expect(readFileSync(join(ROOT, file), "utf8")).toContain("${renderBodyStyleRule()}");
    }
  });

  test("manual write workflows carry the same hierarchy without a long style essay", () => {
    const save = readFileSync(join(ROOT, "skill", "wiki-save.md"), "utf8");
    expect(save).toContain(SECTION);
    expect(save).toContain(SUBSECTION);
    expect(save).toContain(FOUR);
    expect(save).toContain(EIGHT);
    expect(save).toContain("noun phrases or telegraphic endings");
    expect(save).toContain("## 1. "); // the page template itself shows the shape

    for (const file of ["wiki-ask.md", "wiki-doctor.md"]) {
      const skill = readFileSync(join(ROOT, "skill", file), "utf8");
      expect(skill).toContain("## 1."); // the numbered-section shape, however each skill words it
      expect(skill).toContain(FOUR);
      expect(skill).toContain(EIGHT);
    }
    // the quiz notebook is per-question: one numbered section each, details underneath
    const quiz = readFileSync(join(ROOT, "skill", "wiki-quiz.md"), "utf8");
    expect(quiz).toContain("## 1. <the question>");
    expect(quiz).toContain(FOUR);
    expect(readFileSync(join(ROOT, "skill", "wiki-deep.md"), "utf8")).toContain(
      "Read `~/llmwiki/skill/wiki-save.md` before starting",
    );
  });

  test("the shipped example wiki demonstrates the contract it documents", () => {
    for (const file of [
      "examples/sample-wiki/5_topic/transaction-import.md",
      "examples/sample-wiki/3_decision/2026-01-12-storage-sqlite-over-json.md",
    ]) {
      const page = readFileSync(join(ROOT, file), "utf8");
      expect(page).toMatch(/^## 1\. /m);
      expect(page).toMatch(/^    - /m);
    }
  });

  // Pinned per language on purpose: this assertion used to pass only because another test file
  // happened to set LLMWIKI_LANG=en first in the same bun process.
  test("a fresh L0 teaches the main/detail indentation in the wiki's own language", () => {
    const before = process.env.LLMWIKI_LANG;
    const read = (lang: string): string => {
      process.env.LLMWIKI_LANG = lang;
      _resetForTests();
      const repo = mkdtempSync(join(tmpdir(), `llmwiki-writing-style-${lang}-`));
      try {
        ensureSkeleton(repo);
        return readFileSync(join(repo, "docs", "wiki", "current-state.md"), "utf8");
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    };
    try {
      const en = read("en");
      expect(en).toContain("- <current core state in one line>");
      expect(en).toContain("    - <necessary evidence or condition>");

      const ko = read("ko");
      expect(ko).toContain("- <현재 핵심 상태 한 줄>");
      expect(ko).toContain("    - <필요한 근거·조건>");
    } finally {
      if (before === undefined) delete process.env.LLMWIKI_LANG;
      else process.env.LLMWIKI_LANG = before;
      _resetForTests();
    }
  });
});
