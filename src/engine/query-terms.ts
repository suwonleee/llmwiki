// Query terms of a natural-language prompt — shared by turn-context and wiki search (page-rank.ts).
import { UNSPACED_ONLY_RE, UNSPACED_RUN_RE, unspacedWindows } from "./segment.ts";

const MAX_TERMS = 12;

// ---- term extraction (deterministic, language-neutral) ------------------------

// ASCII identifier-ish tokens: words, dotted/slashed paths, snake/kebab identifiers.
// ≥4 chars keeps "the/and/for"-class noise out without a stopword list. Runs FIRST so
// `src/engine/db.ts` stays one term instead of being cut at every separator.
export const ASCII_RE = /[A-Za-z_][A-Za-z0-9_./-]{3,}/g;

// Unspaced-script handling (runs → word-sized windows) lives in segment.ts, shared with
// search()'s relax path — one segmentation, measured against the same fixtures, two callers.

// Any other script's words. \p{M} keeps combining marks attached, so "überhaupt" and Vietnamese
// "ngôn" survive whole — the ASCII pattern above cannot even start on ü, and used to hand back
// the fragment "berhaupt". Without this pass, Cyrillic, Thai, Devanagari, Arabic, Greek and
// Hebrew prompts yielded NOTHING and the turn injected nothing, ever.
// Two characters is the minimum here, not three: `add()` below is what enforces the per-script
// floor (ASCII 4, dense 3), and a two-character candidate is needed by the sub-floor pass — in
// Hangul the everyday technical words ARE two characters (토큰·만료·검사·배포). Latin two-letter
// matches are produced and then dropped by that same floor, so the default path is unchanged.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_]{1,}/gu;

// Nominal josa, longest first — the particles a Korean prompt glues onto exactly the noun the
// retrieval needs. Scoring compares by SUBSTRING, so a suffixed form such as "배포안을" matches
// no page that contains only "배포안". Keep the generic regression shape here; never publish a
// real user's prompt or corpus evidence in this public implementation.
// Suffix-strip is not stemming: only case particles come off, one layer, and the ORIGINAL token is
// always kept too — this can only add recall, never lose an exact match. Verb endings are left
// alone on purpose (stripping 하자/보자 would need real morphology to stay honest).
const JOSA_SUFFIXES = [
  "에서는", "에서도", "으로는", "으로도",
  "에서", "에게", "으로", "까지", "부터", "처럼", "보다", "조차", "마저", "이나", "라도", "와는", "과는",
  "은", "는", "이", "가", "을", "를", "에", "의", "도", "로", "와", "과", "만",
] as const;

export function stripJosa(t: string): string | null {
  if (/^[\x00-\x7F]+$/.test(t)) return null; // particles are a dense-script phenomenon
  for (const j of JOSA_SUFFIXES) {
    if (t.length > j.length && t.endsWith(j)) return t.slice(0, t.length - j.length);
  }
  return null;
}

// Question endings. A wiki states things; it almost never contains "…되나요?", so the asked form
// only took a slot from a real term. The form comes off and only what remains can match.
const QUESTION_END = /(?:인가요|나요|까요|가요)$/u;
// 하다/되다 endings on a noun stem — the shape most Korean technical verbs take (승인할 · 처리되는데
// · 재사용해도). One layer, stem of two or more characters, original kept: like josa, this can only
// add recall. Other verb endings stay untouched for the reason given above.
const HADA_END = /^(.{2,}?)(?:되는데|하는데|되는지|하는지|되어도|되면|하면|되고|하고|해도|해서|되어|됩니다|합니다|되지|하지|된|한|할|될|되|하)$/u;
const SUB_FLOOR_MAX = MAX_TERMS;

const isAscii = (t: string): boolean => /^[\x00-\x7F]+$/.test(t);

/** Candidate terms in prompt order, before any length ranking or cap. */
function candidates(prompt: string, denseFloor: number): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const push = (t: string, floor: number): void => {
    if ([...t].length < floor) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };
  const add = (raw: string): void => {
    const t = raw.replace(/[./-]+$/, ""); // trim trailing punctuation-ish tail
    // 3 is the FTS5 trigram matching floor; Latin gets 4, because that is what keeps the
    // "the/and/for" class out without a stopword list. A dense script needs no such margin —
    // three characters of Hangul or Han are already a content word.
    if (isAscii(t)) return push(t, 4);
    const asked = t.replace(QUESTION_END, "");
    const hada = HADA_END.exec(asked)?.[1] ?? null;
    // The asked form itself is never a term; without a 하다/되다 stem, what remains (바뀌 · 갈라지)
    // still matches the page's own inflection.
    if (asked === t) push(t, denseFloor);
    else if (!hada) push(asked, denseFloor);
    for (const stem of [stripJosa(asked), hada]) if (stem) push(stem, denseFloor);
  };
  for (const m of prompt.matchAll(ASCII_RE)) add(m[0]!);
  for (const m of prompt.matchAll(UNSPACED_RUN_RE)) for (const w of unspacedWindows(m[0]!)) add(w);
  for (const m of prompt.matchAll(WORD_RE)) {
    if (UNSPACED_ONLY_RE.test(m[0]!)) continue; // already windowed above; the whole run cannot match
    add(m[0]!);
  }
  return terms;
}

export function extractTerms(prompt: string, denseFloor = 3): string[] {
  // longer = more specific; keep the most specific MAX_TERMS
  return candidates(prompt, denseFloor).sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

/** Two-character dense-script words below the trigram floor — 승인·예산·배포 — in prompt order with
 * their own cap. Drawn from the uncapped candidates: taking them from the length-ranked list cut
 * every one of them on long prompts, which are exactly the prompts that carry them. */
export function subFloorTerms(prompt: string, main: readonly string[]): string[] {
  const taken = new Set(main.map((t) => t.toLowerCase()));
  return candidates(prompt, 2)
    .filter((t) => !isAscii(t) && [...t].length === 2 && !taken.has(t.toLowerCase()))
    .slice(0, SUB_FLOOR_MAX);
}


// Confidence weight of one matched term. Korean particles ("데몬이" vs "데몬(") routinely
// break one-of-two exact matches, so a pure distinct-count gate over-silences CJK prompts.
// Weighted instead: a long term is specific enough to stand alone (CJK run ≥5 — e.g.
// 트랜스크립트; ASCII identifier ≥8 — e.g. turncontext), short terms need a second witness.
// A term is "specific" (worth 2 of the 2 points the confidence gate needs) once it is long
// enough to be unlikely by chance. Non-ASCII scripts carry more meaning per character than
// English, so they reach that point sooner — one crude threshold rather than per-language tuning.
export function termWeight(t: string): number {
  const dense = /[^\x00-\x7F]/.test(t);
  return ([...t].length >= (dense ? 5 : 8)) ? 2 : 1;
}

