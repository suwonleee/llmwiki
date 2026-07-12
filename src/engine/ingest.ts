// `llmwiki ingest <workspace> <file>` — condense an arbitrary source file into the wiki
// WITHOUT the daemon and (for capture-only) without an LLM. This is the harness-neutral
// "drop a source" entry point: it picks the right adapter for the file, records the debt
// in the central capture queue, then reuses the exact same gated WRITE→VERIFY→LINT→
// file-back pass the autoupdate loop uses (autoupdate.updateOne).
//
// Two modes fall out of one path:
//   • capture-only — no LLM CLI present → the row is enqueued (debt recorded), updateOne
//     reports a write failure; nothing is fabricated. (the "drop into raw" path.)
//   • full condense — LLM CLI present → a grounded page is written under --repo's wiki.
import { resolve } from "node:path";
import * as capture from "./capture.ts";
import * as update from "./update.ts";
import { updateOne } from "./autoupdate.ts";
import { sourceForKind, sourceForPath } from "./source.ts";

export interface IngestOpts {
  repo?: string; // routing/destination repo for the produced page (default: probe repo or cwd)
  commit?: boolean; // false = dry-run (default)
  source?: string; // force a specific adapter kind (else inferred from the path)
  force?: boolean; // reset the watermark to 0 so an edited re-drop re-condenses fully
}

export async function ingest(
  ws: string,
  file: string,
  opts: IngestOpts = {},
): Promise<Record<string, any>> {
  const path = resolve(file);
  update.ensureSkeleton(ws);

  const src = opts.source ? sourceForKind(opts.source) : sourceForPath(path);
  const probed = src.probe(path);
  const repo = opts.repo ? resolve(opts.repo) : probed?.repo ?? process.cwd();
  const sessionId = probed?.sessionId ?? null;
  const lines = probed?.lines ?? 0;

  // --force: reset an existing row's watermark so an edited re-drop is re-read from the top.
  if (opts.force) capture.mark(path, 0, "pending");
  capture.enqueue(path, sessionId, repo, lines, src.kind);

  // Reuse the gated condense pass. updateOne re-selects the parser by the row's source_kind,
  // so a plain drop is parsed as plain and a claude jsonl as claude — no special-casing here.
  const result = await updateOne(ws, path, !!opts.commit);
  result.source_kind = src.kind;
  result.repo = repo;
  return result;
}
