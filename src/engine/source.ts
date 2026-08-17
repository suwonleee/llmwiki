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

export interface MaterializationResult {
  session: DiscoveredSession | null;
  error?: unknown;
}

/**
 * Stage 1 of discovery: WHERE a session belongs, and nothing else.
 *
 * Discovery walks other tools' transcript stores, which hold conversations from every project on
 * the machine — including repositories the user never enrolled. Answering "which repo is this?"
 * needs a session id and a working directory; it does not need the conversation. So routing is a
 * separate, deliberately impoverished stage: bounded bytes, bounded records, no message bodies,
 * no exported files. Only after `isEnrolled(route.repo)` says yes does `materialize()` run and
 * touch the actual content.
 */
export interface DiscoveredRoute {
  path: string;
  sessionId: string | null;
  repo: string | null;
  /** Exact backing store selected during routing (for database-backed sources). */
  sourcePath?: string;
  /** Existing file whose size represents this route when `path` is a stable logical identity. */
  changePath?: string;
  /** Harness-owned revision token for logical/database-backed routes. */
  revision?: string;
  /** The source has no reliable file-size revision token and must be checked every sweep. */
  alwaysMaterialize?: boolean;
}

// Routing limits and helpers live in a leaf module (sources/routing.ts) so the adapters can use
// them without importing values from here — this file imports the adapters, and a value cycle
// would leave the registry uninitialized. Re-exported for callers that already import from here.
export {
  ROUTE_MAX_BYTES,
  ROUTE_MAX_RECORDS,
  countLines,
  discoverViaRoutes,
  routeNeedsMaterialization,
} from "./sources/routing.ts";

export interface ParseOpts {
  minChars?: number;
  cap?: number;
}

export interface TranscriptSource {
  readonly kind: string; // "claude-jsonl" | "codex" | "plain" …
  // Stage 1: routing metadata only (bounded, no message bodies, no exports). Ingest-only
  // sources return [].
  discoverRoutes(): DiscoveredRoute[];
  // Stage 2: count the work and, where the harness needs it (OpenCode), materialize the export.
  // The daemon calls this ONLY for routes whose repository is enrolled.
  materialize(route: DiscoveredRoute): DiscoveredSession | null;
  // Optional sweep batch. Results preserve route order and isolate errors per route.
  materializeMany?(routes: readonly DiscoveredRoute[]): MaterializationResult[];
  discover(): DiscoveredSession[]; // convenience composition; sources may retain their trust gate
  // Stage 1 for ONE path (the watcher fast path): same bounded budget as discoverRoutes.
  // Omitted → this adapter has no file-watch entry point.
  routeFor?(path: string): DiscoveredRoute | null;
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
