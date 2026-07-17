// Capture-queue reconciliation.
//
// Two write paths advance the wiki, but only one advances the capture watermark:
//   - programmatic `autoupdate` calls capture.mark(...'distilled')  → watermark moves
//   - warm `/wiki-fast` (in-session LLM writes pages directly)    → watermark does NOT move
// So sessions filed warm linger as `pending` forever, inflating the count and burying genuine
// backlog (the cold-start nag then cites an inflated number). Relying on the in-session LLM to
// remember `update-done` is the discipline-dependent failure mode we want gone.
//
// This reconciles the ledger against EVIDENCE, deterministically: a session is "reflected" iff a
// wiki page CITES its transcript (footnote `[^n]: <name>.jsonl` or frontmatter `source:`). Cited
// pending rows are advanced to distilled; only genuinely un-cited sessions remain pending. No LLM.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as capture from "./capture.ts";
import { getConfig } from "./config.ts";

function walkMarkdown(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // don't follow symlinks (avoids loops)
    const full = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
}

// Transcript basenames cited anywhere in the repo's wiki — scanned only on footnote-definition
// lines (`[^n]: …`) and frontmatter `source:` lines, so a `.jsonl` merely mentioned in prose is
// not mistaken for a citation.
export function citedTranscripts(repo: string): Set<string> {
  const files: string[] = [];
  walkMarkdown(join(repo, "docs", "wiki"), files);
  // The quiz layer is the HUMAN's notebook, not wiki coverage: a transcript cited inside a
  // quiz record must never mark that session as reflected — it would advance the capture
  // watermark and silently suppress the backlog nag (quiz.ts one-directional contract).
  const quizRoot = join(repo, "docs", "wiki", getConfig(repo).quizDir) + sep;
  const cited = new Set<string>();
  for (const f of files) {
    if (f.startsWith(quizRoot)) continue;
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!/^(\[\^[^\]]+\]:|source:)/.test(t)) continue;
      const m = t.match(/([^\s/\\]+\.jsonl)\b/i); // case-insensitive, matching the rest of the engine
      if (m) cited.add(m[1]!.toLowerCase());
    }
  }
  return cited;
}

export interface ReconcileResult {
  reconciled: string[]; // cited + watermark 0 → advanced pending → distilled
  deferred: string[]; // cited BUT byte_offset>0 (partially condensed) → safety-skipped; the tail
  //                     belongs to autoupdate/deep, NOT to the human. Cited ⇒ represented in the
  //                     wiki, so this is NOT backlog — reporting it as such was the honesty bug.
  backlog: string[]; // genuinely un-cited pending sessions (the true, human-facing backlog)
  commit: boolean;
}

// Advance a cited, warm-filed session to distilled (watermark → EOF). `commit=false` reports what
// WOULD reconcile without writing (mirrors the engine's dry-run-by-default convention).
//
// SAFETY: only sessions still at watermark 0 are advanced — those were filed
// purely warm (never programmatically condensed). A row with byte_offset>0 was PARTIALLY
// auto-condensed; jumping its watermark to EOF on a (possibly stale) citation would mark an
// un-condensed tail as done and lose it. Those rows are left pending for autoupdate to finish.
//
// REPORTING HONESTY: the three outcomes are distinct
// and must not be conflated. A cited-but-partial row is NOT "un-cited backlog" — its knowledge is
// already represented by the citing page; only its byte tail is deferred to autoupdate/deep. Only
// genuinely un-cited rows are the human-facing backlog worth nagging at cold-start; mislabeling
// deferred rows as backlog inflated the nag and summoned the human as a verifier (the
// human judges, the model does bookkeeping).
export function reconcileReflected(repo: string, commit = false): ReconcileResult {
  const citedSet = citedTranscripts(repo);
  const reconciled: string[] = [];
  const deferred: string[] = [];
  const backlog: string[] = [];
  for (const row of capture.pending(repo)) {
    const bn = basename(row.transcript_path);
    const cited = citedSet.has(bn.toLowerCase());
    if (cited && row.byte_offset === 0) {
      if (commit) {
        const size = existsSync(row.transcript_path)
          ? statSync(row.transcript_path).size
          : row.byte_offset;
        capture.mark(row.transcript_path, size, "distilled");
      }
      reconciled.push(bn);
    } else if (cited) {
      deferred.push(bn); // cited, byte_offset>0 — safety-skipped, tail for autoupdate/deep (not backlog)
    } else {
      backlog.push(bn); // genuinely un-cited — the real backlog
    }
  }
  return { reconciled, deferred, backlog, commit };
}

// The human-facing backlog: pending sessions that NO wiki page cites yet. The cold-start nag counts
// THIS (not raw capture.pending), so a cited-but-partial session (byte_offset>0, tail deferred to
// autoupdate/deep) and a cited session whose live transcript is still growing never inflate the
// first impression. Returns full rows so callers keep recap/mtime metadata. Same citation scan as
// reconcile — one source of truth for "is this session represented in the wiki?".
export function uncitedPending(repo: string): ReturnType<typeof capture.pending> {
  const citedSet = citedTranscripts(repo);
  return capture
    .pending(repo)
    .filter((row) => !citedSet.has(basename(row.transcript_path).toLowerCase()));
}
