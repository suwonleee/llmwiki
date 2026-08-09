import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function json(relative: string): any {
  return JSON.parse(read(relative));
}

describe("local-first observed-user study protocol", () => {
  test("freezes the run and keeps native Windows distinct from WSL2", () => {
    const template = json("reference/usability-study-run.template.json");
    expect(template).toMatchObject({
      protocol_version: 1,
      event_schema_version: 1,
      engine: { release: expect.any(String), commit: expect.any(String), absolute_clone_path: expect.any(String) },
      platform: {
        target: expect.stringContaining("windows-native"),
        windows_git_bash_version: expect.any(String),
        wsl_distribution_version: expect.any(String),
      },
      harness: { name: expect.any(String), version: expect.any(String) },
      model: { identifier: expect.any(String), settings_digest: expect.stringContaining("sha256:") },
      fixture: {
        commit: expect.any(String),
        content_digest: expect.stringContaining("sha256:"),
        task_script: "reference/usability-study-task.md",
        task_script_version: 1,
        task_script_digest: expect.stringContaining("sha256:"),
      },
      facilitator_material: {
        answer_key_digest: expect.stringContaining("sha256:"),
      },
    });
    const protocol = read("reference/USABILITY_STUDY.md");
    expect(protocol).toMatch(/Treat `windows-native` and `windows-wsl2` as different targets/);
    expect(protocol).toMatch(/Never pool their results into one “Windows” row/);
    expect(protocol).toContain("absolute clone path");
    expect(Object.keys(template.facilitator_material)).toEqual(["answer_key_digest"]);
    expect(protocol).toContain("outside both the llmwiki engine clone and synthetic fixture\n  repository");
    expect(protocol).not.toContain("usability-study-private");
    expect(protocol).not.toContain("answer-key.json");
  });

  test("defines consent, funnel, stop, pilot, and comparative gates", () => {
    const protocol = read("reference/USABILITY_STUDY.md");
    for (const heading of [
      "## Consent and local-only recording",
      "## Procedure and funnel",
      "## Stop rules",
      "## Pilot gate",
      "## Comparative design and analysis",
    ]) expect(protocol).toContain(heading);
    expect(protocol).toContain("No consent means no observation and no event log");
    expect(protocol).toContain("45-minute timebox");
    expect(protocol).toContain("The second `intervention` event must be followed immediately");
    expect(protocol).toContain("record a third intervention, a successful stage completion, or any later event");
    for (const reason of [
      "participant-withdrew",
      "deletion-requested",
      "private-data-exposed",
      "credential-risk",
      "unsafe-mutation-risk",
      "participant-distress",
      "timebox-expired",
    ]) expect(protocol).toContain(reason);
    expect(protocol).toContain("immediate `stopped` event with outcome `stopped`");
    expect(protocol).toContain("five-user pilot for every harness");
    expect(protocol).toContain("at least 15 valid,\ncompleted runs");
    expect(protocol).toContain("at least 80% complete the full loop unaided");
    expect(protocol).toContain("at most 20\nminutes");
    expect(protocol).toContain("at most 30 minutes");
    expect(protocol).toContain("median wrong-command count is at\nmost 1");
    expect(protocol).toContain("every comprehension item is correct in at least 80%");
  });

  test("uses a closed coded event vocabulary with no participant content fields", () => {
    const schema = json("reference/usability-study-event.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining([
      "manifest_digest",
      "participant_code",
      "platform",
      "harness",
      "sequence",
      "monotonic_ms",
      "stage",
      "event",
      "reason_code",
    ]));
    expect(schema.properties.platform.enum).toEqual(["macos", "linux", "windows-native", "windows-wsl2"]);
    expect(schema.properties.event.description).toContain("second intervention must be followed immediately");
    expect(schema.properties.reason_code.description).toContain("mandatory terminal reason");
    expect(schema.allOf).toHaveLength(9);
    expect(schema.examples).toHaveLength(1);
    expect(schema.properties.stage.enum).toEqual([
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
    ]);
    const forbidden = /name|email|username|path|repo|prompt|transcript|wiki_text|credential|note|audio|screen/i;
    expect(Object.keys(schema.properties).filter((field) => forbidden.test(field))).toEqual([]);
    for (const property of Object.values(schema.properties) as any[]) {
      if (property.type === "string") expect(property.maxLength ?? property.pattern ?? property.enum ?? property.const).toBeDefined();
    }
  });

  test("makes the analysis reproducible and invalid data fail closed", () => {
    const protocol = read("reference/USABILITY_STUDY.md");
    expect(protocol).toContain("sort by `participant_code`, then `sequence`");
    expect(protocol).toContain("Reject duplicate or decreasing");
    expect(protocol).toContain("funnel completion: participants completing each stage / participants completing `consent`");
    expect(protocol).toContain("median target ≤20 minutes");
    expect(protocol).toContain("median count of `blocked` plus `intervention` events");
    expect(protocol).toContain("nearest-rank p90 target ≤30 minutes");
    expect(protocol).toContain("never substitute an aggregate score");
    expect(protocol).toContain("under-15-completed");
    expect(protocol).toContain("never silently dropped or pooled");
    expect(protocol).toMatch(/does not\s+authorize collecting or uploading participant data/);
  });

  test("freezes a meaningful full-loop task and records only coded outcomes", () => {
    const task = read("reference/usability-study-task.md");
    expect(task).toContain("Codex `$wiki-save`; Claude/OpenCode `/wiki-save`");
    expect(task).toContain("Start a new clean session");
    expect(task).toContain("without exposing the\n   external answer-key location");
    expect(task).toContain("wiki Markdown\n   only");
    expect(task).toContain("coded retrieval evidence");
    expect(task).toContain("five frozen comprehension items");
    expect(task).toMatch(/record no\s+decision code, rationale, answer text/);
    expect(task).toContain("outside both the engine clone and fixture repository");
    expect(task).not.toContain("usability-study-private");
    expect(task).not.toContain("answer-key.json");
    expect(task).toContain("bare `llmwiki` from\nPowerShell on native Windows");
    expect(task).not.toContain("cache-ttl-17m");
    expect(task).not.toMatch(/implement\s+the chosen/i);
  });
});
