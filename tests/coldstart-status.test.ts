import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetStatus, hasL0Content } from "../src/engine/coldstart-status.ts";
import { buildContext } from "../src/engine/context.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { TOPIC_BUDGET } from "../src/engine/budgets.ts";
import { enqueue, setStateDir, stateDir } from "../src/engine/capture.ts";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const roots: string[] = [];
const oldLang = process.env.LLMWIKI_LANG;
afterEach(() => {
  if (oldLang === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = oldLang;
  _resetForTests();
  resetEnrollmentCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo(): string {
  const root = tempDir("llmwiki-coldstart-budget-");
  roots.push(root);
  return enrollRepo(makeGitRepo(join(root, "repo")));
}

test("status below budget stays byte-identical, including separators and protected context", () => {
  const lines = ["L0", "", "status", "", "operating rules", "question"];
  expect(budgetStatus(lines, [{ start: 2, end: 4, priority: 0 }], false)).toBe(lines.join("\n"));
});

test("budget folds low-priority whole blocks and never truncates L0, rules or human questions", () => {
  const protectedLine = "human question ".repeat(100);
  const lines = ["L0-keep", protectedLine, "r".repeat(400), "x".repeat(400), "operating-rules-keep"];
  const out = budgetStatus(lines, [
    { start: 2, end: 3, priority: 9 }, { start: 3, end: 4, priority: 0 },
  ], false);
  expect(out).toContain(protectedLine);
  expect(out).toContain("L0-keep");
  expect(out).toContain("operating-rules-keep");
  expect(out).toContain("r".repeat(400));
  expect(out).not.toContain("x".repeat(400));
  expect(out).toContain("1 status item(s) folded");
  expect(out).toContain("llmwiki status .");
  expect(out.replace(protectedLine, "").replace("L0-keep", "").replace("operating-rules-keep", "").length).toBeLessThanOrEqual(600);
});

test("one huge status folds completely rather than silently slicing its content", () => {
  const out = budgetStatus(["do-not-cut", "x".repeat(2000)], [{ start: 1, end: 2, priority: 9 }], true);
  expect(out).toContain("do-not-cut");
  expect(out).toContain("상태 1건 접음");
  expect(out).not.toContain("xxxx");
});

for (const lang of ["en", "ko", "ja", "zh"]) {
  test("init " + lang + " L0 stays un-injected until a real prose line exists", () => {
    process.env.LLMWIKI_LANG = lang;
    _resetForTests();
    const root = repo();
    ensureSkeleton(root);
    const before = buildContext(root);
    expect(before).toMatch(/Wiki is still empty|아직 위키가 비어 있음/);
    expect(before).not.toContain("L0)\\n");
    expect(before).not.toContain("placeholder");
    expect(before).not.toContain("<current core state");
    appendFileSync(join(root, "docs/wiki/current-state.md"), "\n- REAL-CURRENT-STATE\n");
    const after = buildContext(root);
    expect(after).toContain("REAL-CURRENT-STATE");
    expect(after).toContain("(cold-start)");
    expect(after).not.toMatch(/Wiki is still empty|아직 위키가 비어 있음/);
  });
}

test("frontmatter, template headings and guidance alone contain no current knowledge", () => {
  expect(hasL0Content("---\n---\n")).toBe(false);
  expect(hasL0Content("---\ntitle: Current State\ndescription: template guidance\n---\n")).toBe(false);
  expect(hasL0Content("## Now (TL;DR)\n\n- <current core state in one line>\n")).toBe(false);
  expect(hasL0Content("## Now (TL;DR)\n\n- Actually shipped\n")).toBe(true);
});

test("a long human queue retains all titles outside the budget, with paths folded", () => {
  const root = repo();
  const dir = join(root, "docs/wiki/0_review");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "docs/wiki/current-state.md"), "## Now\n\n- REAL-L0\n");
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, "question-" + i + ".md"), "---\ntitle: QUESTION-" + i + "\n---\nQ. choose\n");
  }
  const out = buildContext(root);
  expect(out).toContain("0_review pending 20");
  for (let i = 0; i < 20; i++) expect(out).toContain("QUESTION-" + i + "\n");
  expect(out).not.toContain(" -> ");
  expect(out).toContain("Surface these to the user now");
  expect(out).toContain("REAL-L0");
});

test("topic prose over the shared lint threshold joins the single maintenance signal", () => {
  process.env.LLMWIKI_LANG = "en";
  _resetForTests();
  const root = repo();
  ensureSkeleton(root);
  const path = join(root, "docs/wiki/5_topic/long-topic.md");
  const write = (n: number) => writeFileSync(path, "---\ntype: Topic\ntitle: Long topic\n---\n" + "x".repeat(n));
  write(TOPIC_BUDGET);
  expect(buildContext(root, { statusBudget: Infinity })).not.toContain("oversized topics");
  write(TOPIC_BUDGET + 1);
  expect(buildContext(root, { statusBudget: Infinity })).toContain("oversized topics 1");
});

test("cold-start reports pending count without opening transcript recaps", () => {
  process.env.LLMWIKI_LANG = "en";
  _resetForTests();
  const priorState = stateDir();
  const base = tempDir("llmwiki-coldstart-no-transcript-");
  roots.push(base);
  setStateDir(join(base, "state"));
  const recap = spyOn(claudeJsonlSource, "recapFor").mockImplementation(() => "PRIVATE-TRANSCRIPT-SENTINEL");
  try {
    const root = repo();
    mkdirSync(join(root, "docs/wiki"), { recursive: true });
    writeFileSync(join(root, "docs/wiki/current-state.md"), "## Now\n\n- REAL-L0\n");
    const transcript = join(base, "synthetic-session.jsonl");
    writeFileSync(transcript, JSON.stringify({
      type: "user", message: { role: "user", content: "PRIVATE-TRANSCRIPT-SENTINEL" },
    }) + "\n");
    enqueue(transcript, "synthetic-session", root, 1, "claude-jsonl");

    const out = buildContext(root, { statusBudget: Infinity });
    expect(out).toContain("1 un-updated session(s) in this repo");
    expect(out).toContain("REAL-L0");
    expect(out).not.toContain("PRIVATE-TRANSCRIPT-SENTINEL");
    expect(recap).toHaveBeenCalledTimes(0);
  } finally {
    recap.mockRestore();
    setStateDir(priorState);
  }
});
