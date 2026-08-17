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

  test("gates every public tier and measures the real automatic-hook entrypoint", () => {
    const suite = runCaptureScaleSuite(1);

    expect(suite.schema_version).toBe(2);
    expect(suite.gating).toContain("structural counts are deterministic");
    expect(suite.entrypoints).toEqual({ public_cli: "src/cli.ts", automatic_hook: "src/hook-cli.ts" });
    expect(suite.tiers.map((tier) => tier.sessions)).toEqual([...CAPTURE_SCALE_TIERS]);
    for (const tier of suite.tiers) {
      for (const harness of ["claude", "codex", "opencode"] as const) {
        const report = tier.harnesses[harness];
        expect(report.discovered).toBe(tier.sessions);
        expect(report.initial_candidates).toBe(tier.sessions);
        expect(report.sample_materializations).toBe(CAPTURE_SAMPLE_MATERIALIZATIONS);
        expect(report.successful_materializations).toBe(CAPTURE_SAMPLE_MATERIALIZATIONS);
        expect(report.source_bytes).toBeGreaterThan(0);
        expect(report.unchanged_candidates).toBe(0);
        for (const timing of Object.values(report.timings_ms)) {
          expect(timing.samples).toHaveLength(1);
          expect(timing.p95).toBeGreaterThanOrEqual(timing.median);
        }
      }
    }
    expect(suite.public_cli_ms.version.samples).toHaveLength(1);
    expect(suite.hook_cli_ms.empty_turn.samples).toHaveLength(1);
    expect(suite.hook_cli_ms.enrollment_probe.samples).toHaveLength(1);
  }, 60_000);
});
