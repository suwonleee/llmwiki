// Slim cold start (the default): on an OKF bundle the two page lists give way to one pointer at the
// generated index.md; LLMWIKI_COLDSTART=full and a pre-OKF wiki keep the page lists.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/engine/context.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

process.env.LLMWIKI_LANG = "en";
const tmps: string[] = [];
afterEach(() => {
  delete process.env.LLMWIKI_COLDSTART;
  _resetForTests();
  resetEnrollmentCache();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function okfRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "llmwiki-slim-"));
  tmps.push(base);
  const repo = enrollRepo(makeGitRepo(join(base, "repo")));
  ensureSkeleton(repo);
  writeFileSync(join(repo, "docs", "wiki", "2_milestone", "a.md"), "---\ntype: Milestone\ntitle: Alpha milestone\ndescription: d\n---\n\n- x\n");
  return repo;
}

test("slim points at index.md instead of listing recent pages", () => {
  const repo = okfRepo();
  process.env.LLMWIKI_COLDSTART = "full";
  const full = buildContext(repo);
  expect(full).toContain("recent pages in this repo's wiki");
  delete process.env.LLMWIKI_COLDSTART;
  const slim = buildContext(repo);
  expect(slim).toContain("page listing: docs/wiki/index.md");
  expect(slim).toContain('llmwiki search . "<question>" --kind wiki');
  expect(slim).not.toContain("recent pages in this repo's wiki");
});

test("full cold start never lists a retired page, under any retirement spelling", () => {
  const repo = okfRepo();
  const dir = join(repo, "docs", "wiki", "3_decision");
  writeFileSync(join(dir, "old.md"), "---\ntype: Decision\ntitle: Old decision\nstatus: deprecated\nsuperseded_by: new.md\n---\n\n- x\n");
  writeFileSync(join(dir, "older.md"), "---\ntype: Decision\ntitle: Older decision\nstatus: superseded\n---\n\n- x\n");
  writeFileSync(join(dir, "moved.md"), "---\ntype: Decision\ntitle: Moved decision\nsuperseded_by: new.md\n---\n\n- x\n");
  writeFileSync(join(dir, "new.md"), "---\ntype: Decision\ntitle: New decision\nstatus: stable\n---\n\n- x\n");
  process.env.LLMWIKI_COLDSTART = "full";
  const full = buildContext(repo);
  expect(full).toContain("New decision");
  expect(full).not.toContain("Old decision");
  expect(full).not.toContain("Older decision");
  expect(full).not.toContain("Moved decision");
});
