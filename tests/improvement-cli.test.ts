import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setStateDir, stateDir } from "../src/engine/capture.ts";
import { recordEmission } from "../src/engine/observe.ts";
import { _saveNudgeDir, observeSaveNudge } from "../src/engine/save-nudge.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
let root: string, repo: string, state: string, previousState: string;
const page = "docs/wiki/3_decision/retries.md";
const report = "## Missing concepts\n\n- Retry budget needs a concept.\n\n## Next questions\n\n(none)\n";
beforeEach(() => {
  root = tempDir("llmwiki-improvement-cli-");
  previousState = stateDir();
  state = join(root, "state");
  setStateDir(state);
  repo = enrollRepo(makeGitRepo(join(root, "repo")));
  mkdirSync(join(repo, "docs/wiki/3_decision"), { recursive: true });
  writeFileSync(join(repo, page), "---\ntype: Decision\ntitle: Retry policy\ndescription: Retry policy\ntags: [retry, boundary]\nstatus: stable\n---\n\nRetry attempts are limited to three.\n");
  writeFileSync(join(repo, "policy.ts"), "export const RETRIES = 3;\n");
});
afterEach(() => {
  for (const session of [root, root + "-declined"]) rmSync(_saveNudgeDir(repo, session), { recursive: true, force: true });
  setStateDir(previousState);
  rmSync(root, { recursive: true, force: true });
});
function run(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LLMWIKI_STATE_DIR: state, LLMWIKI_LANG: "en" };
  delete env.LLMWIKI_LLM_CMD;
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
function json(...args: string[]): any {
  const result = run(...args);
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out);
}
function source(name: string, value: unknown): string {
  const path = join(root, name + ".json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("all six commands expose side-effect-free help including their JSON contracts", () => {
  for (const command of ["save-event", "injected", "injected-feedback", "recheck", "review-input", "review-import"]) {
    const result = run(command, "--help");
    expect(result.code).toBe(0);
    expect(result.out).toContain("llmwiki " + command);
    if (command === "injected-feedback") {
      expect(result.out).toContain("session,judgments");
      expect(result.out).toContain("used|irrelevant|wrong|unknown");
    }
    if (command === "review-import") {
      expect(result.out).toContain("snapshot:");
      expect(result.out).toContain("## Missing concepts");
      expect(result.out).toContain("## Next questions");
    }
  }
});

test("save-event requires exact identity and completed or declined suppress later suggestions", () => {
  for (const event of ["completed", "declined"]) {
    const session = event === "completed" ? root : root + "-declined";
    expect(json("save-event", repo, "--session", session, "--event", event)).toEqual({ session, event });
    for (let i = 0; i < 10; i++) expect(observeSaveNudge(repo, "We decided retry boundary " + i, session)).toBe("");
  }
  expect(run("save-event", repo, "--session", root, "--event", "queued").code).not.toBe(0);
  expect(run("save-event", repo, "--event", "completed").code).not.toBe(0);
});

test("injected feedback and grounded recheck round-trip through real JSON commands", () => {
  recordEmission(repo, root, "turn_context", "  • Retry policy → " + page);
  const injected = json("injected", repo, "--session", root);
  expect(injected.session).toBe(root);
  expect(injected.pages).toHaveLength(1);
  expect(injected.pages[0]).toMatchObject({ page, channel: "turn_context", current: true });
  expect(json("injected", repo, "--session", "another-exact-session").pages).toEqual([]);
  const feedback = { session: root, judgments: [{
    page, sha256: injected.pages[0].sha256, channel: "turn_context",
    outcome: "wrong", used: true, evidence: "The source contract needs rechecking against policy.ts.",
  }] };
  const input = source("feedback", feedback);
  expect(json("injected-feedback", repo, "--source", input).duplicate).toBe(false);
  expect(json("injected-feedback", repo, "--source", input).duplicate).toBe(true);
  const queue = json("recheck", repo);
  expect(queue.owner).toBe("llm");
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0].status).toBe("open");
  const resolution = source("resolution", { id: queue.items[0].id, verification: "Read the explicit retry constant.", evidence: ["policy.ts"] });
  expect(json("recheck", repo, "--source", resolution).status).toBe("resolved");
  expect(json("recheck", repo).items[0].status).toBe("resolved");
  writeFileSync(join(repo, "policy.ts"), "export const RETRIES = 4;\n");
  expect(json("recheck", repo).items[0].status).toBe("open");
});

test("provider-free review input/import produces a draft and materializes its gaps on explicit command", () => {
  const before = readFileSync(join(repo, page), "utf8");
  const snapshot = json("review-input", repo);
  expect(snapshot.schema_version).toBe(1);
  expect(snapshot.pages).toHaveLength(1);
  const input = source("review", { snapshot, report });
  const receipt = json("review-import", repo, "--source", input);
  expect(receipt.duplicate).toBe(false);
  expect(receipt.classification).toBe("session-self-assessment");
  expect(readFileSync(join(repo, receipt.path), "utf8")).toContain("status: draft");
  expect(json("review-import", repo, "--source", input).duplicate).toBe(true);
  const gaps = run("gaps", repo);
  expect(gaps.code).toBe(0);
  expect(readFileSync(join(repo, "docs/wiki/0_review/gap-queue.md"), "utf8")).toContain("Retry budget needs a concept.");
  expect(readFileSync(join(repo, page), "utf8")).toBe(before);
});

test("JSON ingestion rejects symlink sources, malformed input and invalid payloads", () => {
  const snapshot = json("review-input", repo);
  const real = source("real-review", { snapshot, report });
  const link = join(root, "linked-review.json");
  symlinkSync(real, link);
  for (const command of ["review-import", "injected-feedback", "recheck"]) {
    const result = run(command, repo, "--source", link);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
  }
  writeFileSync(real, "{bad json");
  expect(run("review-import", repo, "--source", real).code).not.toBe(0);
  expect(run("review-import", repo, "--source", source("empty", {})).code).not.toBe(0);
  expect(run("injected-feedback", repo, "--source", source("invalid-feedback", { session: root, judgments: [] })).code).not.toBe(0);
});
