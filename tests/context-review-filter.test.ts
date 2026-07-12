// Cold-start 0_review surfacing: gap-queue.md / semantic-review-*.md are the LLM's own managed
// backlog (fact bookkeeping), NOT human questions — they must not count as "pending" (which nagged
// the human every session). The gap backlog gets one bounded informational line instead.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "../src/engine/context.ts";

function mkRepo(prefix: string): { repo: string; review: string } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const review = join(repo, "docs", "wiki", "0_review");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(repo, "docs", "wiki", "overview.md"), "---\ntitle: OV\n---\n\nhub", "utf-8");
  return { repo, review };
}

const GAP_QUEUE =
  "---\ntitle: Gap queue\n---\n\n## Open (2)\n\n" +
  "- [ ] (missing-concept) X page missing  <!-- gap:aaa111 absent:0 seen:2026-07-01..2026-07-01 -->\n" +
  "- [ ] (next-question) link [[a]]↔[[b]]  <!-- gap:bbb222 absent:1 seen:2026-07-01..2026-07-02 -->\n" +
  "\n## Resolved (1)\n\n" +
  "- [x] (missing-concept) done  <!-- gap:ccc333 absent:2 seen:2026-06-30..2026-07-01 -->\n";

test("gap-queue.md and semantic-review reports do not count as 0_review pending", () => {
  const { repo, review } = mkRepo("llmwiki-gapfilter-");
  writeFileSync(join(review, "gap-queue.md"), GAP_QUEUE, "utf-8");
  writeFileSync(join(review, "semantic-review-2026-07-01.md"), "## Contradiction\n(none)\n", "utf-8");

  const out = buildContext(repo);
  expect(out).not.toContain("0_review pending"); // no human-pending block at all
  expect(out).toMatch(/gap backlog|갭 백로그/); // …but the backlog is visible as one bounded line
  expect(out).toMatch(/2 open|open 2건/); // open count only (resolved excluded)
});

test("real 0_review items still surface, counted without the managed files", () => {
  const { repo, review } = mkRepo("llmwiki-gapfilter2-");
  writeFileSync(join(review, "gap-queue.md"), GAP_QUEUE, "utf-8");
  writeFileSync(join(review, "2026-07-01-direction-shift.md"), "---\ntitle: Direction?\n---\nQ. confirm?\n", "utf-8");

  const out = buildContext(repo);
  expect(out).toContain("0_review pending 1"); // only the human question counts
  expect(out).toContain("Direction?");
  expect(out).toMatch(/gap backlog|갭 백로그/);
});

test("empty/fully-resolved gap queue emits no backlog line", () => {
  const { repo, review } = mkRepo("llmwiki-gapfilter3-");
  const resolvedOnly =
    "---\ntitle: Gap queue\n---\n\n## Open (0)\n\n(none)\n\n## Resolved (1)\n\n" +
    "- [x] (missing-concept) done  <!-- gap:ccc333 absent:2 seen:2026-06-30..2026-07-01 -->\n";
  writeFileSync(join(review, "gap-queue.md"), resolvedOnly, "utf-8");

  const out = buildContext(repo);
  expect(out).not.toMatch(/gap backlog|갭 백로그/);
  expect(out).not.toContain("0_review pending");
});
