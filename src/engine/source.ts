// Transcript source abstraction — the seam that makes capture harness-neutral.
//
// A TranscriptSource factors out the ONLY two Claude-specific responsibilities left in
// the pipeline: discovery (which transcript files exist) and parse (raw bytes → a
// format-neutral Increment). Everything downstream — the byte-offset watermark, the
// capture_queue, and the entire WRITE/VERIFY/LINT condense loop — consumes the neutral
// Increment and never sees the wire format. Claude jsonl is one adapter; `plain` gives a
// daemon-free / Claude-free "drop a source" path; a future Codex adapter slots in with
// zero core changes.
import type { Increment } from "./extract.ts";
import { claudeJsonlSource } from "./sources/claude.ts";
import { codexSource } from "./sources/codex.ts";
import { opencodeSource } from "./sources/opencode.ts";
import { plainSource } from "./sources/plain.ts";

export interface DiscoveredSession {
  path: string;
  sessionId: string | null;
  repo: string | null; // routing key (cwd for claude; --repo/cwd for plain)
  lines: number;
}

export interface ParseOpts {
  minChars?: number;
  cap?: number;
}

export interface TranscriptSource {
  readonly kind: string; // "claude-jsonl" | "codex" | "plain" …
  discover(): DiscoveredSession[]; // daemon-side sweep; ingest-only sources return []
  probe(path: string): DiscoveredSession | null; // cheap meta; null if this isn't my format
  parse(path: string, startOffset: number, opts?: ParseOpts): Increment; // byte-tail → neutral
  // Optional: directory roots the daemon's chokidar fast-path should watch for this format.
  // Omitted (e.g. plain) → not watched (poll/ingest only). Lets the daemon stay format-generic.
  watchRoots?(): string[];
  // Optional: one-line recap of a session, read from artifacts the harness ALREADY wrote
  // (Claude: ai-title / last-prompt jsonl records) — no LLM, bounded I/O (head+tail only).
  // Used by cold-start to show WHAT the un-condensed backlog sessions were about, not just
  // how many there are ("harness memory is raw material, the wiki is the record of record").
  // Omitted → cold-start falls back to the count-only line.
  recapFor?(path: string): string | null;
  // Optional: a session summary the harness ALREADY generated (Claude: session-memory
  // summary.md / inline compact summary; Codex: memories/rollout_summaries). Surfaced by
  // `update-next` as draft material so the condense pass doesn't re-summarize from scratch —
  // claims must still be grounded in the raw extract (summary = material, wiki = record).
  // Omitted / null → condense works from the raw extract alone (current behavior).
  summaryFor?(path: string): string | null;
}

// Order is LOAD-BEARING: the greedy `plain` adapter (probe matches any readable text) MUST
// be last so a real format (claude/codex) gets first claim in sourceForPath()'s probe chain.
const REGISTRY: TranscriptSource[] = [claudeJsonlSource, codexSource, opencodeSource, plainSource];

export function sources(): TranscriptSource[] {
  return REGISTRY;
}

// Sources the daemon auto-captures from (everything that actually discovers files). Used by
// the chokidar fast-path to resolve a changed file to its adapter without claiming arbitrary
// drops as `plain`.
export function discoverableSources(): TranscriptSource[] {
  return REGISTRY.filter((s) => s.kind !== "plain");
}

// queue row → parser (condense side). Unknown/legacy kind falls back to claude (the
// historical default) so old capture rows keep parsing correctly.
export function sourceForKind(kind: string): TranscriptSource {
  return REGISTRY.find((s) => s.kind === kind) ?? claudeJsonlSource;
}

// path → adapter (ingest / single-file side). First source whose probe() claims the path
// wins; falls back to plain (the universal drop target).
export function sourceForPath(path: string): TranscriptSource {
  for (const s of REGISTRY) {
    if (s.probe(path)) return s;
  }
  return plainSource;
}
