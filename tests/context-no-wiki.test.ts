// Un-adopted repos are silent — the pending-backlog nag is gated on wiki presence.
//
// The daemon captures every repo in the background so adopting later loses nothing, but a repo
// that never adopted the wiki (no docs/wiki/) must not pay an attention tax: without the gate,
// any directory ever chatted in greets each session with a growing "N un-updated sessions" nag
// (observed 2026-07-21: a wiki-less home directory opened every session with a 20-session
// backlog recommendation). Contract under test: no docs/wiki → buildContext is COMPLETELY
// empty; the very same captures surface the moment the wiki exists.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/engine/context.ts";
import { setStateDir, enqueue } from "../src/engine/capture.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

// Assertions are on the English strings; pin the language so a shell exporting
// LLMWIKI_LANG=ko does not fail the suite.
process.env.LLMWIKI_LANG = "en";

const tmps: string[] = [];
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
// An enrolled repository: a real git worktree that has been through `llmwiki init`'s enrollment
// step. Cold start is fail-closed, so this is now the baseline for any test that expects output.
function mkRepo(prefix: string): string {
  return enrollRepo(makeGitRepo(join(mk(prefix), "repo")));
}

afterEach(() => {
  _resetForTests();
  resetEnrollmentCache();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One captured-but-never-condensed session for `repo` in a redirected state dir.
function seedCapture(repo: string): void {
  const base = mk("llmwiki-nowiki-state-");
  setStateDir(join(base, "state")); // llmwiki's state root holds only llmwiki's own files
  const t = join(base, "sess.jsonl");
  writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "작업했다" } }) + "\n");
  enqueue(t, "sess1", repo, 1);
}

test("no docs/wiki → cold-start is completely silent even with pending captures", () => {
  const repo = mkRepo("llmwiki-nowiki-repo-");
  seedCapture(repo);
  expect(buildContext(repo)).toBe("");
});

test("the same captures surface the moment the wiki exists", () => {
  const repo = mkRepo("llmwiki-nowiki-repo-");
  seedCapture(repo);
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  expect(buildContext(repo)).toContain("un-updated session");
});

// The wiki-presence gate above answers "did this project adopt llmwiki?". It cannot answer "did
// the human on THIS machine agree to run llmwiki here?" — because docs/wiki/ arrives with any
// clone. A complete, entirely convincing wiki must therefore stay silent until enrollment.
test("a COMPLETE wiki in an unenrolled repository emits exactly zero bytes", () => {
  const repo = makeGitRepo(join(mk("llmwiki-unenrolled-"), "repo")); // git, but never `init`ed
  mkdirSync(join(repo, "docs", "wiki", "0_review"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wiki", "current-state.md"),
    "---\ntitle: Current State\n---\n\n## Now\n\n- SENTINEL-L0-CONTENT\n",
    "utf-8",
  );
  writeFileSync(
    join(repo, "docs", "wiki", "0_review", "question.md"),
    "---\ntitle: SENTINEL-REVIEW-ITEM\n---\n\nQ. anything?\n",
    "utf-8",
  );
  seedCapture(repo);

  const out = buildContext(repo);
  expect(out).toBe(""); // not a header, not a nag, not a newline
  expect(out).not.toContain("SENTINEL");

  // …and enrolling the SAME repository turns all of it on, intact.
  enrollRepo(repo);
  const after = buildContext(repo);
  expect(after).toContain("SENTINEL-L0-CONTENT");
  expect(after).toContain("SENTINEL-REVIEW-ITEM");
});

test("a plain (non-git) directory can never be enrolled, so it stays silent", () => {
  const repo = mk("llmwiki-nongit-");
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), "---\ntitle: CS\n---\n\nSENTINEL\n", "utf-8");
  seedCapture(repo);
  expect(buildContext(repo)).toBe("");
});
