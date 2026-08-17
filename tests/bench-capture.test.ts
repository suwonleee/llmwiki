import { describe, expect, test } from "bun:test";

import {
  CAPTURE_SAMPLE_MATERIALIZATIONS,
  CAPTURE_SCALE_TIERS,
  runCaptureScaleSuite,
} from "../src/engine/bench-capture.ts";

describe("deterministic capture-scale benchmark", () => {
  test("declares the public 100, 1000, and 10000 session tiers", () => {
    expect(CAPTURE_SCALE_TIERS).toEqual([100, 1_000, 10_000]);
  });

  test("reports exact structural counts without turning timings into gates", () => {
    const suite = runCaptureScaleSuite(2, [10]);

    expect(suite.schema_version).toBe(1);
    expect(suite.gating).toContain("structural counts are deterministic");
    expect(suite.tiers).toHaveLength(1);
    const tier = suite.tiers[0]!;
    expect(tier.sessions).toBe(10);
    for (const harness of ["claude", "codex", "opencode"] as const) {
      const report = tier.harnesses[harness];
      expect(report.discovered).toBe(10);
      expect(report.initial_candidates).toBe(10);
      expect(report.sample_materializations).toBe(CAPTURE_SAMPLE_MATERIALIZATIONS);
      expect(report.successful_materializations).toBe(CAPTURE_SAMPLE_MATERIALIZATIONS);
      expect(report.source_bytes).toBeGreaterThan(0);
      for (const timing of Object.values(report.timings_ms)) {
        expect(timing.samples).toHaveLength(2);
        expect(timing.p95).toBeGreaterThanOrEqual(timing.median);
      }
    }
    expect(tier.harnesses.claude.unchanged_candidates).toBe(0);
    expect(tier.harnesses.codex.unchanged_candidates).toBe(0);
    expect(tier.harnesses.opencode.unchanged_candidates).toBe(10);
    expect(suite.hook_cli_ms.module_startup.samples).toHaveLength(2);
    expect(suite.hook_cli_ms.enrollment_probe.samples).toHaveLength(2);
  }, 20_000);
});
