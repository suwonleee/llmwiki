#!/usr/bin/env bun
import { readFileSync } from "node:fs";

export const USABILITY_STAGES = [
  "consent",
  "prerequisites",
  "clone-located",
  "dry-run",
  "install",
  "doctor",
  "harness-activation",
  "fixture-enrollment",
  "first-context",
  "fixture-task",
  "deterministic-close-out",
  "close-out-artifact",
  "clean-session-start",
  "seeded-decision-retrieval",
  "comprehension-check",
] as const;

export const USABILITY_EVENT_ENUMS = {
  study_phase: ["pilot", "comparative"],
  arm: ["agent-guided", "manual-fallback"],
  platform: ["macos", "linux", "windows-native", "windows-wsl2"],
  harness: ["claude", "codex", "opencode"],
  event: ["entered", "completed", "blocked", "intervention", "wrong-command", "stopped"],
  outcome: ["pending", "success", "failure", "stopped"],
  reason_code: [
    "none", "participant-withdrew", "deletion-requested", "private-data-exposed", "credential-risk",
    "prerequisite-missing", "setup-error", "doctor-error", "activation-incomplete", "wrong-command",
    "retrieval-incorrect", "unsafe-mutation-risk", "participant-distress", "timebox-expired",
    "facilitator-safety-stop", "other-coded",
  ],
  retrieval_evidence: ["cold-start-context", "wiki-search", "both", "not-found"],
} as const;

export const USABILITY_MANDATORY_STOP_REASONS = [
  "participant-withdrew",
  "deletion-requested",
  "private-data-exposed",
  "credential-risk",
  "unsafe-mutation-risk",
  "participant-distress",
  "timebox-expired",
] as const;

const EVENTS = new Set<string>(USABILITY_EVENT_ENUMS.event);
const TERMINAL = new Set(["completed", "blocked", "stopped"]);
const PHASES = new Set<string>(USABILITY_EVENT_ENUMS.study_phase);
const ARMS = new Set<string>(USABILITY_EVENT_ENUMS.arm);
const PLATFORMS = new Set<string>(USABILITY_EVENT_ENUMS.platform);
const HARNESSES = new Set<string>(USABILITY_EVENT_ENUMS.harness);
const OUTCOMES = new Set<string>(USABILITY_EVENT_ENUMS.outcome);
const REASONS = new Set<string>(USABILITY_EVENT_ENUMS.reason_code);
const MANDATORY_STOP_REASONS = new Set<string>(USABILITY_MANDATORY_STOP_REASONS);
const RETRIEVAL_EVIDENCE = new Set<string>(USABILITY_EVENT_ENUMS.retrieval_evidence);
const COMPREHENSION_ITEMS = [
  "enrollment-scope", "clone-is-not-consent", "wiki-location", "llm-opt-in", "uninstall-preserves-wiki",
] as const;
const METADATA = ["run_id", "manifest_digest", "participant_code", "study_phase", "arm", "platform", "harness"] as const;
const ALLOWED = new Set([
  "schema_version", ...METADATA, "sequence", "monotonic_ms", "stage", "event", "outcome", "reason_code",
  "retrieval_evidence", "comprehension_results",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validateUsabilityRun(input: unknown[]): string[] {
  const errors: string[] = [];
  if (input.length === 0) return ["run has no events"];
  const first = record(input[0]);
  if (!first) return ["event 1 is not an object"];

  let expectedSequence = 1;
  let previousMs = -1;
  let stageIndex = 0;
  let entered = false;
  let ended = false;
  let interventionCount = 0;
  let safetyStopRequired = false;

  for (let index = 0; index < input.length; index++) {
    const position = index + 1;
    const event = record(input[index]);
    if (!event) {
      errors.push(`event ${position} is not an object`);
      continue;
    }
    for (const key of Object.keys(event)) if (!ALLOWED.has(key)) errors.push(`event ${position}: unknown field ${key}`);
    for (const key of METADATA) {
      if (typeof event[key] !== "string" || event[key] === "") errors.push(`event ${position}: invalid ${key}`);
      else if (event[key] !== first[key]) errors.push(`event ${position}: frozen metadata changed: ${key}`);
    }
    if (typeof event.run_id === "string" && !/^run-[a-z0-9-]{6,48}$/.test(event.run_id)) errors.push(`event ${position}: invalid run_id pattern`);
    if (typeof event.manifest_digest === "string" && !/^sha256:[a-f0-9]{64}$/.test(event.manifest_digest)) errors.push(`event ${position}: invalid manifest_digest pattern`);
    if (typeof event.participant_code === "string" && !/^P[0-9]{3}$/.test(event.participant_code)) errors.push(`event ${position}: invalid participant_code pattern`);
    if (!PHASES.has(String(event.study_phase))) errors.push(`event ${position}: invalid study_phase`);
    if (!ARMS.has(String(event.arm))) errors.push(`event ${position}: invalid arm`);
    if (!PLATFORMS.has(String(event.platform))) errors.push(`event ${position}: invalid platform`);
    if (!HARNESSES.has(String(event.harness))) errors.push(`event ${position}: invalid harness`);
    if (!OUTCOMES.has(String(event.outcome))) errors.push(`event ${position}: invalid outcome`);
    if (!REASONS.has(String(event.reason_code))) errors.push(`event ${position}: invalid reason_code`);
    if (event.schema_version !== 1) errors.push(`event ${position}: unsupported schema_version`);
    if (event.sequence !== expectedSequence) errors.push(`event ${position}: expected sequence ${expectedSequence}`);
    expectedSequence++;
    if (!Number.isInteger(event.monotonic_ms) || (event.monotonic_ms as number) < 0) {
      errors.push(`event ${position}: invalid monotonic_ms`);
    } else {
      if ((event.monotonic_ms as number) < previousMs) errors.push(`event ${position}: monotonic_ms decreased`);
      previousMs = event.monotonic_ms as number;
    }
    if (ended) {
      errors.push(`event ${position}: event after terminal run outcome`);
      continue;
    }

    const expectedStage = USABILITY_STAGES[stageIndex];
    if (event.stage !== expectedStage) {
      errors.push(`event ${position}: expected stage ${expectedStage ?? "<end>"}, got ${String(event.stage)}`);
      continue;
    }
    if (typeof event.event !== "string" || !EVENTS.has(event.event)) {
      errors.push(`event ${position}: invalid event kind`);
      continue;
    }
    const kind = event.event;
    if (
      MANDATORY_STOP_REASONS.has(String(event.reason_code)) &&
      (kind !== "stopped" || event.outcome !== "stopped")
    ) {
      errors.push(`event ${position}: mandatory safety reason requires an immediate stopped event with stopped outcome`);
    }
    if (safetyStopRequired) {
      const compliantSafetyStop =
        kind === "stopped" && event.outcome === "stopped" && event.reason_code === "facilitator-safety-stop";
      if (!compliantSafetyStop) {
        errors.push(`event ${position}: second intervention must be followed immediately by facilitator-safety-stop`);
      } else {
        safetyStopRequired = false;
      }
    }
    if (kind === "intervention") {
      interventionCount++;
      if (interventionCount === 2) safetyStopRequired = true;
      else if (interventionCount > 2) errors.push(`event ${position}: third intervention is forbidden`);
    }
    if (kind === "stopped" && event.reason_code === "facilitator-safety-stop" && interventionCount !== 2) {
      errors.push(`event ${position}: facilitator-safety-stop requires exactly two interventions`);
    }
    if (!entered) {
      if (kind !== "entered") errors.push(`event ${position}: stage ${expectedStage} is missing entered event`);
      else entered = true;
    } else if (kind === "entered") {
      errors.push(`event ${position}: duplicate entered event for ${expectedStage}`);
    } else if (TERMINAL.has(kind)) {
      entered = false;
      if (kind === "completed") stageIndex++;
      else ended = true;
    }

    const comprehension = record(event.comprehension_results);
    if (event.stage === "comprehension-check" && kind === "completed") {
      if (!comprehension) {
        errors.push(`event ${position}: completed comprehension-check requires coded item results`);
      } else {
        const keys = Object.keys(comprehension);
        for (const key of keys) if (!COMPREHENSION_ITEMS.includes(key as typeof COMPREHENSION_ITEMS[number])) errors.push(`event ${position}: unknown comprehension item ${key}`);
        for (const item of COMPREHENSION_ITEMS) if (typeof comprehension[item] !== "boolean") errors.push(`event ${position}: invalid comprehension item ${item}`);
      }
    } else if (event.comprehension_results !== undefined) {
      errors.push(`event ${position}: comprehension results are only allowed on completed comprehension-check`);
    }
    const retrievalTerminal = event.stage === "seeded-decision-retrieval" && TERMINAL.has(kind);
    if (retrievalTerminal) {
      if (!RETRIEVAL_EVIDENCE.has(String(event.retrieval_evidence))) errors.push(`event ${position}: retrieval terminal requires coded evidence`);
      else if (kind === "completed" && event.outcome === "success" && event.retrieval_evidence === "not-found") {
        errors.push(`event ${position}: successful retrieval cannot use not-found evidence`);
      }
    } else if (event.retrieval_evidence !== undefined) {
      errors.push(`event ${position}: retrieval evidence is only allowed on terminal retrieval event`);
    }
    if (kind === "entered" && (event.outcome !== "pending" || event.reason_code !== "none")) {
      errors.push(`event ${position}: entered must be pending with reason none`);
    }
    if (kind === "completed" && (event.outcome !== "success" || event.reason_code !== "none")) {
      errors.push(`event ${position}: completed must be success with reason none`);
    }
    if ((kind === "blocked" || kind === "intervention") && event.outcome !== "failure") {
      errors.push(`event ${position}: ${kind} must have failure outcome`);
    }
    if (kind === "wrong-command" && (event.outcome !== "failure" || event.reason_code !== "wrong-command")) {
      errors.push(`event ${position}: wrong-command must have failure outcome and matching reason`);
    }
    if (kind === "stopped" && (event.outcome !== "stopped" || event.reason_code === "none")) {
      errors.push(`event ${position}: stopped must have stopped outcome and a reason`);
    }
  }

  if (entered) errors.push(`stage ${USABILITY_STAGES[stageIndex]} is missing terminal event`);
  if (safetyStopRequired) errors.push("run ended before required facilitator-safety-stop");
  if (!ended && stageIndex !== USABILITY_STAGES.length) {
    errors.push(`run ended before stage ${USABILITY_STAGES[stageIndex]}`);
  }
  return errors;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun src/engine/usability-study-validate.ts <local-events.jsonl>");
    process.exit(2);
  }
  let events: unknown[];
  try {
    events = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    console.error(`invalid local event log: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const errors = validateUsabilityRun(events);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(`valid local usability run: ${events.length} event(s)`);
}
