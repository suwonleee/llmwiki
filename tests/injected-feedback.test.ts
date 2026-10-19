import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adjustedScore, affinityMultiplier, loadAffinity, resetAffinityCache } from "../src/engine/affinity.ts";
import { disable, resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { injectedPages, recordInjectedFeedback, recheckQueue, resolveRecheck, type InjectionFeedbackInput, type InjectionJudgment } from "../src/engine/injected-feedback.ts";
import { recordEmission, readDetailedEmissions, type EmissionChannel } from "../src/engine/observe.ts";
import { ensureProjectStateDir, projectStatePath, resetProjectStateCache } from "../src/engine/project-state.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { makeEnrolledRepo, tempDir } from "./support/git-repo.ts";
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 19, 12);
const PAGE = "docs/wiki/3_decision/retries.md";
const L0 = "docs/wiki/current-state.md";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string, state: string;
beforeEach(() => {
  state = tempDir("llmwiki-injected-state-");
  setEffectiveStateRoot(state);
  resetProjectStateCache(); resetAffinityCache(); resetEnrollmentCache();
  root = makeEnrolledRepo("llmwiki-injected-repo-");
  mkdirSync(join(root, "docs/wiki/3_decision"), { recursive: true });
  writeFileSync(join(root, PAGE), "---\ntitle: Gateway retries\n---\nGateway retries use a bounded policy.\n");
  writeFileSync(join(root, L0), "---\ntitle: Current State\n---\nNow: bounded retry policy.\n");
  writeFileSync(join(root, "policy.ts"), "export const retries = 3;\n");
});
afterEach(() => {
  resetAffinityCache(); resetProjectStateCache(); resetEnrollmentCache(); setEffectiveStateRoot(null);
  rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true });
});
function emit(session: string, channel: EmissionChannel = "turn_context", page = PAGE) {
  const out = channel === "cold_start" ? "===== [llmwiki] fixture — docs/wiki/current-state (cold-start) =====\nNow: bounded retries."
    : channel === "edit_rules" ? `----- [llmwiki edit rules] -----\n- Keep retries bounded — ${page}`
      : `  • Gateway retries → ${page}`;
  recordEmission(root, session, channel, out);
  return injectedPages(root, session).pages.find(p => p.page === (channel === "cold_start" ? L0 : page) && p.channel === channel)!;
}
function feedback(session: string, outcome: InjectionJudgment["outcome"], now = NOW, overrides: Partial<InjectionJudgment> = {}) {
  const emitted = emit(session);
  const input: InjectionFeedbackInput = { session, judgments: [{ page: emitted.page, sha256: emitted.sha256, channel: emitted.channel, outcome,
    evidence: "Observed this claim in the task against policy.ts and test output.", ...overrides }] };
  return { ...recordInjectedFeedback(root, input, now), input };
}
function affinity(now = NOW) { resetAffinityCache(); return loadAffinity(root, now); }

test("versioned list includes whole cold L0 and edit rules, isolating exact sessions", () => {
  emit("session-a", "cold_start"); emit("session-a", "edit_rules"); emit("session-a"); emit("session-b");
  const list = injectedPages(root, "session-a");
  expect(list.pages.map(p => `${p.channel}:${p.page}`).sort()).toEqual([`cold_start:${L0}`, `edit_rules:${PAGE}`, `turn_context:${PAGE}`]);
  expect(list.pages.every(p => /^[a-f0-9]{64}$/.test(p.sha256) && p.current)).toBe(true);
  const old = list.pages.find(p => p.page === PAGE)!.sha256;
  writeFileSync(join(root, PAGE), "Replacement policy version.\n");
  expect(injectedPages(root, "session-a").pages.find(p => p.page === PAGE)?.sha256).toBe(old);
  expect(injectedPages(root, "session-a").pages.filter(p => p.page === PAGE).every(p => !p.current)).toBe(true);
  expect(injectedPages(root, "no-such-session").pages).toEqual([]);
});
test("legacy and malformed emissions stay unknown instead of receiving current hashes", () => {
  const dir = ensureProjectStateDir(root, "observe");
  const base = { root, ts: NOW, session: "legacy", channel: "turn_context", pages: [PAGE] };
  appendFileSync(join(dir, "emissions.jsonl"), [JSON.stringify(base), "corrupt", JSON.stringify({ ...base, snapshots: [{ page: "docs/wiki/../escape.md", sha256: digest("x") }, { page: PAGE, sha256: "forged" }] })].join("\n") + "\n");
  expect(injectedPages(root, "legacy").pages).toEqual([]);
  expect(readDetailedEmissions(root, "other")).toEqual([]);
});
test("unknown judgments and missing feedback leave ranking neutral", () => {
  emit("missing");
  expect(adjustedScore(10, affinity(), PAGE)).toBe(10);
  for (let i = 0; i < 8; i++) feedback(`unknown-${i}`, "unknown", NOW - (i % 2) * DAY);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
});
test("unsent pages, forged versions/channels and inferred sessions are rejected", () => {
  const e = emit("exact");
  const base = { session: "exact", judgments: [{ ...e, outcome: "used", evidence: "policy.ts verified" }] };
  for (const patch of [{ page: L0 }, { sha256: "0".repeat(64) }, { channel: "edit_rules" }]) {
    expect(() => recordInjectedFeedback(root, { ...base, judgments: [{ ...base.judgments[0], ...patch }] }, NOW)).toThrow("not emitted");
  }
  expect(() => recordInjectedFeedback(root, { ...base, session: "other" }, NOW)).toThrow("not emitted");
  expect(() => recordInjectedFeedback(root, { ...base, session: "" }, NOW)).toThrow("exact session");
});
test("session receipt is idempotent, immutable, and bound to the originally emitted version", () => {
  const first = feedback("immutable", "used");
  const saved = readFileSync(first.path, "utf8");
  writeFileSync(join(root, PAGE), "Corrected policy after the task.\n");
  expect(recordInjectedFeedback(root, first.input, NOW + DAY).duplicate).toBe(true);
  expect(readFileSync(first.path, "utf8")).toBe(saved);
  expect(() => recordInjectedFeedback(root, { ...first.input, judgments: [{ ...first.input.judgments[0], outcome: "irrelevant" }] }, NOW)).toThrow("immutable");
  expect(affinityMultiplier(affinity(NOW + DAY), PAGE)).toBe(1);
});
test("explicit irrelevant demotion needs eight sessions over two days", () => {
  for (let i = 0; i < 7; i++) feedback(`small-${i}`, "irrelevant", NOW - (i % 2) * DAY);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
  feedback("eighth", "irrelevant", NOW);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(0.9);
  expect(adjustedScore(10, affinity(), PAGE)).toBe(9.05);
});
test("eight irrelevant judgments on one day remain neutral", () => {
  for (let i = 0; i < 8; i++) feedback(`single-day-${i}`, "irrelevant");
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
});
test("used boost needs two sessions over two days; edit rules never steer turn ranking", () => {
  feedback("used-one", "used", NOW - DAY);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
  feedback("used-two", "used", NOW);
  expect(affinityMultiplier(affinity(), PAGE)).toBeGreaterThan(1);
  writeFileSync(join(root, PAGE), "New rule revision resets old boost.\n");
  const e = emit("edit-only", "edit_rules");
  recordInjectedFeedback(root, { session: "edit-only", judgments: [{ ...e, outcome: "used", evidence: "The edit applied this rule." }] }, NOW);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
});
test("page edits reset already-written aggregate before another judgment arrives", () => {
  feedback("used-a", "used", NOW - DAY); feedback("used-b", "used", NOW);
  expect(affinityMultiplier(affinity(), PAGE)).toBeGreaterThan(1);
  const old = statSync(join(root, PAGE));
  writeFileSync(join(root, PAGE), "A changed page with fresh semantics.\n");
  utimesSync(join(root, PAGE), old.atime, (old.mtimeMs + 1000) / 1000);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
});
test("wrong plus used is preserved without rewarding a known wrong claim; queue dedupes page/version", () => {
  const one = feedback("wrong-one", "wrong", NOW - DAY, { used: true });
  feedback("wrong-two", "wrong", NOW);
  expect(JSON.parse(readFileSync(one.path, "utf8")).judgments[0].used).toBe(true);
  expect(affinityMultiplier(affinity(), PAGE)).toBe(1);
  expect(recheckQueue(root)).toHaveLength(1);
  expect(recheckQueue(root)[0]?.status).toBe("open");
  writeFileSync(join(root, PAGE), "Another wrong revision.\n");
  feedback("wrong-new-version", "wrong");
  expect(recheckQueue(root)).toHaveLength(2);
});
test("wrong rechecks require raw evidence and explicit verification; editing alone never closes", () => {
  feedback("wrong", "wrong");
  const item = recheckQueue(root)[0]!;
  writeFileSync(join(root, PAGE), "Corrected retry policy: 3 retries.\n");
  expect(recheckQueue(root)[0]?.status).toBe("open");
  const input = { id: item.id, verification: "Read policy.ts and verified three attempts against tests.", evidence: ["policy.ts"] };
  expect(() => resolveRecheck(root, { ...input, verification: "" }, NOW)).toThrow("verification");
  expect(() => resolveRecheck(root, { ...input, evidence: [PAGE] }, NOW)).toThrow("raw source");
  expect(() => resolveRecheck(root, { ...input, evidence: ["docs\\wiki\\current-state.md"] }, NOW)).toThrow("raw source");
  expect(() => resolveRecheck(root, { ...input, evidence: ["DOCS/wiki/current-state.md"] }, NOW)).toThrow("raw source");
  const result = resolveRecheck(root, input, NOW);
  expect(recheckQueue(root)[0]?.status).toBe("resolved");
  const receipt = JSON.parse(readFileSync(result.path, "utf8"));
  expect(receipt.sha256).toBe(digest(readFileSync(join(root, PAGE), "utf8")));
  expect(receipt.evidence[0].sha256).toBe(digest(readFileSync(join(root, "policy.ts"), "utf8")));
  expect(resolveRecheck(root, input, NOW + 1).path).toBe(result.path);
});
test("a source/page edit reopens a recheck and accepts a new immutable revision receipt", () => {
  feedback("wrong", "wrong");
  const id = recheckQueue(root)[0]!.id;
  const input = { id, verification: "Verified current source behavior.", evidence: ["policy.ts"] };
  const first = resolveRecheck(root, input, NOW);
  const original = readFileSync(first.path, "utf8");
  writeFileSync(join(root, "policy.ts"), "export const retries = 4;\n");
  expect(recheckQueue(root)[0]?.status).toBe("open");
  const second = resolveRecheck(root, input, NOW + 1);
  expect(second.path).not.toBe(first.path);
  expect(readFileSync(first.path, "utf8")).toBe(original);
  expect(recheckQueue(root)[0]?.status).toBe("resolved");
  writeFileSync(join(root, PAGE), "A later page revision.\n");
  expect(recheckQueue(root)[0]?.status).toBe("open");
  resolveRecheck(root, input, NOW + 2);
  expect(recheckQueue(root)[0]?.status).toBe("resolved");
  expect(readdirSync(projectStatePath(root, "rechecks"))).toHaveLength(3);
});
test("emission, feedback receipt and evidence symlinks cannot be followed", () => {
  const target = join(root, "untouched.txt"); writeFileSync(target, "untouched\n");
  const dir = ensureProjectStateDir(root, "observe");
  symlinkSync(target, join(dir, "emissions.jsonl"));
  recordEmission(root, "linked", "turn_context", `  • Gateway → ${PAGE}`);
  expect(readFileSync(target, "utf8")).toBe("untouched\n");
  expect(injectedPages(root, "linked").pages).toEqual([]);
  rmSync(join(dir, "emissions.jsonl"));
  const e = emit("receipt-link");
  const receiptDir = ensureProjectStateDir(root, "injected-feedback");
  symlinkSync(target, join(receiptDir, `${digest("receipt-link")}.json`));
  expect(() => recordInjectedFeedback(root, { session: "receipt-link", judgments: [{ ...e, outcome: "wrong", evidence: "Mismatch." }] }, NOW)).toThrow("immutable");
  feedback("wrong-real", "wrong");
  const id = recheckQueue(root)[0]!.id;
  symlinkSync(join(root, "policy.ts"), join(root, "linked-policy.ts"));
  expect(() => resolveRecheck(root, { id, verification: "Read the source", evidence: ["linked-policy.ts"] }, NOW)).toThrow("unsafe");
  expect(readFileSync(target, "utf8")).toBe("untouched\n");
});
test("unregistered repository cannot accept explicit feedback or resolve rechecks", () => {
  const { input } = feedback("before-disable", "wrong");
  const id = recheckQueue(root)[0]!.id;
  disable(root); resetEnrollmentCache();
  expect(() => recordInjectedFeedback(root, input, NOW)).toThrow("not enrolled");
  expect(() => resolveRecheck(root, { id, verification: "Verified", evidence: ["policy.ts"] }, NOW)).toThrow("not enrolled");
});
