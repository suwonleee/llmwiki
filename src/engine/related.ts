// Same-topic pending sessions — the optional weave-in surface for a close-out.
//
// /wiki-save is O(this session) and the backlog is self-selection, not debt (2026-07-28). The one
// case where a PAST un-filed session is worth surfacing at close-out is when it talked about the
// SAME topic this session is filing right now — weaving it in enriches the very pages being
// written, at the moment they are warm. This module finds those candidates deterministically:
// no LLM, bounded I/O, and candidates only — it never recommends, the caller decides.
//
// Precision rule (measured, 2026-07-28): matching against RAW transcript text is self-polluting —
// llmwiki's own injections (cold-start banner, turn-context pointers) appear in every session's
// transcript, so a naive substring scan matched 60 of 60 pending sessions. Both sides therefore
// compare the HUMAN's utterances only (`Increment.users`) — assistant prose and tool output never
// vote — MINUS the user-ROLE text the harness feeds on the human's behalf (see humanSaid below):
// a skill body is recorded as a user turn, so every session that ran /wiki-save shares the skill's
// own vocabulary, and that alone gate-passed 8 of 59 real pending sessions.
import { getSourceKind, pending, type CaptureRow } from "./capture.ts";
import { sourceForKind } from "./source.ts";
import { extractTerms, termWeight } from "./turncontext.ts";

const MAX_CANDIDATES = 3;
// Stricter than turn-context's gate (2): a pointer costs one glance, a surfaced session invites
// a whole weave-in. Two distinct terms AND weight ≥ 4 (= two specific terms, or one specific
// plus two weak) keeps the everyday off-topic session out.
const MIN_DISTINCT = 2;
const MIN_SCORE = 4;

export interface RelatedCandidate {
  path: string;
  sessionId: string | null;
  score: number;
  matched: string[];
  recap: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Copy-pasteable command with both path arguments kept as inert shell argv. */
export function renderUpdateNextCommand(repo: string, transcript: string): string {
  return `llmwiki update-next ${shellQuote(repo)} ${shellQuote(transcript)}`;
}

// User-ROLE turns the harness wrote, not the human: an invoked skill's markdown body ("# /wiki-…"
// heading) and Claude Code's local-command records. They carry heavy shared vocabulary, so one
// invocation anywhere makes two sessions "related". Narrow by design — when in doubt, keep the
// turn: a lost paste costs a little recall, a kept skill body costs the whole precision gate.
const FED_TURN_RE = /^#{1,3} \/|<command-name>|<local-command-caveat>|<command-message>/;

function humanSaid(text: string): boolean {
  return !FED_TURN_RE.test(text.trimStart());
}

/** The human's own utterances in the transcript, plus the session id seen there.
 *  Full parse, no byte window: measured 46ms for a 1.5MB anchor and 448ms for a 59-file/208MB
 *  backlog — and a window biased to either end misses sessions whose last (or first) stretch is
 *  tool output, which is exactly what a close-out burst looks like. */
function userText(path: string, kind: string): { text: string; sessionId: string | null } {
  try {
    const inc = sourceForKind(kind).parse(path, 0);
    return {
      text: inc.users.map((u) => u.text).filter(humanSaid).join("\n"),
      sessionId: inc.sessionId ?? null,
    };
  } catch {
    return { text: "", sessionId: null }; // unreadable/foreign format → simply not a candidate
  }
}

/** Weighted overlap between the anchor's terms and one candidate's utterance text. Pure. */
export function scoreAgainst(terms: string[], text: string): { score: number; matched: string[] } {
  const lc = text.toLowerCase();
  const matched = terms.filter((t) => lc.includes(t.toLowerCase()));
  return { score: matched.reduce((s, t) => s + termWeight(t), 0), matched };
}

/** Rank the given pending rows against pre-extracted anchor terms. Exported for tests. */
export function relatedFromRows(
  rows: CaptureRow[],
  anchorPath: string,
  anchorSession: string | null,
  terms: string[],
): RelatedCandidate[] {
  if (!terms.length) return [];
  const out: RelatedCandidate[] = [];
  const seenSessions = new Set<string>();
  for (const row of rows) {
    if (row.transcript_path === anchorPath) continue;
    if (anchorSession && row.session_id === anchorSession) continue;
    if (row.session_id && seenSessions.has(row.session_id)) continue; // one vote per session
    const cand = userText(row.transcript_path, row.source_kind);
    if (!cand.text.trim()) continue;
    const { score, matched } = scoreAgainst(terms, cand.text);
    if (matched.length < MIN_DISTINCT || score < MIN_SCORE) continue;
    if (row.session_id) seenSessions.add(row.session_id);
    let recap: string | null = null;
    try {
      recap = sourceForKind(row.source_kind).recapFor?.(row.transcript_path) ?? null;
    } catch {
      /* recap is decoration only */
    }
    out.push({ path: row.transcript_path, sessionId: row.session_id, score, matched, recap });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

/** Same-topic pending sessions for the repo's queue, anchored on this session's transcript. */
export function relatedPending(repo: string, anchorTranscript: string): RelatedCandidate[] {
  const anchor = userText(anchorTranscript, getSourceKind(anchorTranscript));
  if (!anchor.text.trim()) return [];
  return relatedFromRows(pending(repo), anchorTranscript, anchor.sessionId, extractTerms(anchor.text));
}
