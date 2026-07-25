// Which language is this text written in — judged on PROSE, never on code.
//
// The engine needs this to answer "what language is this session working in" when nobody has
// configured one. Wiki pages are deliberately full of code terms (identifiers, paths, commands are
// kept verbatim as the language-invariant search anchors), so a naive letter count reads a Korean
// page about `parseAmount` in `src/parser.ts` as English. Everything code-shaped is stripped first;
// what remains is scored by script, which is decisive for the languages we ship catalogs for.
//
// Returns null when there is not enough prose to have an opinion — the caller then falls back
// rather than guessing.
import type { WikiLang } from "./config.ts";

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`]*`/g;
const URL = /\bhttps?:\/\/\S+/g;
const MD_LINK_TARGET = /\]\([^)]*\)/g;
const WIKI_LINK = /\[\[[^\]]*\]\]/g;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:.*$/gm;
// path-ish / identifier-ish ASCII: src/engine/db.ts · parseAmount · --dry-run · UPPER_SNAKE
const CODEY_ASCII = /[A-Za-z_$][A-Za-z0-9_$]*(?:[./\-:][A-Za-z0-9_$]+)+|--?[A-Za-z][\w-]*/g;

const HANGUL = /[가-힣]/g;
const KANA = /[぀-ヿ]/g;
const HAN = /[一-鿿]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

// Enough signal to be worth acting on. CJK carries far more meaning per character than a Latin
// letter, so the two floors differ.
const MIN_CJK_CHARS = 8;
const MIN_LATIN_WORDS = 12;

/** Strip everything that is code, a path, or a link target — what is left is prose. */
export function proseOnly(text: string): string {
  return text
    .replace(FRONTMATTER, "")
    .replace(FENCED_CODE, " ")
    .replace(INLINE_CODE, " ")
    .replace(URL, " ")
    .replace(MD_LINK_TARGET, " ")
    .replace(WIKI_LINK, " ")
    .replace(FOOTNOTE_DEF, " ")
    .replace(CODEY_ASCII, " ");
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/**
 * The language of this text, or null when the prose is too thin to tell.
 *
 * Script decides: Hangul → Korean. Kana → Japanese (Japanese prose essentially always has kana).
 * Han without kana → Chinese. Otherwise Latin words → English.
 */
export function detectLang(text: string): WikiLang | null {
  const prose = proseOnly(text);
  const hangul = count(prose, HANGUL);
  const kana = count(prose, KANA);
  const han = count(prose, HAN);

  const cjk = [
    { lang: "ko" as const, score: hangul },
    { lang: "ja" as const, score: kana > 0 ? kana + han : 0 },
    { lang: "zh" as const, score: kana > 0 ? 0 : han },
  ].sort((a, b) => b.score - a.score)[0]!;
  if (cjk.score >= MIN_CJK_CHARS) return cjk.lang;

  return count(prose, LATIN_WORD) >= MIN_LATIN_WORDS ? "en" : null;
}

/** The language of a corpus: the majority verdict of the samples that had an opinion. */
export function detectLangOfMany(samples: readonly string[]): WikiLang | null {
  const votes = new Map<WikiLang, number>();
  for (const sample of samples) {
    const lang = detectLang(sample);
    if (lang) votes.set(lang, (votes.get(lang) ?? 0) + 1);
  }
  if (votes.size === 0) return null;
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
