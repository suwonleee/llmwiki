import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWikiCleanReview,
  commitWikiClean,
  planWikiClean,
} from "../src/engine/wiki-clean.ts";

const TODAY = "2026-07-23";
const roots: string[] = [];

function page(options: { readonly status: string; readonly tier?: string; readonly date: string; readonly body: string }): string {
  return [
    "---",
    "title: Archive candidate",
    "description: Safe lifecycle fixture.",
    `date: ${options.date}`,
    "tags: [archive, fixture]",
    `status: ${options.status}`,
    ...(options.tier === undefined ? [] : [`tier: ${options.tier}`]),
    "---",
    "",
    options.body,
    "",
  ].join("\n");
}

function mkRepo(): { readonly root: string; readonly auto: string; readonly ambiguous: string } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-clean-"));
  roots.push(root);
  const insight = join(root, "docs", "wiki", "4_insight");
  mkdirSync(insight, { recursive: true });
  const auto = join(insight, "eligible.md");
  const ambiguous = join(insight, "ambiguous.md");
  writeFileSync(auto, page({ status: "ready", date: "2025-01-01", body: "preserved auto body" }), "utf8");
  writeFileSync(ambiguous, page({ status: "pending", date: "2025-01-01", body: "preserved ambiguous body" }), "utf8");
  return { root, auto, ambiguous };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("wiki clean", () => {
  test("plans protected, automatic, and ambiguous candidates without changing wiki bytes", () => {
    // Given: an old eligible page and an invalid-status page.
    const { root, auto, ambiguous } = mkRepo();
    const autoBefore = readFileSync(auto, "utf8");
    const ambiguousBefore = readFileSync(ambiguous, "utf8");

    // When: maintenance plans cleanup in dry-run mode.
    const result = planWikiClean(root, { today: TODAY });

    // Then: it reports classifications but does not mutate source-of-truth markdown.
    expect(result.automatic).toHaveLength(1);
    expect(result.automatic[0]?.action).toBe("cold");
    expect(result.ambiguous).toHaveLength(1);
    expect(readFileSync(auto, "utf8")).toBe(autoBefore);
    expect(readFileSync(ambiguous, "utf8")).toBe(ambiguousBefore);
  });

  test("commits only reversible tier frontmatter and one review batch", () => {
    // Given: a deterministic cleanup plan.
    const { root, auto, ambiguous } = mkRepo();
    const autoBefore = readFileSync(auto, "utf8");
    const ambiguousBefore = readFileSync(ambiguous, "utf8");

    // When: the explicit commit path runs.
    const result = commitWikiClean(root, { today: TODAY });

    // Then: the automatic page keeps its body, while ambiguity is recorded for human review.
    expect(readFileSync(auto, "utf8")).toContain("tier: cold");
    expect(readFileSync(auto, "utf8")).toContain("preserved auto body");
    expect(readFileSync(ambiguous, "utf8")).toBe(ambiguousBefore);
    const reviewPath = result.reviewPath;
    if (reviewPath === null) throw new Error("cleanup review path is missing");
    expect(reviewPath).toBe(join(root, "docs", "wiki", "0_review", "wiki-clean-2026-07-23.md"));
    expect(readFileSync(reviewPath, "utf8")).toContain("kind: cleanup");
    expect(readFileSync(reviewPath, "utf8")).toContain("source: wiki-clean");
    expect(autoBefore).toContain("preserved auto body");
  });

  test("refuses unanswered or stale review batches without mutating any candidate", () => {
    // Given: a committed cleanup review batch with an unanswered candidate.
    const { root, auto, ambiguous } = mkRepo();
    const result = commitWikiClean(root, { today: TODAY });
    const reviewPath = result.reviewPath;
    if (reviewPath === null) throw new Error("cleanup review path is missing");
    const autoBefore = sha256(auto);
    const ambiguousBefore = sha256(ambiguous);

    // When / Then: unanswered work refuses atomically.
    expect(() => applyWikiCleanReview(root, { reviewPath })).toThrow("unanswered");
    expect(sha256(auto)).toBe(autoBefore);
    expect(sha256(ambiguous)).toBe(ambiguousBefore);

    // When / Then: a page hash change also refuses atomically.
    const candidateId = /candidate: ([0-9a-f]{12})/.exec(readFileSync(reviewPath, "utf8"))?.[1];
    if (candidateId === undefined) throw new Error("cleanup review candidate is missing");
    writeFileSync(ambiguous, `${readFileSync(ambiguous, "utf8")}changed after review\n`, "utf8");
    writeFileSync(reviewPath, readFileSync(reviewPath, "utf8").replace("A. accepted IDs: (none)", `A. accepted IDs: ${candidateId}`), "utf8");
    expect(() => applyWikiCleanReview(root, { reviewPath })).toThrow("stale");
    expect(sha256(auto)).toBe(autoBefore);
  });

  test("applies an answered unchanged review candidate and removes the completed batch", () => {
    // Given: a generated cleanup review with one ambiguous page.
    const { root, ambiguous } = mkRepo();
    const result = commitWikiClean(root, { today: TODAY });
    const reviewPath = result.reviewPath;
    if (reviewPath === null) throw new Error("cleanup review path is missing");
    const candidateId = /candidate: ([0-9a-f]{12})/.exec(readFileSync(reviewPath, "utf8"))?.[1];
    if (candidateId === undefined) throw new Error("cleanup review candidate is missing");
    writeFileSync(reviewPath, readFileSync(reviewPath, "utf8").replace("A. accepted IDs: (none)", `A. accepted IDs: ${candidateId}`), "utf8");

    // When: the explicit apply path receives the accepted ID.
    const applied = applyWikiCleanReview(root, { reviewPath });

    // Then: the reversible warm tier is applied, body survives, and the review closes.
    expect(applied.applied).toEqual([candidateId]);
    expect(readFileSync(ambiguous, "utf8")).toContain("tier: warm");
    expect(readFileSync(ambiguous, "utf8")).toContain("preserved ambiguous body");
    expect(existsSync(reviewPath)).toBe(false);
  });

  test("the default date works — every other test pins `today`, so nothing else exercises it", () => {
    const { root } = mkRepo();
    const result = commitWikiClean(root); // no options: the caller's normal call
    expect(result.reviewPath).toMatch(/wiki-clean-\d{4}-\d{2}-\d{2}\.md$/);
  });
});
