// Authoring timing is a cold-start contract: every session must be told to DEFER page-writing to
// the /wiki-save close-out. Mid-session authoring burns the working context on meta-work and
// produces records without the whole-session view; deferring costs nothing because capture
// preserves the transcript (observed 2026-07-27: one work session produced three mid-session
// docs(wiki) commits the close-out would have filed better, and the human chose the deferral).
// This file pins the clause in BOTH shipped rule languages so it cannot silently vanish from the
// injected rules. LLMWIKI_LANG is pinned per case — the suite must not depend on the developer's
// shell language (same lesson as init-scaffold).
//
// 2026-08-21: the rule was compressed (the cold-start block was 24.2% of a 7.7KB injection, and
// the long form duplicated the /wiki-save skill). What the cold start owes a session is now
// pinned as three CLAUSES, not one sentence — deferral, the prohibition, and the exception —
// plus the route to the detail. The detail itself is pinned where it moved to: the skill.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/engine/context.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

const tmps: string[] = [];
const savedLang = process.env.LLMWIKI_LANG;

// Cold start is fail-closed: only an ENROLLED git worktree renders rules at all.
function mkRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-authoring-"));
  tmps.push(d);
  return enrollRepo(makeGitRepo(join(d, "repo")));
}

afterEach(() => {
  _resetForTests();
  resetEnrollmentCache();
  if (savedLang === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = savedLang;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("English rules defer authoring to the close-out", () => {
  process.env.LLMWIKI_LANG = "en";
  const repo = mkRepo();
  ensureSkeleton(repo);
  const cs = buildContext(repo);

  expect(cs).toContain("Authoring happens at close-out");
  expect(cs).toContain("do NOT create or edit wiki pages");
  // the one exception must stay stated next to the prohibition, or the rule reads as absolute
  expect(cs).toContain("the human says to record now");
  // the command it defers TO must be nameable from the cold start alone
  expect(cs).toContain("/wiki-save");
  // …and so must the fallback for a harness with no skill layer, or the dropped detail is lost
  expect(cs).toContain("llmwiki conventions");
});

// The compression is only honest if the detail it removed still reaches the session that needs
// it. The cold start hands off to /wiki-save; this pins that the handoff target actually carries
// the close-out semantics the cold start used to spell out.
test("the close-out detail the cold start defers to lives in the wiki-save skill", () => {
  for (const p of ["skills/wiki-save/SKILL.md", "skill/wiki-save.md"]) {
    const body = readFileSync(new URL(`../${p}`, import.meta.url), "utf-8");
    expect(body, `${p} must carry the authoring contract`).toContain("doesn't hand-write the wiki");
    expect(body, `${p} must keep authorship with the LLM`).toContain("The LLM writes all categories");
  }
});

test("Korean rules defer authoring to the close-out", () => {
  process.env.LLMWIKI_LANG = "ko";
  const repo = mkRepo();
  ensureSkeleton(repo);
  const cs = buildContext(repo);

  expect(cs).toContain("저작은 마감에서");
  expect(cs).toContain("위키 페이지를 만들거나 고치지 않는다");
  expect(cs).toContain("지금 적어두라");
  expect(cs).toContain("/wiki-save");
  expect(cs).toContain("llmwiki conventions");
});
