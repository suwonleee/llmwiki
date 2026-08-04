// Unspaced-script segmentation, shared by the two retrieval surfaces.
//
// turncontext.ts has always sliced unspaced runs into word-sized windows for its per-turn OR
// query; search()'s sanitize path did not, and the difference was measured (2026-08-04, mixed
// JA+EN / ZH+EN fixtures): turn-context resolved every mixed prompt while `search` returned
// 0/4 on unspaced natural-language queries — the whole clause became one quoted phrase, and a
// quoted trigram phrase is a VERBATIM substring requirement no page satisfies for a question
// ("…了怎么办"). One segmentation, one home; both callers import it from here.

// Scripts written without spaces between words. A run of these is a whole CLAUSE, not a word,
// and a clause is a literal substring no page will ever contain — so runs are sliced into
// word-sized windows rather than queried whole. Hangul is deliberately absent: Korean puts
// spaces between words, so its runs already arrive word-sized.
// Script_Extensions, not Script: the prolonged-sound mark "ー" that ends マイグレーション is
// Script=Common, so a plain Script= class breaks the run in half at exactly the wrong place.
// (Known scx quirk, measured harmless: CJK punctuation like 、 carries scx=Han, so a window can
// straddle it — the junk window simply matches nothing while its siblings carry the retrieval.)
export const UNSPACED_CHAR =
  "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
export const UNSPACED_RUN_RE = new RegExp(`[${UNSPACED_CHAR}]{3,}`, "gu");
export const UNSPACED_ONLY_RE = new RegExp(`^[${UNSPACED_CHAR}]+$`, "u");

// Window size straddles the CJK word-length distribution (Chinese words and Japanese kanji
// compounds cluster at 2-4 characters; katakana loanwords run longer and are covered by
// overlapping windows), and 8 windows bound the term budget for arbitrarily long clauses.
const UNSPACED_WINDOW = 4;
const UNSPACED_MAX_WINDOWS = 8;

export function unspacedWindows(run: string): string[] {
  const chars = [...run];
  if (chars.length <= UNSPACED_WINDOW + 1) return [run];
  // Spread the windows over the whole run: a fixed stride would cover only its head.
  const stride = Math.max(2, Math.ceil((chars.length - UNSPACED_WINDOW) / (UNSPACED_MAX_WINDOWS - 1)));
  const out: string[] = [];
  for (let i = 0; i + UNSPACED_WINDOW <= chars.length; i += stride) {
    out.push(chars.slice(i, i + UNSPACED_WINDOW).join(""));
  }
  return out;
}
