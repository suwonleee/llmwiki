// Evidence excerpts (page format v3) — mint, render, parse, verify.
//
// A wiki page cites its session as `[^s1]: <id>.jsonl`, but that transcript lives on ONE machine.
// A teammate can read the citation and still not read the evidence. v3 persists 1–2 lines of the
// evidence itself onto an indented continuation line under the footnote, so grounding travels with
// the page:
//
//   [^s1]: 3bd9cac5-….jsonl
//       > [2026-06-29 14:02 user] "로그는 그대로 두고 그 위에 얹자"
//
// The footnote definition LINE stays byte-identical to v2 — four parsers read it (refs self-heal,
// lint footnote-def, lint graph, distill) and the self-heal one anchors end-of-line right after
// `.jsonl`. tests/page-format-v3.test.ts holds that invariant.
//
// Two excerpt classes, because two kinds of claim need different evidence:
//   • fact      — from grounding.ts tool events (what was actually edited/run/measured).
//                 Machine records: cannot be fabricated, so they need no verification.
//   • judgment  — a verbatim human utterance (what was decided, and why). This is what a
//                 decision/direction page actually asserts, and it is the class an LLM could
//                 invent — so it is machine-verified against the transcript (verifyExcerpt).
//
// Everything here passes screenSecrets before it is returned. That is a hard gate, not a policy:
// the raw material is a session transcript, which routinely contains credentials.
import { collectGroundedFacts, type GroundedFact } from "./grounding.ts";
import { extractIncrement } from "./extract.ts";
import { screenSecrets, REDACTED } from "./screen.ts";

// Per-excerpt character cap. Evidence is a pointer to grounding, not a second copy of the source;
// 200 chars holds a decision sentence while keeping a fully-cited page's evidence block bounded.
export const EXCERPT_MAX = 200;

// Below this many characters an excerpt carries no evidence worth persisting.
const EXCERPT_MIN = 12;

export interface Excerpt {
  kind: "fact" | "judgment";
  locator: string; // "2026-06-29 14:02 user" | "tool a3f9c2d1" — rendered inside [...]
  text: string; // screened + capped
  redactions: string[]; // pattern names that fired (never the values)
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= EXCERPT_MAX) return one;
  // Cut on a code-point boundary: a JS slice counts UTF-16 units, so a cap landing inside a
  // surrogate pair (any emoji in the transcript) leaves a lone surrogate that becomes U+FFFD
  // the moment the page is written as UTF-8 — and a corrupted excerpt then fails its own
  // verbatim check (unverified-excerpt), an error the author can neither read nor fix.
  let end = EXCERPT_MAX - 1;
  const cu = one.charCodeAt(end - 1);
  if (cu >= 0xd800 && cu <= 0xdbff) end -= 1; // high surrogate at the edge → back off the pair
  return one.slice(0, end).trimEnd() + "…";
}

// Screen → cap → reject if gutted or too short. The single funnel every candidate passes through.
function accept(kind: Excerpt["kind"], locator: string, raw: string): Excerpt | null {
  const screened = screenSecrets(clip(raw));
  if (screened.gutted) return null; // mostly-redacted quotes prove nothing
  const text = screened.text.trim();
  if (text.replace(new RegExp(REDACTED, "g"), "").trim().length < EXCERPT_MIN) return null;
  return { kind, locator, text, redactions: screened.redactions };
}

function factLocator(f: GroundedFact): string {
  return `tool ${f.spanHash.slice(0, 8)}`;
}

// "2026-06-29T14:02" (extract.ts slices timestamps to 16 chars) → "2026-06-29 14:02"
function turnLocator(ts: string, role: string): string {
  return `${ts.replace("T", " ")} ${role}`.trim();
}

/**
 * Candidate excerpts for a transcript window. Returns BOTH classes; the warm session picks which
 * one grounds the claim it is writing (the engine does not guess which claim a page will make).
 * Ordered most-recent-last, matching the transcript.
 */
export function mintExcerpts(
  transcriptPath: string,
  startOffset = 0,
  opts: { kind?: "claude-jsonl"; limit?: number } = {},
): Excerpt[] {
  // The limit is PER CLASS, not across both. A working session produces facts by the hundred and
  // judgments by the dozen (measured: 226 vs 23 in one real session), so a shared quota filled in
  // fact-then-judgment order starves judgments to zero — and judgments are the scarce class that
  // decision and direction pages actually need.
  const limit = Math.max(1, opts.limit ?? 20);
  const facts: Excerpt[] = [];
  const judgments: Excerpt[] = [];

  // facts — machine records, rendered straight from grounding.ts (no new extractor needed)
  let raw: GroundedFact[] = [];
  try {
    raw = collectGroundedFacts(transcriptPath, startOffset, opts.kind ?? "claude-jsonl").facts;
  } catch {
    raw = [];
  }
  for (const f of raw) {
    if (facts.length >= limit) break;
    const e = accept("fact", factLocator(f), f.detail);
    if (e) facts.push(e);
  }

  // judgments — human utterances, verbatim
  try {
    for (const t of extractIncrement(transcriptPath, startOffset).users) {
      if (judgments.length >= limit) break;
      const e = accept("judgment", turnLocator(t.ts, t.role), t.text);
      if (e) judgments.push(e);
    }
  } catch {
    /* unreadable transcript → facts only (or nothing); never throws into a close-out */
  }

  return [...facts, ...judgments];
}

/**
 * Attach evidence to a drafted page's footnotes, deterministically. Post-processing, not a prompt
 * instruction — same reasoning as update.ensureAuthor: a verbatim quote is exactly the thing a
 * generative pass should not be trusted to reproduce, and the engine already has the transcript
 * open. Only fills EMPTY footnotes and only for footnotes citing this transcript, so it can never
 * overwrite an excerpt a warm session chose.
 *
 * Judgment excerpts are preferred for pages that assert a decision; facts otherwise. When nothing
 * suitable survives screening the footnote is simply left bare — v3 is additive, never a blocker.
 */
export function ensureExcerpts(page: string, transcriptPath: string, startOffset = 0): string {
  const already = new Set(parseExcerpts(page).map((e) => e.footnote));
  const bare = [...page.matchAll(/^\[\^([^\]]+)\]:\s*([^\s/]+\.jsonl)\s*$/gm)].filter(
    (m) => !already.has(m[1]!),
  );
  if (!bare.length) return page;

  const candidates = mintExcerpts(transcriptPath, startOffset, { limit: 4 });
  if (!candidates.length) return page;

  const domain = /^domain:\s*(\S+)/m.exec(page)?.[1] ?? "";
  const judgmentPage = domain === "decision" || domain === "direction";
  const pick =
    (judgmentPage ? candidates.find((c) => c.kind === "judgment") : undefined) ??
    candidates.find((c) => c.kind === "fact") ??
    candidates[0]!;

  // One excerpt, on the first bare footnote citing this session: enough to make the page's
  // grounding portable without padding every footnote with the same quote.
  //
  // The definition regex ends in `\s*$`, so the match swallows its own trailing newline. Split it
  // back off before inserting — a blank line between the definition and its continuation detaches
  // the excerpt from the footnote in strict markdown renderers.
  const matched = bare[0]![0];
  const defLine = matched.replace(/\s+$/, "");
  const trailing = matched.slice(defLine.length);
  return page.replace(matched, `${defLine}\n${renderExcerpt(pick)}${trailing}`);
}

/** The indented continuation line that goes directly under a footnote definition. */
export function renderExcerpt(e: Excerpt): string {
  const body = e.kind === "judgment" ? `"${e.text}"` : e.text;
  return `    > [${e.locator}] ${body}`;
}

// Evidence lines as they appear in a page: 2+ spaces, ">", "[locator]", then the body.
const EXCERPT_LINE_RE = /^[ \t]{2,}>[ \t]*\[([^\]]*)\][ \t]*(.*)$/;

export interface ParsedExcerpt {
  footnote: string; // the footnote id this evidence belongs to ("s1")
  locator: string;
  text: string; // quotes stripped
  line: number; // 1-based line number, for lint messages
}

/**
 * Read back the evidence attached to each footnote. Attribution is positional: an evidence line
 * belongs to the nearest footnote definition above it, which is exactly how a markdown reader
 * (and a human) reads it.
 */
export function parseExcerpts(page: string): ParsedExcerpt[] {
  const out: ParsedExcerpt[] = [];
  let current: string | null = null;
  const lines = page.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const def = /^\[\^([^\]]+)\]:/.exec(line);
    if (def) {
      current = def[1]!;
      continue;
    }
    const m = EXCERPT_LINE_RE.exec(line);
    if (m && current) {
      out.push({
        footnote: current,
        locator: (m[1] ?? "").trim(),
        text: (m[2] ?? "").trim().replace(/^"|"$/g, ""),
        line: i + 1,
      });
      continue;
    }
    // A blank line keeps the footnote in scope (evidence may sit a line below); any other
    // non-evidence content ends it, so a later quote can't be misattributed upward.
    if (line.trim() !== "") current = null;
  }
  return out;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Is this excerpt actually present in the transcript? A judgment excerpt is a quote the LLM chose,
 * so it is the one thing here that could be invented — this makes that machine-checkable, the same
 * substring-against-evidence trick assessGrounding uses.
 *
 * Redaction-aware: a screened excerpt no longer matches verbatim, so every surviving segment must
 * appear instead. Segments shorter than EXCERPT_MIN are skipped — they carry no discriminating
 * power and would pass against almost any corpus.
 *
 * Returns null when the transcript is unreadable (a teammate's machine): NOT a failure. Callers
 * must treat null as "cannot verify here" and skip, or v3 turns every shared page into a lint
 * error — the precise outcome it exists to prevent.
 */
export function verifyExcerpt(text: string, transcriptPath: string, startOffset = 0): boolean | null {
  let corpus: string;
  try {
    const inc = extractIncrement(transcriptPath, startOffset);
    const ev = collectGroundedFacts(transcriptPath, startOffset);
    corpus = normalize(
      [...inc.users, ...inc.assistants].map((t) => t.text).join("\n") +
        "\n" +
        ev.corpus +
        "\n" +
        ev.facts.map((f) => f.detail).join("\n"),
    );
  } catch {
    return null; // transcript absent/unreadable → undecidable, never false
  }
  if (!corpus) return null;

  const segments = text
    .split(REDACTED)
    .map((s) => normalize(s.replace(/…$/, "")))
    .filter((s) => s.length >= EXCERPT_MIN);
  if (!segments.length) return null; // nothing discriminating left to check
  return segments.every((s) => corpus.includes(s));
}
