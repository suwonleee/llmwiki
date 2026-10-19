// P2: gap-queue lifecycle — extract review findings → track → self-close (loop-until-dry). LLM-0.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractGapsFromReview,
  parseQueue,
  refreshGapQueue,
  renderQueue,
  RESOLVE_AFTER,
  type Gap,
} from "../src/engine/gaps.ts";
import { parseYamlBlock, splitFrontmatter } from "../src/engine/okf.ts";

const tempRoots: string[] = [];

function makeQueueRoot(): { readonly root: string; readonly reviewPath: string; readonly queuePath: string } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-gaps-"));
  tempRoots.push(root);
  const queueDir = join(root, "docs", "wiki", "0_review");
  mkdirSync(queueDir, { recursive: true });
  return {
    root,
    reviewPath: join(queueDir, "semantic-review-2026-07-01.md"),
    queuePath: join(queueDir, "gap-queue.md"),
  };
}

function fullReport(body: string, scope = "scope-1"): string {
  return `---\nx-llmwiki-review: { total: 1, included: 1, bounded: false, scope_sha256: ${scope} }\n---\n${body}`;
}
function reviewWithGaps(count: number): string {
  return fullReport(`## Missing concept page\n${Array.from({ length: count }, (_, index) => `- Gap ${index + 1}`).join("\n")}\n`);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REVIEW_EN = `---
title: review
x-llmwiki-review: { total: 1, included: 1, bounded: false, scope_sha256: scope-1 }
---
## Contradiction
(none)
## Stale claim
(none)
## Missing concept page
- A page for the **ArtifactStore** seam is referenced in 3 sessions but missing.
- "retry policy" recurs with no page.
## Cross-references & next questions
- Should [[2_milestone/x]] link to [[3_decision/y]]?
## Grounding & citations
(none)
`;

test("extractGapsFromReview pulls missing-concept + next-question bullets, skips (none)", () => {
  const g = extractGapsFromReview(REVIEW_EN);
  expect(g.length).toBe(3);
  expect(g.filter((x) => x.type === "missing-concept").length).toBe(2);
  expect(g.filter((x) => x.type === "next-question").length).toBe(1);
  expect(g.some((x) => x.text.includes("ArtifactStore"))).toBe(true);
});

test("Korean headings are matched too", () => {
  const ko = `## 모순\n(없음)\n## 개념 누락\n- 캐시 무효화 정책 페이지 없음\n## 교차참조·다음 질문\n- [[a]]와 [[b]] 연결?\n`;
  const g = extractGapsFromReview(ko);
  expect(g.length).toBe(2);
  expect(g.map((gap) => gap.type)).toEqual(["missing-concept", "next-question"]);
});

test("render → parse round-trips state (hash, absent, status)", () => {
  const gaps: Gap[] = [
    { hash: "abc123", type: "missing-concept", text: "X page", status: "open", absent: 0, firstSeen: "2026-06-30", lastSeen: "2026-06-30" },
    { hash: "def456", type: "next-question", text: "link a,b?", status: "resolved", absent: 2, firstSeen: "2026-06-28", lastSeen: "2026-06-29" },
  ];
  const md = renderQueue(gaps, "2026-06-30");
  const back = parseQueue(md);
  expect(back.length).toBe(2);
  expect(back.find((gap) => gap.hash === "abc123")).toMatchObject({ status: "open", absent: 0 });
  expect(back.find((gap) => gap.hash === "def456")).toMatchObject({ status: "resolved", absent: 2 });
});

test("the queue page is an OKF Gap Queue and still parses back", () => {
  const gaps: Gap[] = [
    { hash: "abc123", type: "missing-concept", text: "X page", status: "open", absent: 0, firstSeen: "2026-06-30", lastSeen: "2026-06-30" },
  ];
  const md = renderQueue(gaps, "2026-06-30", "en", "2026-06-30T10:00:00+09:00");
  const { block } = splitFrontmatter(md);
  const fm = parseYamlBlock(block!);
  expect(fm.error).toBeNull();
  expect(fm.data.type).toBe("Gap Queue");
  expect(fm.data.status).toBe("stable");
  expect(fm.data.sources).toEqual([{ resource: "semantic-lint" }]);
  expect((fm.data.generated as Record<string, unknown>).at).toBe("2026-06-30T10:00:00+09:00");
  for (const k of ["domain", "source", "updated"]) expect(fm.data[k]).toBeUndefined();
  expect(parseQueue(md).map((g) => g.hash)).toEqual(["abc123"]);
});

test("RESOLVE_AFTER is the loop-until-dry threshold (>=2)", () => {
  expect(RESOLVE_AFTER).toBeGreaterThanOrEqual(2);
});

test("refreshGapQueue reopens an identity that reappears after resolution", () => {
  // Given: a review queue with one emitted gap.
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, REVIEW_EN, "utf-8");

  // When: the gap is absent enough times to resolve, then appears again.
  refreshGapQueue(root, "2026-07-01");
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-2"), "utf-8");
  refreshGapQueue(root, "2026-07-02");
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-3"), "utf-8");
  refreshGapQueue(root, "2026-07-03");
  writeFileSync(reviewPath, REVIEW_EN, "utf-8");
  const result = refreshGapQueue(root, "2026-07-04");

  // Then: the original deterministic identity is open again, not duplicated as resolved work.
  expect(result.open).toBe(3);
  expect(existsSync(queuePath)).toBe(true);
  expect(parseQueue(readFileSync(queuePath, "utf-8")).every((gap) => gap.status === "open")).toBe(true);
});

test("refreshGapQueue bounds resolved output while retaining an old hidden identity for reopen", () => {
  // Given: more than one hundred gaps that resolve after two absent reviews.
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, reviewWithGaps(101), "utf-8");
  refreshGapQueue(root, "2026-07-01");
  const initialGaps = parseQueue(readFileSync(queuePath, "utf-8"));
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-2"), "utf-8");
  refreshGapQueue(root, "2026-07-02");

  // When: the second absence resolves all gaps, then the oldest gap reappears.
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-3"), "utf-8");
  refreshGapQueue(root, "2026-07-03");
  const resolvedQueue = readFileSync(queuePath, "utf-8");
  const visibleResolved = parseQueue(resolvedQueue);
  const hiddenGap = initialGaps.find((gap) => !visibleResolved.some((visible) => visible.hash === gap.hash));
  expect(hiddenGap).toBeDefined();
  if (hiddenGap === undefined) return;
  writeFileSync(reviewPath, `## Missing concept page\n- ${hiddenGap.text}\n`, "utf-8");
  const reopened = refreshGapQueue(root, "2026-07-04");

  // Then: only the default recent window is human-facing and the old hash reopens.
  expect(resolvedQueue).toContain("## Resolved (101 total; showing 20 most recent)");
  expect(parseQueue(resolvedQueue)).toHaveLength(20);
  expect(existsSync(join(root, ".llmwiki", "gap-queue-state.json"))).toBe(true);
  expect(reopened.open).toBe(1);
  expect(parseQueue(readFileSync(queuePath, "utf-8")).some((gap) => gap.hash === hiddenGap.hash && gap.status === "open")).toBe(true);
});

test("refreshGapQueue rebuilds absent resolved state without dropping open work", () => {
  // Given: a bounded queue whose oldest resolved identity is only in side state.
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, reviewWithGaps(101), "utf-8");
  refreshGapQueue(root, "2026-07-01");
  const initialGaps = parseQueue(readFileSync(queuePath, "utf-8"));
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-2"), "utf-8");
  refreshGapQueue(root, "2026-07-02");
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-3"), "utf-8");
  refreshGapQueue(root, "2026-07-03");
  const visibleResolved = parseQueue(readFileSync(queuePath, "utf-8"));
  const hiddenGap = initialGaps.find((gap) => !visibleResolved.some((visible) => visible.hash === gap.hash));
  expect(hiddenGap).toBeDefined();
  if (hiddenGap === undefined) return;
  rmSync(join(root, ".llmwiki", "gap-queue-state.json"));

  // When: the side state is absent and the old gap appears in the next review.
  writeFileSync(reviewPath, `## Missing concept page\n- ${hiddenGap.text}\n`, "utf-8");
  const rebuilt = refreshGapQueue(root, "2026-07-04");

  // Then: the deterministic hash is open and a rebuildable state seam is restored.
  expect(rebuilt.open).toBe(1);
  expect(parseQueue(readFileSync(queuePath, "utf-8")).some((gap) => gap.hash === hiddenGap.hash && gap.status === "open")).toBe(true);
  expect(existsSync(join(root, ".llmwiki", "gap-queue-state.json"))).toBe(true);
});

test("refreshGapQueue skips a malformed generated queue instead of overwriting it", () => {
  // Given: a generated queue that is damaged before the next refresh.
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, REVIEW_EN, "utf-8");
  refreshGapQueue(root, "2026-07-01");
  const malformed = "## Open (broken)\n- [ ] (missing-concept) missing marker\n";
  writeFileSync(queuePath, malformed, "utf-8");

  // When: the real refresh path sees the malformed queue.
  const result = refreshGapQueue(root, "2026-07-02");

  // Then: it fails closed and preserves the damaged file for recovery.
  expect(result.verdict).toBe("skip");
  expect(readFileSync(queuePath, "utf-8")).toBe(malformed);
});

test("the same report cannot advance absence twice, even after a date or generated-stamp change", () => {
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, reviewWithGaps(1));
  refreshGapQueue(root, "2026-07-01");
  const absent = fullReport("## Missing concept page\n(none)\n", "scope-2");
  writeFileSync(reviewPath, absent);
  expect(refreshGapQueue(root, "2026-07-02").absenceAging).toBe("advanced");
  expect(refreshGapQueue(root, "2026-07-03").absenceAging).toBe("duplicate-report");
  const renamed = join(root, "docs/wiki/0_review/semantic-review-2026-07-04.md");
  writeFileSync(renamed, absent.replace("---\n", "---\ngenerated: { at: '2026-07-04' }\n"));
  utimesSync(renamed, 2_000_000_000, 2_000_000_000);
  expect(refreshGapQueue(root, "2026-07-04").absenceAging).toBe("duplicate-report");
  expect(parseQueue(readFileSync(queuePath, "utf8"))[0]).toMatchObject({ status: "open", absent: 1 });
  writeFileSync(renamed, fullReport("## Missing concept page\n(none)\n", "scope-3"));
  utimesSync(renamed, 2_000_000_001, 2_000_000_001);
  expect(refreshGapQueue(root, "2026-07-05").resolved).toBe(1);
});

test("partial and unscoped reviews can add findings but cannot age existing gaps", () => {
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, reviewWithGaps(1));
  refreshGapQueue(root, "2026-07-01");
  for (const [i, meta] of ["x-llmwiki-review: { total: 100, included: 40, bounded: true }", "", "x-llmwiki-review: { total: 100, included: 40, bounded: false }"].entries()) {
    writeFileSync(reviewPath, `---\n${meta}\n---\n## Missing concept page\n- Another gap ${i}\n`);
    expect(refreshGapQueue(root, `2026-07-0${i + 2}`).absenceAging).toBe("partial-or-unknown-scope");
  }
  const gaps = parseQueue(readFileSync(queuePath, "utf8"));
  expect(gaps).toHaveLength(4);
  expect(gaps.every(g => g.status === "open" && g.absent === 0)).toBe(true);
});

test("latest report follows actual modification time instead of lexical hash order", () => {
  const { root, reviewPath, queuePath } = makeQueueRoot();
  const highHashOld = join(root, "docs/wiki/0_review/semantic-review-2026-07-01-ffffffff.md");
  const lowHashNew = join(root, "docs/wiki/0_review/semantic-review-2026-07-01-00000000.md");
  writeFileSync(highHashOld, fullReport("## Missing concept page\n- Old stale finding\n"));
  writeFileSync(lowHashNew, fullReport("## Missing concept page\n- New latest finding\n"));
  utimesSync(highHashOld, 1_000_000_000, 1_000_000_000);
  utimesSync(lowHashNew, 1_000_000_001, 1_000_000_001);
  refreshGapQueue(root, "2026-07-01");
  expect(readFileSync(queuePath, "utf8")).toContain("New latest finding");
  expect(readFileSync(queuePath, "utf8")).not.toContain("Old stale finding");
});

test("check-only calls do not consume a review receipt", () => {
  const { root, reviewPath, queuePath } = makeQueueRoot();
  writeFileSync(reviewPath, reviewWithGaps(1));
  refreshGapQueue(root, "2026-07-01");
  writeFileSync(reviewPath, fullReport("## Missing concept page\n(none)\n", "scope-2"));
  expect(refreshGapQueue(root, "2026-07-02", { check: true }).absenceAging).toBe("advanced");
  expect(parseQueue(readFileSync(queuePath, "utf8"))[0]?.absent).toBe(0);
  expect(refreshGapQueue(root, "2026-07-02").absenceAging).toBe("advanced");
  expect(parseQueue(readFileSync(queuePath, "utf8"))[0]?.absent).toBe(1);
});
