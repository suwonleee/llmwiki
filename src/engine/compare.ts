// compare.ts — frozen-corpus A/B regression harness (P0-1b; approach studied from
// kytmanov's compare harness — implementation, identifiers and vocabulary are our own).
//
// Two-step decomposition (instead of kytmanov's in-process two-Config run): prompt/model
// changes in THIS engine are code changes, so the two arms usually live on different git
// states. Each arm is therefore built+scored separately into a labeled result file, and a
// pure function judges two result files:
//
//   llmwiki compare-arm <repo-template> --corpus <dir> --label current   # on main
//   (edit prompts / switch branch / change env)
//   llmwiki compare-arm <repo-template> --corpus <dir> --label challenger
//   llmwiki compare-verdict <current.json> <challenger.json>             # keep/adopt/undecided
//
// Arm build = real pipeline (`ingest` per frozen transcript → WRITE→VERIFY→grounding→lint)
// into an ISOLATED temp workspace; the wiki under test is built from the same corpus both
// times — our unattended capture makes corpus freezing free (transcripts are immutable).
// Note: corpus files are COPIED into the temp workspace before ingest, so the central
// capture queue only ever sees temp-path rows (watermark at EOF, daemon never revisits) —
// a real transcript's own queue row/watermark is never touched even if the corpus was
// assembled from live transcript paths.
//
// Scoring is deterministic (LLM-0): bench golden queries (r@5 any-hit + refusal =
// turn-context silence — structural, language-neutral; no English phrase lists) plus
// structural health (lint error/warn → lintHealth, dangling links → linkIntegrity).
// Judgement gates run regression-block first, then adopt.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WikiIndex } from "./db.ts";
import { Linter } from "./lint.ts";
import { updateReferences, autoRegisterCitedTranscripts } from "./refs.ts";
import { ingest } from "./ingest.ts";
import * as consolidate from "./consolidate.ts";
import { runBench, type BenchReport } from "./bench.ts";

export interface ArmResult {
  schema_version: 1;
  label: string;
  corpus_files: number;
  build_failures: number; // ingest passes that errored (partial arm)
  pages: number;
  topic_pages: number; // pages under 5_topic/ — the layer the P0-2 merge rubric governs
  bench: BenchReport | null;
  lint_errors: number;
  lint_warns: number;
  lintHealth: number; // 1 - min(1, (errors*10 + warns) / max(1, pages*2)) — clamp [0,1]
  linkIntegrity: number; // 1 - dangling/total wikilink edges (1 when no links)
}

export interface Verdict {
  verdict: "keep" | "adopt" | "undecided";
  reason: string;
  avg_query_delta: number | null;
  per_query_deltas: Record<string, number>;
  structural_deltas: Record<string, number>;
}

// ---- deterministic scoring -----------------------------------------------------------

export function scoreArm(root: string, label: string, buildStats: { corpus: number; failures: number }): ArmResult {
  const w = new WikiIndex(root);
  w.indexAll();
  autoRegisterCitedTranscripts(w);
  const conn = w.connect();
  let pages = 0;
  let topicPages = 0;
  let dangling = 0;
  let totalLinks = 0;
  try {
    // materialize the reference graph (same per-doc walk as the CLI's rebuildRefs)
    const docs = w
      .listDocumentsWithContent(conn)
      .filter((d: any) => String(d.relative_path).includes("docs/wiki/"));
    for (const d of docs) updateReferences(w, conn, d as any, (d.content as string) || "");
    pages = (conn.query("SELECT count(*) n FROM documents WHERE source_kind='wiki'").get() as any).n;
    topicPages = (conn.query(
      "SELECT count(*) n FROM documents WHERE source_kind='wiki' AND relative_path LIKE 'docs/wiki/5_topic/%'",
    ).get() as any).n;
    totalLinks = (conn.query("SELECT count(*) n FROM document_references WHERE reference_type='links_to'").get() as any).n;
  } finally {
    conn.close();
  }
  const lintConn = w.connect();
  let issues;
  try {
    [issues] = new Linter(w as any, lintConn).run();
  } finally {
    lintConn.close();
  }
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  dangling = issues.filter((i) => i.code === "dangling-link").length;

  let bench: BenchReport | null = null;
  try {
    bench = runBench(root, "all");
  } catch {
    bench = null; // no golden set shipped with the corpus → comparison fails closed at the query gate
  }

  return {
    schema_version: 1,
    label,
    corpus_files: buildStats.corpus,
    build_failures: buildStats.failures,
    pages,
    topic_pages: topicPages,
    bench,
    lint_errors: errors,
    lint_warns: warns,
    lintHealth: Math.max(0, Math.min(1, 1 - (errors * 10 + warns) / Math.max(1, pages * 2))),
    linkIntegrity: totalLinks ? Math.max(0, 1 - dangling / totalLinks) : 1,
  };
}

// Per-query score in [0,1]: refusal queries score refusal_ok, content queries score r@5.
function queryScores(r: BenchReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of r.per_query) {
    out[q.id] = q.refusal_ok !== undefined ? (q.refusal_ok ? 1 : 0) : q["r@5"];
  }
  return out;
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function malformedArmReason(arm: ArmResult): string | null {
  if (typeof arm !== "object" || arm === null) return "arm is not an object";
  if (arm.schema_version !== 1) return "unsupported or missing arm schema_version";
  if (typeof arm.label !== "string" || !arm.label) return "missing arm label";
  for (const key of ["corpus_files", "build_failures", "pages", "topic_pages", "lint_errors", "lint_warns"] as const) {
    if (!validCount(arm[key])) return `${key} must be a non-negative integer`;
  }
  if (arm.build_failures > arm.corpus_files) return "build_failures exceeds corpus_files";
  if (arm.topic_pages > arm.pages) return "topic_pages exceeds pages";
  if (!validRate(arm.lintHealth)) return "lintHealth must be finite in [0,1]";
  if (!validRate(arm.linkIntegrity)) return "linkIntegrity must be finite in [0,1]";
  const expectedLintHealth = Math.max(
    0,
    Math.min(1, 1 - (arm.lint_errors * 10 + arm.lint_warns) / Math.max(1, arm.pages * 2)),
  );
  if (Math.abs(arm.lintHealth - expectedLintHealth) > 1e-12) return "lintHealth disagrees with lint counts/pages";
  if (arm.bench === null) return null;
  const report = arm.bench as BenchReport;
  if (typeof report !== "object" || report === null) return "bench must be an object or null";
  if (!(["all", "tune", "sealed"] as const).includes(report.subset as any)) return "invalid benchmark subset";
  if (typeof report.query_set_fingerprint !== "string" || !report.query_set_fingerprint) {
    return "missing query-set fingerprint";
  }
  if (!validCount(report.n) || report.n === 0) return "benchmark n must be a positive integer";
  if (!validCount(report.n_content) || !validCount(report.n_refusal) || report.n_content + report.n_refusal !== report.n) {
    return "incomplete benchmark evidence: content/refusal counts must be complete";
  }
  if (!Array.isArray(report.per_query) || report.per_query.length !== report.n) {
    return "declared query count differs from scored rows";
  }
  if (!validRate(report.recall?.["r@5"])) return "benchmark recall r@5 must be finite in [0,1]";
  if (!validRate(report.tc_pointer_hit) || !validRate(report.tc_refusal_ok)) {
    return "benchmark context health must be finite in [0,1]";
  }
  const ids = new Set<string>();
  let content = 0;
  let refusal = 0;
  let contentTotal = 0;
  for (const query of report.per_query) {
    if (typeof query !== "object" || query === null) return "query row is not an object";
    if (typeof query.id !== "string" || !query.id) return "query row has no id";
    if (ids.has(query.id)) return `duplicate query id: ${query.id}`;
    const hasR5 = Object.prototype.hasOwnProperty.call(query, "r@5");
    const hasRefusal = Object.prototype.hasOwnProperty.call(query, "refusal_ok");
    if (hasR5 === hasRefusal) return "each query requires exactly one score kind (r@5 or refusal_ok)";
    if (hasR5) {
      if (!validRate(query["r@5"])) return `query ${query.id} r@5 must be finite in [0,1]`;
      content++;
      contentTotal += query["r@5"];
    } else {
      if (typeof query.refusal_ok !== "boolean") return `query ${query.id} refusal_ok must be boolean`;
      refusal++;
    }
    ids.add(query.id);
  }
  if (content !== report.n_content || refusal !== report.n_refusal) return "query score kinds disagree with content/refusal counts";
  const expectedRecall = content ? contentTotal / content : 0;
  if (Math.abs(report.recall["r@5"]! - expectedRecall) > 1e-12) return "benchmark recall r@5 disagrees with query rows";
  return null;
}

function compatibleQueryIds(report: BenchReport): string[] | null {
  const ids = new Set<string>();
  for (const query of report.per_query) {
    if (typeof query.id !== "string" || !query.id || ids.has(query.id)) return null;
    ids.add(query.id);
  }
  return [...ids].sort();
}

function queryScoreKinds(report: BenchReport): Record<string, "r@5" | "refusal_ok"> {
  return Object.fromEntries(
    report.per_query.map((query) => [
      query.id,
      Object.prototype.hasOwnProperty.call(query, "r@5") ? "r@5" : "refusal_ok",
    ]),
  );
}

// Sequential judgement gates, regression-block first (rule ordering studied from kytmanov's
// compare harness; identifiers and vocabulary are our own).
export function judgeArms(current: ArmResult, challenger: ArmResult): Verdict {
  const currentMalformed = malformedArmReason(current);
  const challengerMalformed = malformedArmReason(challenger);
  if (currentMalformed || challengerMalformed) {
    const details = [
      currentMalformed ? `current: ${currentMalformed}` : "",
      challengerMalformed ? `challenger: ${challengerMalformed}` : "",
    ].filter(Boolean).join("; ");
    return v("keep", `malformed arm report (${details})`, null, {}, {});
  }
  const structural: Record<string, number> = {
    lintHealth: challenger.lintHealth - current.lintHealth,
    linkIntegrity: challenger.linkIntegrity - current.linkIntegrity,
  };

  // 1. challenger partial (more build failures) → keep
  if (challenger.build_failures > current.build_failures) {
    return v("keep", "challenger build partial (more ingest failures)", null, {}, structural);
  }

  // A comparison is evidence only when both arms scored the same non-empty query set. Treating a
  // missing or partially-overlapping set as `undecided` exits zero in the CLI and lets a broken arm
  // pass CI. Fail closed before calculating deltas; the caller can repair/regenerate the arm.
  if (!current.bench || !challenger.bench) {
    return v("keep", "missing benchmark evidence on one or both arms", null, {}, structural);
  }
  if (
    current.bench.n !== current.bench.per_query.length ||
    challenger.bench.n !== challenger.bench.per_query.length
  ) {
    return v("keep", "incomplete benchmark evidence (declared query count differs from scored rows)", null, {}, structural);
  }
  if (
    !current.bench.query_set_fingerprint ||
    !challenger.bench.query_set_fingerprint ||
    current.bench.subset !== challenger.bench.subset ||
    current.bench.query_set_fingerprint !== challenger.bench.query_set_fingerprint
  ) {
    return v("keep", "incompatible benchmark evidence (subset or golden definitions differ)", null, {}, structural);
  }
  const currentIds = compatibleQueryIds(current.bench);
  const challengerIds = compatibleQueryIds(challenger.bench);
  if (!currentIds || !challengerIds) {
    return v("keep", "invalid benchmark evidence (missing scores or duplicate query ids)", null, {}, structural);
  }
  if (currentIds.length === 0 || JSON.stringify(currentIds) !== JSON.stringify(challengerIds)) {
    return v("keep", "incompatible benchmark query sets (ids must match exactly and be non-empty)", null, {}, structural);
  }
  const currentKinds = queryScoreKinds(current.bench);
  const challengerKinds = queryScoreKinds(challenger.bench);
  const changedKindId = currentIds.find((id) => currentKinds[id] !== challengerKinds[id]);
  if (changedKindId) {
    return v(
      "keep",
      `incompatible benchmark score kinds (query ${changedKindId} changed between r@5 and refusal_ok)`,
      null,
      {},
      structural,
    );
  }

  // per-query deltas (only ids scored on both arms)
  const deltas: Record<string, number> = {};
  const a = queryScores(current.bench);
  const b = queryScores(challenger.bench);
  for (const id of currentIds) deltas[id] = b[id]! - a[id]!;
  const ds = Object.values(deltas);
  const avg = ds.length ? ds.reduce((s, x) => s + x, 0) / ds.length : null;

  // 2. regression block — strongest signal
  if (avg !== null && (ds.some((d) => d < -0.1) || avg <= -0.05)) {
    return v("keep", "query regression (a delta < -0.10 or avg <= -0.05)", avg, deltas, structural);
  }
  // 3. structural regression
  if (Object.values(structural).some((d) => d < -0.05)) {
    return v("keep", "structural regression (lint/link health)", avg, deltas, structural);
  }
  // 4. nothing measurable
  if (avg === null) {
    return v("undecided", "no shared golden queries scored on both arms", avg, deltas, structural);
  }
  // 5. clear win
  if (avg > 0.1) {
    return v("adopt", "avg query delta > +0.10", avg, deltas, structural);
  }
  // 6. pages changed and something improved
  const pagesChanged = challenger.pages !== current.pages;
  if (pagesChanged && (ds.some((d) => d > 0) || Object.values(structural).some((d) => d > 0))) {
    return v("adopt", "output changed with a positive query/structural delta", avg, deltas, structural);
  }
  return v("undecided", "no decisive delta", avg, deltas, structural);
}

function v(
  verdict: Verdict["verdict"],
  reason: string,
  avg: number | null,
  deltas: Record<string, number>,
  structural: Record<string, number>,
): Verdict {
  return { verdict, reason, avg_query_delta: avg, per_query_deltas: deltas, structural_deltas: structural };
}

// ---- arm build (the only LLM-bearing step) ---------------------------------------------

export interface ArmOpts {
  label: string;
  corpusDir: string; // directory of frozen transcript files (.jsonl / .md / .txt)
  templateRepo?: string; // copy docs/wiki/.bench (golden set) from here into the arm
  keep?: boolean; // keep the temp workspace for inspection
  topic?: boolean; // also run the consolidate (5_topic) pass — needed to test the merge rubric
  writeModel?: string;
  verifyModel?: string;
}

export async function runArm(opts: ArmOpts): Promise<{ result: ArmResult; workspace: string; out: string }> {
  const corpus = resolve(opts.corpusDir);
  if (!existsSync(corpus)) throw new Error(`corpus dir not found: ${corpus}`);
  const files = readdirSync(corpus)
    .filter((f) => !f.startsWith("."))
    .sort()
    .map((f) => join(corpus, f));
  if (!files.length) throw new Error(`corpus dir is empty: ${corpus}`);

  // mkdtemp, not a derivable name: the arm workspace lives in a possibly shared temp dir.
  const ws = mkdtempSync(join(tmpdir(), `llmwiki-compare-${opts.label}-`));
  mkdirSync(join(ws, "docs", "wiki"), { recursive: true });
  // golden set travels with the arm so scoreArm can bench it
  if (opts.templateRepo) {
    const bench = join(resolve(opts.templateRepo), "docs", "wiki", ".bench");
    if (existsSync(bench)) cpSync(bench, join(ws, "docs", "wiki", ".bench"), { recursive: true });
  }

  // Copy the corpus into the arm workspace and ingest the COPIES — never the originals,
  // whose central capture-queue watermarks must stay untouched (see header note).
  const corpusCopy = join(ws, "corpus");
  mkdirSync(corpusCopy, { recursive: true });
  let failures = 0;
  for (const f of files) {
    const copy = join(corpusCopy, f.split("/").pop()!);
    cpSync(f, copy);
    try {
      const r = await ingest(ws, copy, { commit: true, repo: ws });
      if (String(r.verdict ?? "").startsWith("fail")) failures += 1;
    } catch {
      failures += 1;
    }
  }

  // Topic pass (P0-2): consolidate the freshly-built log layer into 5_topic. Only this
  // path exercises the WRITE_TOPIC_PROMPT merge rubric, so it must run to compare rubric
  // versions. consolidate reads the same repo-scoped capture rows the ingests just wrote.
  if (opts.topic) {
    const results = await consolidate.run(ws, true, 0, opts.writeModel, opts.verifyModel);
    failures += results.filter((r) => String(r.verdict ?? "").startsWith("fail")).length;
  }

  const result = scoreArm(ws, opts.label, { corpus: files.length, failures });
  const out = join(process.cwd(), `compare_${opts.label}.json`);
  writeFileSync(out, JSON.stringify(result, null, 2));
  if (!opts.keep) rmSync(ws, { recursive: true, force: true });
  return { result, workspace: opts.keep ? ws : "(removed)", out };
}

export function loadArm(path: string): ArmResult {
  return JSON.parse(readFileSync(resolve(path), "utf-8")) as ArmResult;
}
