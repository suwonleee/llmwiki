// Tests for the L0 injection budget, the oversized-l0 lint, and capture reconcile.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { buildContext } from "../src/engine/context.ts";
import { Linter } from "../src/engine/lint.ts";
import * as capture from "../src/engine/capture.ts";
import { reconcileReflected, citedTranscripts, uncitedPending } from "../src/engine/reconcile.ts";

// UI-string assertions below expect English output; pin the language so a shell
// exporting LLMWIKI_LANG=ko does not fail the suite.
process.env.LLMWIKI_LANG = "en";

// ---- F1: cold-start L0 standard (no-cut principle, 2026-07-12) --------------
test("an over-standard current-state injects WHOLE — nothing cut, notice appended", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f1-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  const big = "---\ntitle: CS\n---\n\n" + "x".repeat(5000) + "ZZZSENTINELZZZ";
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), big, "utf-8");

  const out = buildContext(repo);
  expect(out).toContain("ZZZSENTINELZZZ"); // the tail survives — injection never cuts
  expect(out.toLowerCase()).toContain("injected whole"); // over-standard notice rides along
});

test("a giant frontmatter injects intact — fences balanced, nothing dropped", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f1fm-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  // frontmatter ALONE exceeds the standard; whole-page injection must keep the pair balanced
  const fm = "---\ntitle: CS\ndescription: " + "F".repeat(2200) + "\n---\n";
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), fm + "\nBODYVISIBLE here", "utf-8");

  const out = buildContext(repo);
  const region = out.slice(out.indexOf("current-state (cold-start)"));
  const csBlock = region.slice(0, region.indexOf("(details") + 0 || region.length);
  const fences = (csBlock.match(/^---[ \t]*$/gm) || []).length;
  expect(fences % 2).toBe(0); // balanced pair — never a dangling fence
  expect(out).toContain("BODYVISIBLE here"); // body survives too
  expect(out.toLowerCase()).toContain("injected whole");
});

test("an under-standard page injects intact with NO notice", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f1b-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  const small = "---\ntitle: CS\n---\n\nnow: shipping. next: nothing. UNIQUEMARK42";
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), small, "utf-8");

  const out = buildContext(repo);
  expect(out).toContain("UNIQUEMARK42");
  expect(out.toLowerCase()).not.toContain("injected whole"); // no notice under the standard
});

test("mildly over the standard: the LAST Next bullet survives (the measured failure case)", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f1qa-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  // ~1.8K chars — the exact class of page (1,639 chars, measured 07-12) whose final
  // "push pending" Next bullet the old 1,600 blind tail cut used to eat.
  const body =
    "---\ntitle: CS\n---\n\n## Now (TL;DR)\n" +
    "n".repeat(1650) +
    "\n\n## Next (remaining work)\n- first item\n- LASTBULLETSURVIVES";
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), body, "utf-8");

  const out = buildContext(repo);
  expect(out).toContain("LASTBULLETSURVIVES");
  expect(out.toLowerCase()).toContain("injected whole");
});

test("a huge multi-section L0 loses nothing — every section body survives", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f1big-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  const body =
    "---\ntitle: CS\n---\n\n## Direction (human-confirmed)\n" +
    "d".repeat(2500) +
    " DIRECTIONBODYSTAYS\n\n## Now (TL;DR)\nnow-line keep\n\n## Next (remaining work)\n- NEXTTAILSTAYS";
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), body, "utf-8");

  const out = buildContext(repo);
  expect(out).toContain("DIRECTIONBODYSTAYS");
  expect(out).toContain("now-line keep");
  expect(out).toContain("NEXTTAILSTAYS");
  expect(out.toLowerCase()).toContain("injected whole");
});

// ---- F2: oversized-l0 lint rule -------------------------------------------
test("oversized-l0 warns only when well over budget (soft ceiling + grace margin)", () => {
  const linter = new Linter(null as any, null as any);
  const cs = (content: string, filename = "current-state.md") =>
    linter._oversizedL0({ id: 1, path: "/docs/wiki/", filename, relative_path: "" } as any, content);

  const over = cs("y".repeat(2500)); // well past the soft lint ceiling (~1.25× the 1600 cap)
  expect(over.map((i) => i.code)).toContain("oversized-l0");
  expect(over[0]!.severity).toBe("warn");

  expect(cs("short and sweet")).toHaveLength(0); // under budget → clean
  // grace margin: over the 1600 standard but within the soft lint ceiling → NO lint nag
  // (the injection already appends a per-session over-standard notice — never a cut;
  // don't pile on char-by-char trimming pressure for a human-owned page).
  expect(cs("y".repeat(1800))).toHaveLength(0);
  expect(cs("z".repeat(5000), "overview.md").map((i) => i.code)).toContain("oversized-l0"); // no index → treated as injectable → gated
  expect(cs("z".repeat(5000), "2026-06-23-work.md")).toHaveLength(0); // a content page → not gated
});

test("oversized-l0 skips overview when current-state exists (overview not injected)", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-f2idx-"));
  mkdirSync(join(dir, "docs", "wiki"), { recursive: true });
  const linter = new Linter({ root: dir } as any, null as any);
  const ov = (filename: string) =>
    linter._oversizedL0({ id: 1, path: "/docs/wiki/", filename, relative_path: "" } as any, "z".repeat(5000));

  // no current-state yet → overview IS the cold-start page → gated
  expect(ov("overview.md").map((i) => i.code)).toContain("oversized-l0");
  // current-state present → overview is not injected → not gated (rich index allowed)
  writeFileSync(join(dir, "docs", "wiki", "current-state.md"), "x", "utf-8");
  expect(ov("overview.md")).toHaveLength(0);
  // current-state itself is always gated
  expect(ov("current-state.md").map((i) => i.code)).toContain("oversized-l0");
});

// ---- F3: capture reconcile -------------------------------------------------
beforeAll(() => {
  capture.setStateDir(mkdtempSync(join(tmpdir(), "llmwiki-f3-state-")));
});

test("reconcile marks cited sessions distilled, leaves un-cited as backlog", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3-repo-"));
  mkdirSync(join(repo, "docs", "wiki", "2_milestone"), { recursive: true });

  const tdir = mkdtempSync(join(tmpdir(), "llmwiki-f3-tx-"));
  const tA = join(tdir, "sessA-aaa.jsonl");
  const tB = join(tdir, "sessB-bbb.jsonl");
  writeFileSync(tA, '{"type":"user"}\n', "utf-8");
  writeFileSync(tB, '{"type":"user"}\n', "utf-8");
  capture.enqueue(tA, "sessA", repo, 100);
  capture.enqueue(tB, "sessB", repo, 100);

  // a wiki page cites ONLY transcript A (footnote + frontmatter source)
  writeFileSync(
    join(repo, "docs", "wiki", "2_milestone", "p.md"),
    `---\ntitle: P\nsource: ${basename(tA)}\n---\n\nDid work [^1]\n\n[^1]: ${basename(tA)}\n`,
    "utf-8",
  );

  expect(citedTranscripts(repo).has(basename(tA).toLowerCase())).toBe(true);

  const r = reconcileReflected(repo, true);
  expect(r.reconciled).toContain(basename(tA));
  expect(r.backlog).toContain(basename(tB));

  // after commit, A is no longer pending; B (un-cited backlog) still is
  const pend = capture.pending(repo).map((x) => basename(x.transcript_path));
  expect(pend).not.toContain(basename(tA));
  expect(pend).toContain(basename(tB));
});

test("reconcile dry-run reports without advancing the watermark", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3b-repo-"));
  mkdirSync(join(repo, "docs", "wiki", "2_milestone"), { recursive: true });
  const tdir = mkdtempSync(join(tmpdir(), "llmwiki-f3b-tx-"));
  const tC = join(tdir, "sessC-ccc.jsonl");
  writeFileSync(tC, '{"type":"user"}\n', "utf-8");
  capture.enqueue(tC, "sessC", repo, 100);
  writeFileSync(
    join(repo, "docs", "wiki", "2_milestone", "q.md"),
    `---\ntitle: Q\n---\n\nx [^1]\n\n[^1]: ${basename(tC)}\n`,
    "utf-8",
  );

  const r = reconcileReflected(repo, false); // dry-run
  expect(r.reconciled).toContain(basename(tC));
  // not committed → still pending
  expect(capture.pending(repo).map((x) => basename(x.transcript_path))).toContain(basename(tC));
});

test("reconcile does NOT advance a partially-condensed (byte_offset>0) session", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3c-repo-"));
  mkdirSync(join(repo, "docs", "wiki", "2_milestone"), { recursive: true });
  const tdir = mkdtempSync(join(tmpdir(), "llmwiki-f3c-tx-"));
  const tD = join(tdir, "sessD-ddd.jsonl");
  writeFileSync(tD, '{"a":1}\n', "utf-8"); // ~8 bytes
  capture.enqueue(tD, "sessD", repo, 100);
  capture.mark(tD, 5, "distilled"); // partially condensed up to offset 5
  writeFileSync(tD, '{"a":1}\n{"b":2}\n', "utf-8"); // grew past the watermark
  capture.enqueue(tD, "sessD", repo, 100); // re-pends (size > 5)

  // page cites it, but a stale citation must not jump the watermark to EOF (would lose the tail)
  writeFileSync(
    join(repo, "docs", "wiki", "2_milestone", "r.md"),
    `---\ntitle: R\n---\n\nx [^1]\n\n[^1]: ${basename(tD)}\n`,
    "utf-8",
  );
  const r = reconcileReflected(repo, true);
  expect(r.reconciled).not.toContain(basename(tD)); // left for autoupdate
  // honesty: cited-but-partial is DEFERRED, never reported as un-cited backlog
  expect(r.deferred).toContain(basename(tD));
  expect(r.backlog).not.toContain(basename(tD));
  expect(capture.pending(repo).map((x) => basename(x.transcript_path))).toContain(basename(tD));
});

test("uncitedPending is the human backlog: excludes cited (full & partial), keeps un-cited", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3e-repo-"));
  mkdirSync(join(repo, "docs", "wiki", "2_milestone"), { recursive: true });
  const tdir = mkdtempSync(join(tmpdir(), "llmwiki-f3e-tx-"));
  const cit = join(tdir, "cited-full-e.jsonl"); // cited, watermark 0
  const par = join(tdir, "cited-partial-e.jsonl"); // cited, byte_offset > 0
  const unc = join(tdir, "uncited-e.jsonl"); // not cited
  for (const f of [cit, par, unc]) writeFileSync(f, '{"a":1}\n', "utf-8");
  capture.enqueue(cit, "cfe", repo, 100);
  capture.enqueue(unc, "uce", repo, 100);
  capture.enqueue(par, "cpe", repo, 100);
  capture.mark(par, 3, "distilled"); // partial
  writeFileSync(par, '{"a":1}\n{"b":2}\n', "utf-8");
  capture.enqueue(par, "cpe", repo, 100); // re-pends (size > watermark)
  // a page cites cited-full AND cited-partial, but NOT uncited
  writeFileSync(
    join(repo, "docs", "wiki", "2_milestone", "p.md"),
    `---\ntitle: P\n---\n\nx [^1] [^2]\n\n[^1]: ${basename(cit)}\n[^2]: ${basename(par)}\n`,
    "utf-8",
  );
  const backlog = uncitedPending(repo).map((x) => basename(x.transcript_path));
  expect(backlog).toContain(basename(unc)); // the only genuine backlog
  expect(backlog).not.toContain(basename(cit)); // cited → represented, not nagged
  expect(backlog).not.toContain(basename(par)); // cited-but-partial → NOT human backlog (the bug)
});

test("cold-start pending nag counts only un-cited sessions (cited-partial never inflates it)", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3f-repo-"));
  mkdirSync(join(repo, "docs", "wiki", "2_milestone"), { recursive: true });
  writeFileSync(join(repo, "docs", "wiki", "current-state.md"), "---\ntitle: CS\n---\n\nnow.", "utf-8");
  const tdir = mkdtempSync(join(tmpdir(), "llmwiki-f3f-tx-"));
  const par = join(tdir, "cited-partial-f.jsonl");
  const unc = join(tdir, "uncited-f.jsonl");
  writeFileSync(par, '{"a":1}\n', "utf-8");
  writeFileSync(unc, '{"a":1}\n', "utf-8");
  capture.enqueue(par, "cpf", repo, 100);
  capture.mark(par, 3, "distilled");
  writeFileSync(par, '{"a":1}\n{"b":2}\n', "utf-8");
  capture.enqueue(par, "cpf", repo, 100); // re-pends
  capture.enqueue(unc, "ucf", repo, 100);
  writeFileSync(
    join(repo, "docs", "wiki", "2_milestone", "p.md"),
    `---\ntitle: P\n---\n\nx [^1]\n\n[^1]: ${basename(par)}\n`,
    "utf-8",
  );
  const out = buildContext(repo);
  // exactly ONE session (the un-cited one) is nagged; the cited-partial one is represented, not counted
  expect(out).toMatch(/(1 un-updated session|미update 세션 1건)/);
  expect(out).not.toMatch(/(2 un-updated session|미update 세션 2건)/);
});

test("citedTranscripts matches case-insensitively (.JSONL)", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-f3d-repo-"));
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wiki", "overview.md"),
    "---\ntitle: O\n---\n\nx [^1]\n\n[^1]: SESS-UP.JSONL\n",
    "utf-8",
  );
  expect(citedTranscripts(repo).has("sess-up.jsonl")).toBe(true);
});
