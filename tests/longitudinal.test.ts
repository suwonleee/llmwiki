import { describe, expect, test } from "bun:test";
import { buildLongitudinalReport, fingerprintTaskPlan, type LongitudinalPlan, type TaskReceipt } from "../src/engine/longitudinal.ts";

const SHA = "a".repeat(64);
function plan(): LongitudinalPlan {
  return { schema_version: 1, corpus_sha256: SHA, scorer_sha256: "b".repeat(64), tasks: [
    { session_id: "s1", task_id: "learn", split: "development" },
    { session_id: "s2", task_id: "retain", split: "holdout" },
    { session_id: "s3", task_id: "retain", split: "holdout" },
  ] };
}
function receipt(p: LongitudinalPlan, index: number, arm: "static" | "adaptive", status: TaskReceipt["status"] = "pass"): TaskReceipt {
  const task = p.tasks[index]!;
  return { session_id: task.session_id, task_id: task.task_id, arm, status,
    manifest: { corpus_sha256: p.corpus_sha256, scorer_sha256: p.scorer_sha256, task_plan_sha256: fingerprintTaskPlan(p.tasks) },
    wiki_sha256: arm === "static" ? SHA : String(index + 1).repeat(64),
    test: { command: `bun test ${task.task_id}.test.ts`, result_sha256: SHA, exit_code: status === "pass" ? 0 : status === "fail" ? 1 : null },
    elapsed_ms: 10, context_bytes: 100 };
}

describe("longitudinal task execution accounting", () => {
  test("omitted failed runs remain in the full denominator and cannot become paired wins", () => {
    const p = plan();
    const report = buildLongitudinalReport(p, [receipt(p, 0, "static"), receipt(p, 0, "adaptive"), receipt(p, 1, "adaptive")]);
    expect(report.overall.static.success_rate).toBe(1 / 3);
    expect(report.overall.adaptive.success_rate).toBe(2 / 3);
    expect(report.overall.static.missing).toBe(2);
    expect(report.overall.adaptive.missing).toBe(1);
    expect(report.overall.paired).toEqual({ wins: 0, losses: 0, both_pass: 1, both_not_pass: 0, incomplete: 2 });
    expect(report.splits.holdout.planned_pairs).toBe(2);
    expect(report.complete).toBe(false);
  });

  test("ordered replays expose adaptive forgetting despite a net-neutral result", () => {
    const p = plan();
    // Deliberately unordered receipt arrival; frozen session order governs retention.
    const rows = [receipt(p, 2, "adaptive", "fail"), receipt(p, 0, "static"), receipt(p, 0, "adaptive"),
      receipt(p, 1, "static", "fail"), receipt(p, 1, "adaptive"), receipt(p, 2, "static")];
    const report = buildLongitudinalReport(p, rows);
    expect(report.complete).toBe(true);
    expect(report.overall.success_delta).toBe(0);
    expect(report.overall.paired.wins).toBe(1);
    expect(report.overall.paired.losses).toBe(1);
    expect(report.retention_regressions).toEqual([{ arm: "adaptive", task_id: "retain", previous_session: "s2", session_id: "s3", status: "fail" }]);
    expect(report.sessions.map((s) => s.session_id)).toEqual(["s1", "s2", "s3"]);
    expect(report.snapshots[1]!.adaptive).not.toBe(report.snapshots[2]!.adaptive);
  });

  test("error and timeout are counted, and missing context cost is not measured zero", () => {
    const p = plan();
    const timeout = receipt(p, 0, "static", "timeout");
    delete timeout.context_bytes;
    const report = buildLongitudinalReport(p, [timeout, receipt(p, 0, "adaptive", "error")]);
    expect(report.overall.static.timeout).toBe(1);
    expect(report.overall.adaptive.error).toBe(1);
    expect(report.overall.static.success_rate).toBe(0);
    expect(report.overall.static.context_observed).toBe(0);
    expect(report.overall.adaptive.context_observed).toBe(1);
    expect(report.retention_regressions).toEqual([]);
  });

  test("duplicate and unplanned receipts cannot inflate success", () => {
    const p = plan();
    const row = receipt(p, 0, "static");
    expect(() => buildLongitudinalReport(p, [row, row])).toThrow(/duplicate/);
    expect(() => buildLongitudinalReport(p, [{ ...row, task_id: "unknown" }])).toThrow(/unplanned/);
  });

  test("corpus, scorer, and ordered task manifest must match", () => {
    const p = plan();
    for (const field of ["corpus_sha256", "scorer_sha256", "task_plan_sha256"] as const) {
      const row = receipt(p, 0, "static");
      row.manifest[field] = "c".repeat(64);
      expect(() => buildLongitudinalReport(p, [row])).toThrow(/manifest/);
    }
    expect(fingerprintTaskPlan([...p.tasks].reverse())).not.toBe(fingerprintTaskPlan(p.tasks));
  });

  test("invalid or missing execution evidence is rejected", () => {
    const p = plan();
    const mutations: Array<(row: TaskReceipt) => void> = [
      (r) => { r.test.command = " "; }, (r) => { r.test.result_sha256 = "unverified"; },
      (r) => { r.test.exit_code = 1; }, (r) => { r.wiki_sha256 = "latest"; },
      (r) => { r.elapsed_ms = NaN; }, (r) => { r.context_bytes = -1; },
    ];
    for (const mutate of mutations) {
      const row = receipt(p, 0, "adaptive");
      mutate(row);
      expect(() => buildLongitudinalReport(p, [row])).toThrow(/evidence/);
    }
  });

  test("static wiki and task acceptance commands cannot drift", () => {
    const p = plan();
    const first = receipt(p, 1, "static");
    const later = receipt(p, 2, "static");
    later.wiki_sha256 = "f".repeat(64);
    expect(() => buildLongitudinalReport(p, [first, later])).toThrow(/static wiki/);
    const adaptive = receipt(p, 1, "adaptive");
    adaptive.test.command = "echo pass";
    expect(() => buildLongitudinalReport(p, [first, adaptive])).toThrow(/test command/);
  });

  test("frozen plan rejects duplicate, mixed, out-of-order, and contaminated splits", () => {
    const p = plan();
    expect(() => buildLongitudinalReport({ ...p, tasks: [] }, [])).toThrow(/empty/);
    expect(() => buildLongitudinalReport({ ...p, tasks: [p.tasks[0]!, p.tasks[0]!] }, [])).toThrow(/duplicate/);
    expect(() => buildLongitudinalReport({ ...p, tasks: [...p.tasks].reverse() }, [])).toThrow(/development cannot follow/);
    expect(() => buildLongitudinalReport({ ...p, tasks: [p.tasks[0]!, { ...p.tasks[1]!, task_id: "learn" }] }, [])).toThrow(/development task/);
    expect(() => buildLongitudinalReport({ ...p, tasks: [p.tasks[0]!, { ...p.tasks[1]!, session_id: "s1" }] }, [])).toThrow(/mix/);
  });
});
