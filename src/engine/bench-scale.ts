// Deterministic generated scale corpus and observational benchmark.
//
// The corpus bytes, query identities and phase order are fixed. Timings are intentionally REPORTS,
// never pass/fail thresholds: CI verifies correctness and report shape while scheduler, filesystem
// and SQLite variance remain visible as median/p95 evidence rather than a flaky gate.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WikiIndex } from "./db.ts";
import { enroll, resetEnrollmentCache } from "./enrollment.ts";
import { evictRegenerable, projectStatePath, resetProjectStateCache } from "./project-state.ts";
import {
  appendRepoFile,
  ensureRepoDir,
  readRepoDir,
  removeRepoFile,
  repoFileMetadata,
  writeRepoFile,
} from "./repo-write.ts";
import { setEffectiveStateRoot } from "./state-dir.ts";
import { buildTurnContext } from "./turncontext.ts";

export const SCALE_TIERS = [10, 100, 1000] as const;
const TOPIC_DIR = join("docs", "wiki", "5_topic");

export interface ScaleQuery {
  readonly question: string;
  readonly target: string;
}

export interface ScaleFixture {
  readonly pages: number;
  readonly queries: readonly ScaleQuery[];
}

export interface SampleSummary {
  readonly median: number;
  readonly p95: number;
  readonly samples: readonly number[];
}

export interface ScaleReport {
  readonly schema_version: 1;
  readonly pages: number;
  readonly repeats: number;
  readonly queries_per_repeat: number;
  readonly search_hit_rate: number;
  readonly context_hit_rate: number;
  readonly timings_ms: {
    readonly cold_index: SampleSummary;
    readonly noop_index: SampleSummary;
    readonly edit_index: SampleSummary;
    readonly search: SampleSummary;
    readonly context: SampleSummary;
  };
  readonly resources: {
    readonly source_bytes: SampleSummary;
    readonly index_bytes: SampleSummary;
  };
}

export interface ScaleSuiteReport {
  readonly schema_version: 1;
  readonly repeats: number;
  readonly tiers: readonly ScaleReport[];
  readonly gating: "correctness-only; timing and resource distributions are observational";
}

function marker(index: number): string {
  return `scalemarker${String(index).padStart(6, "0")}`;
}

function filename(index: number): string {
  return `scale-page-${String(index).padStart(6, "0")}.md`;
}

function queriesFor(pages: number): ScaleQuery[] {
  const wanted = new Set([0, Math.floor(pages / 4), Math.floor(pages / 2), Math.floor((pages * 3) / 4), pages - 1]);
  return [...wanted].sort((a, b) => a - b).map((index) => ({
    question: `where is ${marker(index)} documented`,
    target: `docs/wiki/5_topic/${filename(index)}`,
  }));
}

export function generateScaleFixture(root: string, pages: number): ScaleFixture {
  if (!Number.isInteger(pages) || pages < 1) throw new Error("scale pages must be a positive integer");
  ensureRepoDir(root, TOPIC_DIR);
  for (const entry of readRepoDir(root, TOPIC_DIR)) {
    if (entry.isFile && /^scale-page-\d{6}\.md$/.test(entry.name)) {
      removeRepoFile(root, join(TOPIC_DIR, entry.name));
    }
  }
  for (let index = 0; index < pages; index += 1) {
    const identity = marker(index);
    const body = [
      "---",
      `title: Scale page ${String(index).padStart(6, "0")} ${identity}`,
      `description: Deterministic generated scale record for ${identity}`,
      "date: 2026-08-09",
      "tags: [scale, benchmark]",
      "status: ready",
      "domain: topic",
      "---",
      "",
      `${identity} identifies exactly one generated page in the public scale corpus.`,
      "The deterministic body keeps enough text for the chunk floor while avoiding relevance ties.",
      "Cold indexing, no-op indexing, edit indexing, search, and context use the same source bytes.",
      "Runtime distributions are observational evidence and never absolute continuous-integration gates.",
      "Resource distributions report source and derived-index bytes without reading private transcripts.",
      "Every generated tier is local-first, dependency-free, reproducible, and safe to delete after measurement.",
      "",
    ].join("\n");
    writeRepoFile(root, join(TOPIC_DIR, filename(index)), body);
  }
  return { pages, queries: queriesFor(pages) };
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (!samples.length) return { median: 0, p95: 0, samples: [] };
  const sorted = [...samples].sort((a, b) => a - b);
  const nearest = (percentile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)]!;
  return { median: nearest(0.5), p95: nearest(0.95), samples: [...samples] };
}

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return Number((performance.now() - started).toFixed(3));
}

export function repoTreeBytes(
  root: string,
  relativeDir: string,
  metadataFor: typeof repoFileMetadata = repoFileMetadata,
): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readRepoDir(root, dir)) {
      const relativePath = join(dir, entry.name);
      if (entry.isDirectory) walk(relativePath);
      else if (entry.isFile) {
        const metadata = metadataFor(root, relativePath);
        if (!metadata) throw new Error(`scale corpus metadata unavailable: ${relativePath}`);
        total += metadata.size;
      }
    }
  };
  walk(relativeDir);
  return total;
}

function indexBytes(root: string): number {
  let total = 0;
  for (const name of ["index.db", "index.db-wal", "index.db-shm"]) {
    const path = projectStatePath(root, name);
    if (existsSync(path)) total += statSync(path).size;
  }
  return total;
}

export function measureScaleWorkspace(root: string, repeats = 5): ScaleReport {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("scale repeats must be a positive integer");
  const pages = readRepoDir(root, TOPIC_DIR).filter(
    (entry) => entry.isFile && /^scale-page-\d{6}\.md$/.test(entry.name),
  ).length;
  if (!pages) throw new Error("scale workspace has no generated pages");
  const queries = queriesFor(pages);
  const samples = {
    cold_index: [] as number[], noop_index: [] as number[], edit_index: [] as number[],
    search: [] as number[], context: [] as number[], source_bytes: [] as number[], index_bytes: [] as number[],
  };
  let searchHits = 0;
  let contextHits = 0;

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    generateScaleFixture(root, pages);
    evictRegenerable(projectStatePath(root));
    const index = new WikiIndex(root);
    samples.cold_index.push(elapsed(() => { index.indexAll(); }));
    samples.noop_index.push(elapsed(() => { index.indexAll(); }));
    appendRepoFile(root, join(TOPIC_DIR, filename(Math.floor(pages / 2))), `edit pass ${repeat}\n`);
    samples.edit_index.push(elapsed(() => { index.indexAll(); }));

    const connection = index.connect();
    samples.search.push(elapsed(() => {
      for (const query of queries) {
        const paths = index.search(connection, query.question, 20, "wiki").map((row) => row.relative_path);
        if (paths.includes(query.target)) searchHits += 1;
      }
    }));
    connection.close();
    samples.context.push(elapsed(() => {
      for (const query of queries) {
        if (buildTurnContext(root, query.question).includes(query.target)) contextHits += 1;
      }
    }));
    samples.source_bytes.push(repoTreeBytes(root, join("docs", "wiki")));
    samples.index_bytes.push(indexBytes(root));
  }

  const attempts = repeats * queries.length;
  return {
    schema_version: 1,
    pages,
    repeats,
    queries_per_repeat: queries.length,
    search_hit_rate: attempts ? searchHits / attempts : 0,
    context_hit_rate: attempts ? contextHits / attempts : 0,
    timings_ms: {
      cold_index: summarizeSamples(samples.cold_index),
      noop_index: summarizeSamples(samples.noop_index),
      edit_index: summarizeSamples(samples.edit_index),
      search: summarizeSamples(samples.search),
      context: summarizeSamples(samples.context),
    },
    resources: {
      source_bytes: summarizeSamples(samples.source_bytes),
      index_bytes: summarizeSamples(samples.index_bytes),
    },
  };
}

function initRepo(path: string): void {
  const result = spawnSync("git", ["init", "-q", path], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr ?? ""}`);
  const enrolled = enroll(path);
  if (!enrolled.ok) throw new Error(`scale enrollment failed: ${enrolled.error}`);
}

/** Run every public tier in isolated local state and return a JSON-serializable evidence report. */
export function runScaleSuite(repeats = 5, tiers: readonly number[] = SCALE_TIERS): ScaleSuiteReport {
  const scratch = mkdtempSync(join(tmpdir(), "llmwiki-scale-suite-"));
  setEffectiveStateRoot(join(scratch, "state"));
  try {
    const reports: ScaleReport[] = [];
    for (const pages of tiers) {
      const root = join(scratch, `repo-${pages}`);
      initRepo(root);
      generateScaleFixture(root, pages);
      reports.push(measureScaleWorkspace(root, repeats));
    }
    return {
      schema_version: 1,
      repeats,
      tiers: reports,
      gating: "correctness-only; timing and resource distributions are observational",
    };
  } finally {
    resetEnrollmentCache();
    resetProjectStateCache();
    setEffectiveStateRoot(null);
    rmSync(scratch, { recursive: true, force: true });
  }
}
