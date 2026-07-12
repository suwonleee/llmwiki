// distill-verify — deterministic no-loss gate for topic-page re-distillation (deep pass D3).
//
// The deep pass may rewrite an oversized 5_topic page from its cited transcripts (raw
// re-grounding — the one rewrite the anti-drift rule allows). A rewrite is destructive, and
// "keep every citation" as prose alone is enforced at the model's whim — the same failure
// mode the review cadence gate (--if-due) exists for. This check makes the mechanical half
// of the no-loss contract engine-enforced, LLM-0:
//   1. citation superset — every footnote SOURCE cited on the old page is still cited on the
//      new page (set semantics: two old footnotes to one source may merge into one);
//   2. conflict callouts — every `> [conflict]` line survives verbatim.
// Claim-level fidelity still needs the model (diff against the pre-distill snapshot); this
// gate just makes the checkable part deterministic. Uses the same citation parser as lint,
// so "source" here means exactly what lint resolves.
import { readFileSync } from "node:fs";
import { parseCitationFilename } from "./refs.ts";

const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.+)$/gm;

/** Distinct citation source filenames (lowercased) defined by a page's footnotes. */
export function footnoteSources(content: string): Set<string> {
  const out = new Set<string>();
  for (const m of content.matchAll(FOOTNOTE_DEF)) {
    const [filename] = parseCitationFilename(m[2]!);
    if (filename) out.add(filename.toLowerCase());
  }
  return out;
}

/** `> [conflict] …` callout lines (trimmed) — must survive a distill verbatim. */
export function conflictLines(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("> [conflict]"));
}

export interface DistillVerdict {
  ok: boolean;
  oldSources: number;
  newSources: number;
  droppedSources: string[]; // cited on the old page, absent from the new — hard fail
  droppedConflicts: string[]; // conflict callouts that did not survive verbatim — hard fail
}

export function verifyDistill(oldContent: string, newContent: string): DistillVerdict {
  const before = footnoteSources(oldContent);
  const after = footnoteSources(newContent);
  const droppedSources = [...before].filter((s) => !after.has(s)).sort();
  const survived = new Set(conflictLines(newContent));
  const droppedConflicts = conflictLines(oldContent).filter((l) => !survived.has(l));
  return {
    ok: droppedSources.length === 0 && droppedConflicts.length === 0,
    oldSources: before.size,
    newSources: after.size,
    droppedSources,
    droppedConflicts,
  };
}

/** File-path convenience for the CLI. Throws on unreadable paths (caller surfaces). */
export function verifyDistillFiles(oldPath: string, newPath: string): DistillVerdict {
  return verifyDistill(readFileSync(oldPath, "utf-8"), readFileSync(newPath, "utf-8"));
}
