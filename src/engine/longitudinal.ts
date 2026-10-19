// Deterministic accounting for real, ordered task executions. This module does not execute
// tasks or infer task success from retrieval. Hashes identify externally retained evidence;
// they are attestations, not independent verification of the result bytes or test quality.
import { createHash } from "node:crypto";

export type TaskSplit = "development" | "holdout";
export type TaskArm = "static" | "adaptive";
export type TaskStatus = "pass" | "fail" | "error" | "timeout";
export interface PlannedTask {
  session_id: string;
  task_id: string; // repeat across sessions to measure retention; unique within each session
  split: TaskSplit;
}
export interface LongitudinalPlan {
  schema_version: 1;
  corpus_sha256: string;
  scorer_sha256: string;
  tasks: PlannedTask[]; // execution order; development precedes untouched holdout sessions
}
export interface TaskReceipt {
  session_id: string;
  task_id: string;
  arm: TaskArm;
  status: TaskStatus;
  manifest: { corpus_sha256: string; scorer_sha256: string; task_plan_sha256: string };
  wiki_sha256: string; // snapshot at execution, allowed to evolve only for the adaptive arm
  test: { command: string; result_sha256: string; exit_code: number | null };
  elapsed_ms: number;
  context_bytes?: number;
}
export interface ArmCounts {
  planned: number;
  pass: number;
  fail: number;
  error: number;
  timeout: number;
  missing: number;
  success_rate: number;
  elapsed_ms: number;
  context_bytes: number;
  context_observed: number;
}
export interface TaskComparison {
  planned_pairs: number;
  static: ArmCounts;
  adaptive: ArmCounts;
  success_delta: number; // adaptive minus static, full declared denominator
  paired: { wins: number; losses: number; both_pass: number; both_not_pass: number; incomplete: number };
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const key = (value: Pick<PlannedTask, "session_id" | "task_id">) => JSON.stringify([value.session_id, value.task_id]);

export function fingerprintTaskPlan(tasks: readonly PlannedTask[]): string {
  return createHash("sha256").update(JSON.stringify(tasks.map((t) => [t.session_id, t.task_id, t.split]))).digest("hex");
}

function validatePlan(plan: LongitudinalPlan): void {
  if (!plan || plan.schema_version !== 1 || !hash(plan.corpus_sha256) || !hash(plan.scorer_sha256) ||
      !Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error("invalid or empty frozen task plan");
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const taskSplits = new Map<string, TaskSplit>();
  let previousSession = "";
  let previousSplit: TaskSplit | undefined;
  let holdout = false;
  for (const task of plan.tasks) {
    if (!task || !nonempty(task.session_id) || !nonempty(task.task_id) ||
        !["development", "holdout"].includes(task.split)) throw new Error("invalid planned task identity/split");
    if (seen.has(key(task))) throw new Error("duplicate planned task within session");
    seen.add(key(task));
    if (taskSplits.has(task.task_id) && taskSplits.get(task.task_id) !== task.split) {
      throw new Error("a development task cannot become a holdout task; use a retention replay in the original split");
    }
    taskSplits.set(task.task_id, task.split);
    if (task.session_id !== previousSession) {
      if (sessions.has(task.session_id)) throw new Error("session tasks must be contiguous and ordered");
      sessions.add(task.session_id);
    } else if (task.split !== previousSplit) throw new Error("one session cannot mix development and holdout");
    if (holdout && task.split === "development") throw new Error("development cannot follow holdout");
    holdout ||= task.split === "holdout";
    previousSession = task.session_id;
    previousSplit = task.split;
  }
}

export function buildLongitudinalReport(plan: LongitudinalPlan, receipts: readonly TaskReceipt[]) {
  validatePlan(plan);
  if (!Array.isArray(receipts)) throw new Error("receipts must be an array");
  const taskPlanHash = fingerprintTaskPlan(plan.tasks);
  const planned = new Set(plan.tasks.map(key));
  const rows = new Map<string, Partial<Record<TaskArm, TaskReceipt>>>();
  let staticWiki: string | undefined;
  const commands = new Map<string, string>();
  for (const receipt of receipts as readonly TaskReceipt[]) {
    if (!receipt || !nonempty(receipt.session_id) || !nonempty(receipt.task_id) || !planned.has(key(receipt))) {
      throw new Error("receipt references an unplanned task/session");
    }
    if (!["static", "adaptive"].includes(receipt.arm) || !["pass", "fail", "error", "timeout"].includes(receipt.status)) {
      throw new Error("invalid receipt arm/status");
    }
    if (receipt.manifest?.corpus_sha256 !== plan.corpus_sha256 ||
        receipt.manifest?.scorer_sha256 !== plan.scorer_sha256 || receipt.manifest?.task_plan_sha256 !== taskPlanHash) {
      throw new Error("receipt manifest differs from frozen corpus/scorer/task plan");
    }
    if (!hash(receipt.wiki_sha256) || !nonempty(receipt.test?.command) || !hash(receipt.test?.result_sha256) ||
        !(receipt.test.exit_code === null || Number.isInteger(receipt.test.exit_code)) ||
        (receipt.status === "pass" && receipt.test.exit_code !== 0) ||
        (receipt.status === "fail" && (receipt.test.exit_code === null || receipt.test.exit_code === 0)) ||
        !Number.isFinite(receipt.elapsed_ms) || receipt.elapsed_ms < 0 ||
        (receipt.context_bytes !== undefined && (!Number.isSafeInteger(receipt.context_bytes) || receipt.context_bytes < 0))) {
      throw new Error("invalid test evidence, wiki snapshot, or execution cost");
    }
    if (commands.has(receipt.task_id) && commands.get(receipt.task_id) !== receipt.test.command) {
      throw new Error("test command differs across arms or repeated task executions");
    }
    commands.set(receipt.task_id, receipt.test.command);
    if (receipt.arm === "static") {
      if (staticWiki && staticWiki !== receipt.wiki_sha256) throw new Error("static wiki changed across executions");
      staticWiki = receipt.wiki_sha256;
    }
    const pair = rows.get(key(receipt)) ?? {};
    if (pair[receipt.arm]) throw new Error("duplicate task receipt for arm/session");
    pair[receipt.arm] = receipt;
    rows.set(key(receipt), pair);
  }

  const summarize = (tasks: PlannedTask[]): TaskComparison => {
    const counts = (): ArmCounts => ({ planned: tasks.length, pass: 0, fail: 0, error: 0, timeout: 0, missing: 0,
      success_rate: 0, elapsed_ms: 0, context_bytes: 0, context_observed: 0 });
    const result: TaskComparison = { planned_pairs: tasks.length, static: counts(), adaptive: counts(), success_delta: 0,
      paired: { wins: 0, losses: 0, both_pass: 0, both_not_pass: 0, incomplete: 0 } };
    for (const task of tasks) {
      const pair = rows.get(key(task)) ?? {};
      for (const arm of ["static", "adaptive"] as const) {
        const receipt = pair[arm];
        if (!receipt) { result[arm].missing++; continue; }
        result[arm][receipt.status]++;
        result[arm].elapsed_ms += receipt.elapsed_ms;
        if (receipt.context_bytes !== undefined) {
          result[arm].context_bytes += receipt.context_bytes;
          result[arm].context_observed++;
        }
      }
      if (!pair.static || !pair.adaptive) result.paired.incomplete++;
      else if (pair.static.status === "pass" && pair.adaptive.status === "pass") result.paired.both_pass++;
      else if (pair.adaptive.status === "pass") result.paired.wins++;
      else if (pair.static.status === "pass") result.paired.losses++;
      else result.paired.both_not_pass++;
    }
    for (const arm of ["static", "adaptive"] as const) result[arm].success_rate = tasks.length ? result[arm].pass / tasks.length : 0;
    result.success_delta = result.adaptive.success_rate - result.static.success_rate;
    return result;
  };

  // A missing replay is unknown, not observed forgetting. Preserve the latest observed result
  // per task/arm; a later executed non-pass after pass is a concrete retention regression.
  const last = new Map<string, TaskReceipt>();
  const retention_regressions: Array<{ arm: TaskArm; task_id: string; previous_session: string; session_id: string; status: TaskStatus }> = [];
  for (const task of plan.tasks) {
    for (const arm of ["static", "adaptive"] as const) {
      const receipt = rows.get(key(task))?.[arm];
      if (!receipt) continue;
      const identity = JSON.stringify([arm, task.task_id]);
      const previous = last.get(identity);
      if (previous?.status === "pass" && receipt.status !== "pass") {
        retention_regressions.push({ arm, task_id: task.task_id, previous_session: previous.session_id,
          session_id: task.session_id, status: receipt.status });
      }
      last.set(identity, receipt);
    }
  }
  return {
    schema_version: 1 as const,
    manifest: { corpus_sha256: plan.corpus_sha256, scorer_sha256: plan.scorer_sha256, task_plan_sha256: taskPlanHash },
    overall: summarize(plan.tasks),
    splits: { development: summarize(plan.tasks.filter((t) => t.split === "development")),
      holdout: summarize(plan.tasks.filter((t) => t.split === "holdout")) },
    sessions: [...new Set(plan.tasks.map((t) => t.session_id))].map((session_id) => ({ session_id,
      ...summarize(plan.tasks.filter((t) => t.session_id === session_id)) })),
    snapshots: plan.tasks.map((task) => ({ session_id: task.session_id, task_id: task.task_id,
      static: rows.get(key(task))?.static?.wiki_sha256 ?? null, adaptive: rows.get(key(task))?.adaptive?.wiki_sha256 ?? null })),
    retention_regressions,
    complete: receipts.length === plan.tasks.length * 2,
  };
}
