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

// Assertions are on the English strings; pin the language so a shell exporting
// LLMWIKI_LANG=ko does not fail the suite.
process.env.LLMWIKI_LANG = "en";

const tmps: string[] = [];
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  _resetForTests();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// One captured-but-never-condensed session for `repo` in a redirected state dir.
function seedCapture(repo: string): void {
  const state = mk("llmwiki-nowiki-state-");
  setStateDir(state);
  const t = join(state, "sess.jsonl");
  writeFileSync(t, JSON.stringify({ type: "user", message: { role: "user", content: "작업했다" } }) + "\n");
  enqueue(t, "sess1", repo, 1);
}

test("no docs/wiki → cold-start is completely silent even with pending captures", () => {
  const repo = mk("llmwiki-nowiki-repo-");
  seedCapture(repo);
  expect(buildContext(repo)).toBe("");
});

test("the same captures surface the moment the wiki exists", () => {
  const repo = mk("llmwiki-nowiki-repo-");
  seedCapture(repo);
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  expect(buildContext(repo)).toContain("un-updated session");
});
