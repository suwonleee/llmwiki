// bench.ts — deterministic retrieval benchmark (P0-1a). LLM-0, runs in ms.
//
// Measures the two read paths against a per-repo golden query set:
//   • search any-hit@k (r@k: 1 if ANY target page is in the top-k, else 0 — averaged;
//     metric family studied from mempalace's LongMemEval runs)
//   • turn-context behaviour: pointer hit for content queries, SILENCE for refusal
//     queries (kytmanov's must_refuse, made structural: our turn-context contract
//     is "no confident pointer → say nothing", so refusal-correct ⟺ empty output)
//
// Golden set lives in <repo>/docs/wiki/.bench/golden.toml — co-located with the wiki,
// git-tracked, and invisible to the indexer. Results go to the engine-held bench/ (project-state.ts)
// (derived state, disposable). Anti-contamination is discipline-based (as mempalace
// documents): a seeded
// deterministic tune/sealed split (tune = look freely while iterating; sealed = final-check only — every look weakens it) + subset-tagged result files + discipline (the CLI
// warns when the sealed subset is opened) rather than a hard lock.
//
// This is an ENGINE-DEV tool: never wired into wiki-save/sync loops (zero per-session
// cost). Run it when search/turn-context/prompt logic changes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WikiIndex, dedupeByPage } from "./db.ts";
import { ensureProjectStateDir } from "./project-state.ts";
import { buildTurnContext } from "./turncontext.ts";
import { buildContext } from "./context.ts";
import {
  discoverClaudeTranscripts,
  pickTranscripts,
  scanTranscript,
  summarizeDownstreamRead,
  type DownstreamReadReport,
} from "./downstream-read.ts";

export interface BenchQuery {
  id: string;
  question: string;
  target_pages: string[]; // repo-relative wiki paths; empty for refusal queries
  must_refuse?: boolean;
  // Optional labels. `lang` is the language the question is ASKED in — a team whose wiki is in one
  // language and whose members ask in another needs to see reach per language, not averaged.
  lang?: string;
  // Where the answer exists outside this wiki: readable in the code, reconstructable from git
  // history, or nowhere ("wiki_only" — a rejected alternative and its reason, a trap someone hit
  // once). The share labelled wiki_only is the honest answer to "why keep a wiki at all".
  recoverable_from?: "code" | "git" | "wiki_only";
}

export interface BenchSplit {
  tune: string[];
  sealed: string[];
  seed: number;
}

const BENCH_DIR = ["docs", "wiki", ".bench"];
const KS = [1, 5, 10];

export function benchDir(root: string): string {
  return join(root, ...BENCH_DIR);
}

export function loadQueries(root: string): BenchQuery[] {
  const dir = benchDir(root);
  const tomlPath = join(dir, "golden.toml");
  const jsonPath = join(dir, "golden.json");
  let queries: BenchQuery[];
  if (existsSync(tomlPath)) {
    const doc = (Bun as any).TOML.parse(readFileSync(tomlPath, "utf-8")) as any;
    queries = (doc.query ?? []) as BenchQuery[];
  } else if (existsSync(jsonPath)) {
    queries = JSON.parse(readFileSync(jsonPath, "utf-8")) as BenchQuery[];
  } else {
    return [];
  }
  const seen = new Set<string>();
  for (const q of queries) {
    if (!q.id || !q.question) throw new Error(`bench query missing id/question: ${JSON.stringify(q)}`);
    if (seen.has(q.id)) throw new Error(`duplicate bench query id: ${q.id}`);
    seen.add(q.id);
    q.target_pages = (q.target_pages ?? []).map((p) => p.replace(/\\/g, "/"));
  }
  return queries;
}

// Deterministic seeded shuffle (mulberry32) — same ids + same seed → same split, always.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ensureSplit(root: string, queries: BenchQuery[], seed = 42): BenchSplit {
  const p = join(benchDir(root), "split.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")) as BenchSplit;
  const ids = queries.map((q) => q.id).sort(); // sort first: split independent of file order
  const rnd = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  const tuneSize = Math.max(1, Math.floor(ids.length / 2));
  const split: BenchSplit = { tune: ids.slice(0, tuneSize), sealed: ids.slice(tuneSize), seed };
  mkdirSync(benchDir(root), { recursive: true });
  writeFileSync(p, JSON.stringify(split, null, 2));
  return split;
}

export function hitAtK(expected: string[], ranked: string[], k: number): number {
  if (!expected.length) return 0;
  const top = new Set(ranked.slice(0, k).map((r) => r.toLowerCase()));
  return expected.some((e) => top.has(e.toLowerCase())) ? 1 : 0;
}

// Ranked unique page paths from chunk-level search rows (best-rank order preserved).
// Chunk hits → ranked distinct page paths. Shares dedupeByPage with the `search` CLI so the
// bench measures the same page ordering a reader actually sees.
function rankedPages(rows: any[]): string[] {
  return dedupeByPage(rows).map((r) => String(r.relative_path ?? ""));
}

// Turn-context pointer lines look like `  • Title  →  docs/wiki/...`; silence is "".
function tcPages(tc: string): string[] {
  return [...tc.matchAll(/→\s+(\S+)/g)].map((m) => m[1]!);
}

// What reaches a session that never runs a command. The two channels are the whole story:
// cold start injects L0 once, unconditionally; turn-context injects pointers per prompt, only when
// confident. Everything a model can do with the wiki unasked is downstream of these two.
export interface PassiveReport {
  reach: number; // share of content questions a pointer reached WITHOUT anyone asking
  silence: number; // share of off-topic prompts that correctly got nothing
  coldstart_bytes: number; // per-session constant, paid once
  turn_bytes_p50: number; // per-turn cost, median
  turn_bytes_p95: number; // per-turn cost, tail
  irreplaceable: number; // share of questions labelled answerable from the wiki and nowhere else
  by_lang: Record<string, { n: number; reach: number }>; // reach, content questions only
  by_lang_silence: Record<string, { n: number; reach: number }>; // silence, refusal prompts only
  by_recoverability: Record<string, { n: number; reach: number }>;
}

export interface BenchReport {
  subset: string;
  query_set_fingerprint: string; // selected golden definitions, not just ids
  n: number;
  recall: Record<string, number>; // "r@1" | "r@5" | "r@10" over content queries
  tc_pointer_hit: number; // share of content queries where turn-context pointed at an expected page
  tc_refusal_ok: number; // share of refusal queries where turn-context stayed silent
  n_content: number;
  n_refusal: number;
  passive: PassiveReport;
  // What happened AFTER a pointer arrived, read off real captured sessions (downstream-read.ts).
  // Opt-in: null unless asked for, so the golden benchmark never depends on this machine's
  // transcript history — the same repo must score the same on someone else's laptop.
  downstream_read: DownstreamReadReport | null;
  per_query: Record<string, any>[];
}

// Stable correctness-only projection for a public CI baseline. The full BenchReport deliberately
// keeps useful local observations (absolute-root-bearing byte costs and optional captured-session
// follow-through), but those are properties of the machine running the bench rather than retrieval
// semantics. A baseline must contain only values that the same checked-out fixture reproduces on
// every supported OS and must sort query identities so fixture file order cannot churn the report.
export interface BenchBaseline {
  schema_version: 1;
  query_set_fingerprint: string;
  n: number;
  n_content: number;
  n_refusal: number;
  recall: Record<string, number>;
  tc_pointer_hit: number;
  tc_refusal_ok: number;
  passive: Pick<
    PassiveReport,
    "reach" | "silence" | "irreplaceable" | "by_lang" | "by_lang_silence" | "by_recoverability"
  >;
  per_query: Array<{
    id: string;
    "r@1"?: number;
    "r@5"?: number;
    "r@10"?: number;
    tc_hit?: boolean;
    refusal_ok?: boolean;
    lang?: string;
    recoverable_from?: string;
  }>;
}

type RateMap = Record<string, { n: number; reach: number }>;

function sortedRates(input: RateMap): RateMap {
  return Object.fromEntries(Object.keys(input).sort().map((key) => [key, { ...input[key]! }]));
}

/** Project a full report into the versioned, environment-independent public baseline contract. */
export function toBenchBaseline(report: BenchReport): BenchBaseline {
  const perQuery = report.per_query.map((row) => {
    const projected: BenchBaseline["per_query"][number] = { id: String(row.id) };
    for (const key of ["r@1", "r@5", "r@10"] as const) {
      if (typeof row[key] === "number") projected[key] = row[key];
    }
    if (typeof row.tc_hit === "boolean") projected.tc_hit = row.tc_hit;
    if (typeof row.refusal_ok === "boolean") projected.refusal_ok = row.refusal_ok;
    if (typeof row.lang === "string") projected.lang = row.lang;
    if (typeof row.recoverable_from === "string") projected.recoverable_from = row.recoverable_from;
    return projected;
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schema_version: 1,
    query_set_fingerprint: report.query_set_fingerprint,
    n: report.n,
    n_content: report.n_content,
    n_refusal: report.n_refusal,
    recall: Object.fromEntries(Object.keys(report.recall).sort().map((key) => [key, report.recall[key]!])),
    tc_pointer_hit: report.tc_pointer_hit,
    tc_refusal_ok: report.tc_refusal_ok,
    passive: {
      reach: report.passive.reach,
      silence: report.passive.silence,
      irreplaceable: report.passive.irreplaceable,
      by_lang: sortedRates(report.passive.by_lang),
      by_lang_silence: sortedRates(report.passive.by_lang_silence),
      by_recoverability: sortedRates(report.passive.by_recoverability),
    },
    per_query: perQuery,
  };
}

export interface BenchOptions {
  // Measure pointer→Read follow-through from captured transcripts. Off by default.
  downstreamRead?: boolean;
  // Explicit transcript files; when absent, the newest `transcriptLimit` Claude sessions.
  transcripts?: readonly string[];
  transcriptLimit?: number;
}

const DEFAULT_TRANSCRIPT_LIMIT = 30;

function querySetFingerprint(queries: readonly BenchQuery[]): string {
  const canonical = [...queries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((query) => ({
      id: query.id,
      question: query.question,
      target_pages: [...query.target_pages].sort(),
      must_refuse: query.must_refuse === true,
      lang: query.lang ?? null,
      recoverable_from: query.recoverable_from ?? null,
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function runBench(
  ws: string,
  subset: "all" | "tune" | "sealed" = "all",
  options: BenchOptions = {},
): BenchReport {
  const root = resolve(ws);
  const queries = loadQueries(root);
  if (!queries.length) {
    throw new Error(`no golden queries — create ${join(...BENCH_DIR)}/golden.toml first`);
  }
  let selected = queries;
  if (subset !== "all") {
    const split = ensureSplit(root, queries);
    const keep = new Set(split[subset]);
    selected = queries.filter((q) => keep.has(q.id));
  }

  const idx = new WikiIndex(root);
  const conn = idx.connect();
  const per: Record<string, any>[] = [];
  const sums: Record<string, number> = {};
  const turnBytes: number[] = [];
  // Kept apart on purpose: reach and silence are different questions, and averaging them into one
  // per-language number would hide which of the two a language is failing.
  const byLang: Record<string, { n: number; hits: number }> = {};
  const byLangSilence: Record<string, { n: number; hits: number }> = {};
  const byRecoverability: Record<string, { n: number; hits: number }> = {};
  let tcHits = 0;
  let refusalOk = 0;
  let nContent = 0;
  let nRefusal = 0;
  let wikiOnly = 0;
  let labelled = 0;
  try {
    for (const q of selected) {
      const tc = buildTurnContext(root, q.question); // no sessionId → no dedup state
      turnBytes.push(Buffer.byteLength(tc, "utf-8"));
      if (q.must_refuse) {
        nRefusal += 1;
        const ok = tc.trim() === "";
        refusalOk += ok ? 1 : 0;
        tally(byLangSilence, q.lang, ok);
        per.push({ id: q.id, refusal_ok: ok, lang: q.lang });
        continue;
      }
      nContent += 1;
      // search() returns CHUNK rows — fetch 5× the deepest k so page-level dedup still
      // yields a full top-10 page list (10 chunks can collapse into 3-8 pages).
      const ranked = rankedPages(idx.search(conn, q.question, Math.max(...KS) * 5, "wiki"));
      const row: Record<string, any> = { id: q.id, top: ranked.slice(0, 3) };
      for (const k of KS) {
        const v = hitAtK(q.target_pages, ranked, k);
        row[`r@${k}`] = v;
        sums[`r@${k}`] = (sums[`r@${k}`] ?? 0) + v;
      }
      const pointed = tcPages(tc);
      const hit = q.target_pages.some((e) => pointed.some((p) => p.toLowerCase() === e.toLowerCase()));
      row["tc_hit"] = hit;
      tcHits += hit ? 1 : 0;
      tally(byLang, q.lang, hit);
      tally(byRecoverability, q.recoverable_from, hit);
      if (q.recoverable_from === "wiki_only") wikiOnly += 1;
      if (q.recoverable_from) labelled += 1;
      row["lang"] = q.lang;
      row["recoverable_from"] = q.recoverable_from;
      per.push(row);
    }
  } finally {
    conn.close();
  }

  const recall: Record<string, number> = {};
  for (const k of KS) recall[`r@${k}`] = nContent ? (sums[`r@${k}`] ?? 0) / nContent : 0;
  const reach = nContent ? tcHits / nContent : 0;
  const silence = nRefusal ? refusalOk / nRefusal : 0;
  return {
    subset,
    query_set_fingerprint: querySetFingerprint(selected),
    n: selected.length,
    recall,
    tc_pointer_hit: reach,
    tc_refusal_ok: silence,
    n_content: nContent,
    n_refusal: nRefusal,
    passive: {
      reach,
      silence,
      // The cold-start channel is a per-session constant, not an average over queries: every
      // session pays it once, whatever is asked. Reported as the one number it is.
      coldstart_bytes: Buffer.byteLength(buildContext(root), "utf-8"),
      turn_bytes_p50: percentile(turnBytes, 0.5),
      turn_bytes_p95: percentile(turnBytes, 0.95),
      // Claimed only for what a human actually labelled. An unlabelled golden set claims nothing.
      irreplaceable: labelled ? wikiOnly / labelled : 0,
      by_lang: rates(byLang),
      by_lang_silence: rates(byLangSilence),
      by_recoverability: rates(byRecoverability),
    },
    downstream_read: options.downstreamRead ? measureDownstreamRead(options) : null,
    per_query: per,
  };
}

// Reads captured transcripts — never the wiki, never the turn path. Kept out of the loop above so
// a plain runBench() touches no session history at all.
function measureDownstreamRead(options: BenchOptions): DownstreamReadReport {
  const files = options.transcripts?.length
    ? [...options.transcripts]
    : pickTranscripts(discoverClaudeTranscripts(), options.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT);
  return summarizeDownstreamRead(files.map((f) => scanTranscript(f)));
}

function tally(into: Record<string, { n: number; hits: number }>, key: string | undefined, hit: boolean): void {
  if (!key) return;
  const e = (into[key] ??= { n: 0, hits: 0 });
  e.n += 1;
  if (hit) e.hits += 1;
}

function rates(counts: Record<string, { n: number; hits: number }>): Record<string, { n: number; reach: number }> {
  const out: Record<string, { n: number; reach: number }> = {};
  for (const key of Object.keys(counts).sort()) {
    const e = counts[key]!;
    out[key] = { n: e.n, reach: e.n ? e.hits / e.n : 0 };
  }
  return out;
}

// Nearest-rank on a sorted copy: no interpolation, so the number is always one a real turn paid.
function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function writeResults(root: string, report: BenchReport): string {
  const dir = ensureProjectStateDir(root, "bench");
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const p = join(dir, `results_${report.subset}_${ts}.json`);
  writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}
