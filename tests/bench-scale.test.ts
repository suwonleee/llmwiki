import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  SCALE_TIERS,
  generateScaleFixture,
  measureScaleWorkspace,
  repoTreeBytes,
  runScaleSuite,
  summarizeSamples,
} from "../src/engine/bench-scale.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const roots: string[] = [];

function repo(prefix: string): string {
  const box = tempDir(prefix);
  roots.push(box);
  return enrollRepo(makeGitRepo(join(box, "repo")));
}

afterEach(() => {
  resetEnrollmentCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deterministic scale benchmark", () => {
  test("declares the public 10, 100, and 1000 page tiers", () => {
    expect(SCALE_TIERS).toEqual([10, 100, 1000]);
  });

  test("generates every declared tier at its exact page count", () => {
    const root = repo("llmwiki-scale-tiers-");

    for (const pages of SCALE_TIERS) {
      expect(generateScaleFixture(root, pages).pages).toBe(pages);
      expect(readdirSync(join(root, "docs", "wiki", "5_topic"))).toHaveLength(pages);
    }
  });

  test("generates byte-identical pages for the same tier", () => {
    const first = repo("llmwiki-scale-first-");
    const second = repo("llmwiki-scale-second-");

    const a = generateScaleFixture(first, 10);
    const b = generateScaleFixture(second, 10);

    expect(a).toEqual(b);
    const namesA = readdirSync(join(first, "docs", "wiki", "5_topic")).sort();
    const namesB = readdirSync(join(second, "docs", "wiki", "5_topic")).sort();
    expect(namesA).toEqual(namesB);
    for (const name of namesA) {
      expect(readFileSync(join(first, "docs", "wiki", "5_topic", name), "utf-8")).toBe(
        readFileSync(join(second, "docs", "wiki", "5_topic", name), "utf-8"),
      );
    }
  });

  test("summarizes repeat samples with nearest-rank median and p95", () => {
    expect(summarizeSamples([9, 1, 5, 3, 7])).toEqual({ median: 5, p95: 9, samples: [9, 1, 5, 3, 7] });
  });

  test("fails with the generated path when corpus metadata unexpectedly disappears", () => {
    const root = repo("llmwiki-scale-metadata-");
    generateScaleFixture(root, 1);

    expect(() => repoTreeBytes(root, join("docs", "wiki"), () => null)).toThrow(
      "scale corpus metadata unavailable: docs/wiki/5_topic/scale-page-000000.md",
    );
  });

  test("reports repeatable non-gating timing and resource evidence", () => {
    const root = repo("llmwiki-scale-measure-");
    generateScaleFixture(root, 10);

    const report = measureScaleWorkspace(root, 3);

    expect(report.schema_version).toBe(1);
    expect(report.pages).toBe(10);
    expect(report.repeats).toBe(3);
    expect(report.search_hit_rate).toBe(1);
    expect(report.context_hit_rate).toBe(1);
    for (const phase of Object.values(report.timings_ms)) {
      expect(phase.samples).toHaveLength(3);
      expect(phase.median).toBeGreaterThanOrEqual(0);
      expect(phase.p95).toBeGreaterThanOrEqual(phase.median);
    }
    expect(report.resources.source_bytes.samples).toHaveLength(3);
    expect(report.resources.source_bytes.median).toBeGreaterThan(0);
    expect(report.resources.index_bytes.samples).toHaveLength(3);
    expect(report.resources.index_bytes.median).toBeGreaterThan(0);
  });

  test("runs every declared tier with complete correctness and distribution evidence", () => {
    const suite = runScaleSuite(2);

    expect(suite.tiers.map((tier) => tier.pages)).toEqual([...SCALE_TIERS]);
    expect(suite.gating).toContain("correctness-only");
    for (const tier of suite.tiers) {
      expect(tier.search_hit_rate).toBe(1);
      expect(tier.context_hit_rate).toBe(1);
      for (const phase of Object.values(tier.timings_ms)) {
        expect(phase.samples).toHaveLength(2);
        expect(phase.p95).toBeGreaterThanOrEqual(phase.median);
      }
      for (const resource of Object.values(tier.resources)) {
        expect(resource.samples).toHaveLength(2);
        expect(resource.median).toBeGreaterThan(0);
        expect(resource.p95).toBeGreaterThanOrEqual(resource.median);
      }
    }
  }, 20_000);
});
