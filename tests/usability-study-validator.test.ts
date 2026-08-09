import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  USABILITY_EVENT_ENUMS,
  USABILITY_MANDATORY_STOP_REASONS,
  USABILITY_STAGES,
  validateUsabilityRun,
} from "../src/engine/usability-study-validate.ts";

const META = {
  schema_version: 1,
  run_id: "run-hostile-001",
  manifest_digest: `sha256:${"0".repeat(64)}`,
  participant_code: "P001",
  study_phase: "comparative",
  arm: "agent-guided",
  platform: "windows-wsl2",
  harness: "codex",
};

function validRun(): Record<string, unknown>[] {
  let sequence = 0;
  let monotonic_ms = 0;
  return USABILITY_STAGES.flatMap((stage) => [
    { ...META, sequence: ++sequence, monotonic_ms: monotonic_ms += 10, stage, event: "entered", outcome: "pending", reason_code: "none" },
    {
      ...META,
      sequence: ++sequence,
      monotonic_ms: monotonic_ms += 10,
      stage,
      event: "completed",
      outcome: "success",
      reason_code: "none",
      ...(stage === "seeded-decision-retrieval" ? { retrieval_evidence: "wiki-search" } : {}),
      ...(stage === "comprehension-check" ? {
        comprehension_results: {
          "enrollment-scope": true,
          "clone-is-not-consent": true,
          "wiki-location": true,
          "llm-opt-in": true,
          "uninstall-preserves-wiki": true,
        },
      } : {}),
    },
  ]);
}

function interventionStopRun(tail: "stop" | "third" | "complete"): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { ...META, sequence: 1, monotonic_ms: 10, stage: "consent", event: "entered", outcome: "pending", reason_code: "none" },
    { ...META, sequence: 2, monotonic_ms: 20, stage: "consent", event: "intervention", outcome: "failure", reason_code: "other-coded" },
    { ...META, sequence: 3, monotonic_ms: 30, stage: "consent", event: "intervention", outcome: "failure", reason_code: "other-coded" },
  ];
  if (tail === "stop") {
    events.push({ ...META, sequence: 4, monotonic_ms: 40, stage: "consent", event: "stopped", outcome: "stopped", reason_code: "facilitator-safety-stop" });
  } else if (tail === "third") {
    events.push({ ...META, sequence: 4, monotonic_ms: 40, stage: "consent", event: "intervention", outcome: "failure", reason_code: "other-coded" });
  } else {
    events.push({ ...META, sequence: 4, monotonic_ms: 40, stage: "consent", event: "completed", outcome: "success", reason_code: "none" });
  }
  return events;
}

function mandatoryStopRun(
  reason_code: string,
  terminal: { event: string; outcome: string } = { event: "stopped", outcome: "stopped" },
  continueAfter = false,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { ...META, sequence: 1, monotonic_ms: 10, stage: "consent", event: "entered", outcome: "pending", reason_code: "none" },
    { ...META, sequence: 2, monotonic_ms: 20, stage: "consent", ...terminal, reason_code },
  ];
  if (continueAfter) {
    events.push({ ...META, sequence: 3, monotonic_ms: 30, stage: "consent", event: "completed", outcome: "success", reason_code: "none" });
  }
  return events;
}

describe("usability study cross-event validator", () => {
  test("keeps validator stages and enums identical to the public schema", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "..", "reference", "usability-study-event.schema.json"), "utf8"));
    expect(schema.properties.stage.enum).toEqual([...USABILITY_STAGES]);
    for (const [property, values] of Object.entries(USABILITY_EVENT_ENUMS)) {
      expect(schema.properties[property].enum, property).toEqual([...values]);
    }
    const mandatoryStopRule = schema.allOf.find((rule: any) => rule.if?.properties?.reason_code?.enum);
    expect(mandatoryStopRule.if.properties.reason_code.enum).toEqual([...USABILITY_MANDATORY_STOP_REASONS]);
    expect(mandatoryStopRule.then.properties.event.const).toBe("stopped");
    expect(mandatoryStopRule.then.properties.outcome.const).toBe("stopped");
  });

  test("accepts one complete ordered frozen run", () => {
    expect(validateUsabilityRun(validRun())).toEqual([]);
  });

  test("accepts exactly two interventions followed by the required safety stop", () => {
    expect(validateUsabilityRun(interventionStopRun("stop"))).toEqual([]);
  });

  test("rejects a third intervention", () => {
    const errors = validateUsabilityRun(interventionStopRun("third"));
    expect(errors.some((error) => error.includes("second intervention must be followed immediately"))).toBe(true);
    expect(errors.some((error) => error.includes("third intervention is forbidden"))).toBe(true);
  });

  test("rejects successful completion after the second intervention", () => {
    const errors = validateUsabilityRun(interventionStopRun("complete"));
    expect(errors.some((error) => error.includes("second intervention must be followed immediately"))).toBe(true);
    expect(errors).toContain("run ended before required facilitator-safety-stop");
  });

  test("accepts every mandatory safety reason only as a stopped outcome", () => {
    for (const reason of USABILITY_MANDATORY_STOP_REASONS) {
      expect(validateUsabilityRun(mandatoryStopRun(reason)), reason).toEqual([]);
    }
  });

  test("rejects every mandatory safety reason on a non-stopped event", () => {
    for (const reason of USABILITY_MANDATORY_STOP_REASONS) {
      const errors = validateUsabilityRun(mandatoryStopRun(reason, { event: "blocked", outcome: "failure" }));
      expect(errors.some((error) => error.includes("requires an immediate stopped event")), reason).toBe(true);
    }
  });

  test("rejects continuation after every mandatory safety stop", () => {
    for (const reason of USABILITY_MANDATORY_STOP_REASONS) {
      const errors = validateUsabilityRun(mandatoryStopRun(reason, undefined, true));
      expect(errors.some((error) => error.includes("event after terminal run outcome")), reason).toBe(true);
    }
  });

  test("rejects a missing terminal pair", () => {
    const events = validRun();
    events.pop();
    expect(validateUsabilityRun(events)).toEqual(expect.arrayContaining([
      "stage comprehension-check is missing terminal event",
      "run ended before stage comprehension-check",
    ]));
  });

  test("rejects a missing entered pair", () => {
    const events = validRun();
    events.splice(8, 1);
    expect(validateUsabilityRun(events).some((error) => error.includes("missing entered event"))).toBe(true);
  });

  test("rejects a skipped stage", () => {
    const skipped = validRun();
    skipped.splice(10, 2);
    expect(validateUsabilityRun(skipped).some((error) => error.includes("expected stage doctor"))).toBe(true);
  });

  test("rejects reordered stages", () => {
    const reordered = validRun();
    [reordered[12], reordered[14]] = [reordered[14]!, reordered[12]!];
    expect(validateUsabilityRun(reordered).some((error) => error.includes("expected stage harness-activation"))).toBe(true);
  });

  test("rejects metadata, sequence, and timestamp changes within a run", () => {
    const events = validRun();
    events[5]!.platform = "windows-native";
    events[7]!.sequence = 99;
    events[9]!.monotonic_ms = 0;
    const errors = validateUsabilityRun(events);
    expect(errors.some((error) => error.includes("frozen metadata changed: platform"))).toBe(true);
    expect(errors.some((error) => error.includes("expected sequence"))).toBe(true);
    expect(errors.some((error) => error.includes("monotonic_ms decreased"))).toBe(true);
  });

  test("rejects raw identity/path fields and invalid schema enums or digest", () => {
    const events = validRun();
    Object.assign(events[2]!, {
      name: "Alice Example",
      email: "alice@example.com",
      path: "/Users/alice/private-repo",
      arm: "unregistered-arm",
      platform: "windows",
      manifest_digest: "not-a-digest",
    });
    const errors = validateUsabilityRun(events);
    for (const field of ["name", "email", "path"]) {
      expect(errors).toContain(`event 3: unknown field ${field}`);
    }
    expect(errors).toContain("event 3: invalid arm");
    expect(errors).toContain("event 3: invalid platform");
    expect(errors).toContain("event 3: invalid manifest_digest pattern");
  });

  test("rejects free-form comprehension and retrieval evidence", () => {
    const events = validRun();
    const retrieval = events.find((event) => event.stage === "seeded-decision-retrieval" && event.event === "completed")!;
    retrieval.retrieval_evidence = "I found it in /Users/alice/private-repo";
    const comprehension = events.at(-1)!;
    comprehension.comprehension_results = { "enrollment-scope": "Alice said yes" };
    const errors = validateUsabilityRun(events);
    expect(errors.some((error) => error.includes("retrieval terminal requires coded evidence"))).toBe(true);
    expect(errors.some((error) => error.includes("invalid comprehension item"))).toBe(true);
  });

  test("rejects not-found evidence on completed successful retrieval", () => {
    const events = validRun();
    const retrieval = events.find((event) => event.stage === "seeded-decision-retrieval" && event.event === "completed")!;
    retrieval.retrieval_evidence = "not-found";
    expect(validateUsabilityRun(events)).toContain(
      `event ${retrieval.sequence}: successful retrieval cannot use not-found evidence`,
    );
  });
});
