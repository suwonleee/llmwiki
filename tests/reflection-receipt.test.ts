import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { citedTranscripts, recordReflection, reconcileReflected, type ReflectionReceipt } from "../src/engine/reconcile.ts";

let root: string, repo: string, source: string, oldState: string;
const page = "docs/wiki/2_milestone/result.md";
const body = "---\ntitle: Result\nstatus: stable\n---\nLearned a fact.[^s]\n\n[^s]: session.jsonl\n";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const receipt = (): ReflectionReceipt => ({ version: 1, transcript_path: source, page,
  start: 0, end: 8, prefix_sha256: hash('{"a":1}\n'), page_sha256: hash(body) });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reflection-receipt-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, "docs/wiki/2_milestone"), { recursive: true });
  oldState = capture.stateDir();
  capture.setStateDir(join(root, "state"));
  source = join(root, "session.jsonl");
  writeFileSync(source, '{"a":1}\n');
  writeFileSync(join(repo, page), body);
  capture.enqueue(source, "exact-session", repo, 1);
});
afterEach(() => { capture.setStateDir(oldState); rmSync(root, { recursive: true, force: true }); });

test("a growing transcript advances only the witnessed prefix, leaving its tail pending", () => {
  expect(recordReflection(repo, receipt())).toBe(true);
  appendFileSync(source, '{"b":2}\n');
  expect(reconcileReflected(repo, false).reconciled).toEqual(["session.jsonl"]);
  expect(capture.getOffset(source)).toBe(0);
  expect(reconcileReflected(repo, true).reconciled).toEqual(["session.jsonl"]);
  expect(capture.getOffset(source)).toBe(8);
  expect(capture.pending(repo).map(r => r.transcript_path)).toContain(source);
  expect(reconcileReflected(repo, true).reconciled).toEqual([]);
});

test("a rewritten source or edited page invalidates acceptance before reconciliation", () => {
  expect(recordReflection(repo, receipt())).toBe(true);
  writeFileSync(source, '{"a":9}\n');
  expect(reconcileReflected(repo, true).reconciled).toEqual([]);
  writeFileSync(source, '{"a":1}\n');
  appendFileSync(join(repo, page), "Concurrent correction\n");
  expect(reconcileReflected(repo, true).reconciled).toEqual([]);
  expect(capture.getOffset(source)).toBe(0);
});

test("draft and human-review citations do not hide backlog or authorize receipts", () => {
  writeFileSync(join(repo, page), body.replace("stable", "draft"));
  expect(recordReflection(repo, { ...receipt(), page_sha256: hash(body.replace("stable", "draft")) })).toBe(false);
  mkdirSync(join(repo, "docs/wiki/0_review"));
  const review = "docs/wiki/0_review/question.md";
  writeFileSync(join(repo, review), body);
  expect(recordReflection(repo, { ...receipt(), page: review })).toBe(false);
  expect(citedTranscripts(repo).has("session.jsonl")).toBe(false);
  expect(reconcileReflected(repo, true).backlog).toEqual(["session.jsonl"]);
});

test("receipt rejects unrelated transcript identity, coverage gaps, and mismatched hashes", () => {
  expect(recordReflection(repo, { ...receipt(), transcript_path: join(root, "other/session.jsonl") })).toBe(false);
  expect(recordReflection(repo, { ...receipt(), start: 1 })).toBe(false);
  expect(recordReflection(repo, { ...receipt(), prefix_sha256: "bad" })).toBe(false);
  expect(recordReflection(repo, { ...receipt(), end: 999 })).toBe(false);
  expect(capture.getOffset(source)).toBe(0);
});

test("an older worker cannot roll a concurrent watermark backward or change a completed row", () => {
  appendFileSync(source, '{"b":2}\n');
  expect(capture.markIfOffset(source, 0, 8, "pending")).toBe(true);
  expect(capture.markIfOffset(source, 0, 4, "distilled")).toBe(false);
  expect(capture.getOffset(source)).toBe(8);
  expect(capture.markIfOffset(source, 8, 16, "distilled")).toBe(true);
  expect(capture.markIfOffset(source, 16, 20, "pending")).toBe(false);
  expect(capture.getOffset(source)).toBe(16);
});


test("concurrent immutable receipts preserve the longest accepted prefix", () => {
  appendFileSync(source, '{"b":2}\n');
  expect(recordReflection(repo, { ...receipt(), end: 16, prefix_sha256: hash('{"a":1}\n{"b":2}\n') })).toBe(true);
  expect(recordReflection(repo, receipt())).toBe(true);
  expect(reconcileReflected(repo, true).reconciled).toEqual(["session.jsonl"]);
  expect(capture.getOffset(source)).toBe(16);
});

test("receipt storage refuses a symlinked state subtree", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(capture.stateDir(), "reflections"));
  expect(recordReflection(repo, receipt())).toBe(false);
  expect(readdirSync(outside)).toEqual([]);
  expect(reconcileReflected(repo, true).reconciled).toEqual([]);
});
