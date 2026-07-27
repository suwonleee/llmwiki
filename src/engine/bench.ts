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
// git-tracked, and invisible to the indexer (dot-dir). Results go to .llmwiki/bench/
// (derived state, disposable). Anti-contamination is discipline-based (as mempalace
// documents): a seeded
// deterministic tune/sealed split (tune = look freely while iterating; sealed = final-check only — every look weakens it) + subset-tagged result files + discipline (the CLI
// warns when the sealed subset is opened) rather than a hard lock.
//
// This is an ENGINE-DEV tool: never wired into wiki-save/sync loops (zero per-session
// cost). Run it when search/turn-context/prompt logic changes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WikiIndex, dedupeByPage } from "./db.ts";
import { buildTurnContext } from "./turncontext.ts";
import { buildContext } from "./context.ts";

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
  n: number;
  recall: Record<string, number>; // "r@1" | "r@5" | "r@10" over content queries
  tc_pointer_hit: number; // share of content queries where turn-context pointed at an expected page
  tc_refusal_ok: number; // share of refusal queries where turn-context stayed silent
  n_content: number;
  n_refusal: number;
  passive: PassiveReport;
  per_query: Record<string, any>[];
}

export function runBench(ws: string, subset: "all" | "tune" | "sealed" = "all"): BenchReport {
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
    per_query: per,
  };
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
  const dir = join(resolve(root), ".llmwiki", "bench");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const p = join(dir, `results_${report.subset}_${ts}.json`);
  writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}
