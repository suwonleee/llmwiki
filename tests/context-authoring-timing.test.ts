// Authoring timing is a cold-start contract: rule 3 tells every session to DEFER page-writing to
// the /wiki-save close-out. Mid-session authoring burns the working context on meta-work and
// produces records without the whole-session view; deferring costs nothing because capture
// preserves the transcript (observed 2026-07-27: one work session produced three mid-session
// docs(wiki) commits the close-out would have filed better, and the human chose the deferral).
// This file pins the clause in BOTH shipped rule languages so it cannot silently vanish from the
// injected rules. LLMWIKI_LANG is pinned per case — the suite must not depend on the developer's
// shell language (same lesson as init-scaffold).
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

  expect(cs).toContain("Authoring happens at close-out, not mid-session");
  expect(cs).toContain("do NOT create or edit wiki pages");
  // the one exception must stay stated next to the prohibition, or the rule reads as absolute
  expect(cs).toContain("the human explicitly asks to record now");
  // and the close-out semantics the clause defers TO must survive the edit
  expect(cs).toContain("humans don't hand-write docs");
});

test("Korean rules defer authoring to the close-out", () => {
  process.env.LLMWIKI_LANG = "ko";
  const repo = mkRepo();
  ensureSkeleton(repo);
  const cs = buildContext(repo);

  expect(cs).toContain("저작은 세션 도중이 아니라 마감에서");
  expect(cs).toContain("위키 페이지를 만들거나 고치지 않는다");
  expect(cs).toContain("지금 적어두라");
});
