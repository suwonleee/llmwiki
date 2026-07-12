// context-audit — advisory hygiene check for agent-config files. Read-only; skip-if-absent.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditContext, auditNudge } from "../src/engine/context-audit.ts";

// UI-string assertions below expect English output; pin the language so a shell
// exporting LLMWIKI_LANG=ko does not fail the suite.
process.env.LLMWIKI_LANG = "en";

describe("context-audit", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-ctxaudit-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("absent config files → no findings (skip, never created)", () => {
    expect(auditContext(root)).toEqual([]);
    expect(auditNudge(root)).toBe("");
  });

  test("lean warning-only AGENTS.md → clean", () => {
    writeFileSync(
      join(root, "AGENTS.md"),
      "# AGENTS.md\n\n## 🚨 랜드마인\n- Use `uv`, not pip.\n- Run tests with `--no-cache` or fixtures give false positives.\n",
    );
    expect(auditContext(root)).toEqual([]);
  });

  test("bloated AGENTS.md → flags overview sections + size", () => {
    const big = [
      "# AGENTS.md — Project Guide",
      "## Tech Stack",
      "- Python, LangGraph, AWS Bedrock",
      "## Directory Structure",
      "```\nsrc/\n  agents/\n```",
      "## Code Style",
      "snake_case files, PascalCase classes.",
      "## Build and Run",
      "pip install -r requirements.txt",
      "lorem ipsum ".repeat(700), // push over the size threshold
    ].join("\n\n");
    writeFileSync(join(root, "AGENTS.md"), big);
    const f = auditContext(root);
    expect(f.length).toBe(1);
    expect(f[0]!.file).toBe("AGENTS.md");
    // both an overview-section finding and a size finding
    expect(f[0]!.issues.some((i) => /overview|grep/i.test(i))).toBe(true);
    expect(f[0]!.issues.some((i) => /token/i.test(i))).toBe(true);
    expect(auditNudge(root)).toContain("context-audit");
  });

  test("overview config + existing wiki L0 → flags duplication of current-state", () => {
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    writeFileSync(join(root, "docs", "wiki", "current-state.md"), "# L0\n");
    writeFileSync(
      join(root, "CLAUDE.md"),
      "# CLAUDE.md\n\n## Architecture\nSee docs/wiki/current-state.md for status.\n\n## Tech Stack\nstuff\n",
    );
    const f = auditContext(root);
    expect(f.length).toBe(1);
    expect(f[0]!.issues.some((i) => /current-state|duplicate|중복/i.test(i))).toBe(true);
  });

  test("public-template neutral: no opinionated terminology flagging", () => {
    // a warning-only file that happens to use words like "distill" must stay clean — the public
    // template doesn't impose our local wording preferences on adopters.
    writeFileSync(join(root, "AGENTS.md"), "# A\n\n## 🚨 warning\n- Use the distill step before commit.\n");
    expect(auditContext(root)).toEqual([]);
  });

  test("read-only: audit never mutates the file", () => {
    const p = join(root, "AGENTS.md");
    const original = "# A\n\n## Architecture\n" + "x ".repeat(900);
    writeFileSync(p, original);
    auditContext(root);
    expect(require("node:fs").readFileSync(p, "utf-8")).toBe(original);
  });
});
