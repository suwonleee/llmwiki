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

export interface BenchQuery {
  id: string;
  question: string;
  target_pages: string[]; // repo-relative wiki paths; empty for refusal queries
  must_refuse?: boolean;
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

export interface BenchReport {
  subset: string;
  n: number;
  recall: Record<string, number>; // "r@1" | "r@5" | "r@10" over content queries
  tc_pointer_hit: number; // share of content queries where turn-context pointed at an expected page
  tc_refusal_ok: number; // share of refusal queries where turn-context stayed silent
  n_content: number;
  n_refusal: number;
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
  let tcHits = 0;
  let refusalOk = 0;
  let nContent = 0;
  let nRefusal = 0;
  try {
    for (const q of selected) {
      const tc = buildTurnContext(root, q.question); // no sessionId → no dedup state
      if (q.must_refuse) {
        nRefusal += 1;
        const ok = tc.trim() === "";
        refusalOk += ok ? 1 : 0;
        per.push({ id: q.id, refusal_ok: ok });
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
      per.push(row);
    }
  } finally {
    conn.close();
  }

  const recall: Record<string, number> = {};
  for (const k of KS) recall[`r@${k}`] = nContent ? (sums[`r@${k}`] ?? 0) / nContent : 0;
  return {
    subset,
    n: selected.length,
    recall,
    tc_pointer_hit: nContent ? tcHits / nContent : 0,
    tc_refusal_ok: nRefusal ? refusalOk / nRefusal : 0,
    n_content: nContent,
    n_refusal: nRefusal,
    per_query: per,
  };
}

export function writeResults(root: string, report: BenchReport): string {
  const dir = join(resolve(root), ".llmwiki", "bench");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const p = join(dir, `results_${report.subset}_${ts}.json`);
  writeFileSync(p, JSON.stringify(report, null, 2));
  return p;
}
