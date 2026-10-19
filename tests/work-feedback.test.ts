import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./support/git-repo.ts";
import { checkFeedback, prepareFeedback, recordFeedback, type FeedbackInput } from "../src/engine/work-feedback.ts";
import { WikiIndex } from "../src/engine/db.ts";
let root: string;
const page = "docs/wiki/3_decision/retries.md";
let input: FeedbackInput;
function writePage(body: string) {
  writeFileSync(join(root, page), `---\ntype: Decision\ntitle: Gateway retry policy\ndescription: Gateway retry policy\nstatus: stable\n---\n# Gateway retry policy\n${body}\n`);
}
beforeEach(() => {
  root = tempDir("feedback-");
  mkdirSync(join(root, "docs/wiki/3_decision"), { recursive: true });
  writePage("Gateway retry policy permits 3 retries.");
  writeFileSync(join(root, "policy.ts"), "const retries = 3;");
  const idx = new WikiIndex(root); const db = idx.connect(); idx.indexAll(db); db.close();
  input = { session: "exact-session", cases: [{ query: "Gateway retry policy", page, outcome: "corrected", evidence: ["policy.ts"], required: ["3 retries"], forbidden: ["99 retries"] }] };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("immutable session receipt is idempotent and retrieval assertions are replayable", () => {
  expect(recordFeedback(root, input).duplicate).toBe(false);
  expect(recordFeedback(root, input).duplicate).toBe(true);
  expect(checkFeedback(root).results.map(r => r.status)).toEqual(["pass"]);
  input.cases[0]!.required = ["other claim"];
  expect(() => recordFeedback(root, input)).toThrow("immutable");
});
test("changed wiki is evaluated against frozen assertions, not silently relabeled", () => {
  recordFeedback(root, input);
  writePage("Gateway retry policy permits 99 retries.");
  const report = checkFeedback(root);
  expect(report.results[0]?.status).toBe("fail");
  expect(report.results[0]?.top5).toBe(true);
  expect(report.results[0]?.context).toBe(false);
});
test("changed source invalidates expectations instead of reporting an improvement", () => {
  recordFeedback(root, input);
  writeFileSync(join(root, "policy.ts"), "const retries = 99;");
  expect(checkFeedback(root).results[0]?.status).toBe("invalidated");
});
test("requires bounded concrete raw evidence and refuses symlink escapes", () => {
  input.cases.push(input.cases[0]!, input.cases[0]!);
  expect(() => prepareFeedback(root, input)).toThrow("1–2");
  input.cases = [input.cases[0]!];
  input.cases[0]!.evidence = [page];
  expect(() => prepareFeedback(root, input)).toThrow("raw source");
  symlinkSync(join(root, "policy.ts"), join(root, "link.ts"));
  input.cases[0]!.evidence = ["link.ts"];
  expect(() => prepareFeedback(root, input)).toThrow("unsafe");
  input.cases[0]!.evidence = ["../elsewhere"];
  expect(() => prepareFeedback(root, input)).toThrow("unsafe");
});
test("empty evidence/assertions cannot manufacture successful feedback", () => {
  input.cases[0]!.required = []; input.cases[0]!.forbidden = [];
  expect(() => recordFeedback(root, input)).toThrow("assertions");
  expect(checkFeedback(root).results).toEqual([]);
});
