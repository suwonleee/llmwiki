// Harness-neutral per-turn context builder — the fine-grained sibling of
// the cold-start read loop (context.ts).
//
// Given the user's just-submitted prompt, deterministically surface AT MOST a few wiki-page
// POINTERS (title → path) whose content lexically matches the prompt. Any harness that can
// run a command on prompt submission injects the stdout:
//   Claude Code / Codex → UserPromptSubmit hook (stdin JSON carries {prompt, session_id, cwd})
//   OpenCode            → plugin (experimental.chat.system.transform) shelling out to the CLI
//
// Precision-first policy (the anti-debt line):
//   • pointers only, never page bodies (Read-on-demand, same as cold-start's index lines)
//   • at most MAX_PAGES lines; SILENT (empty output) when confidence is low
//   • no stopword lists, no per-language tuning — length floors + a ≥2-distinct-term
//     confidence gate are the whole relevance model; anything smarter belongs to an
//     LLM-scored layer, not here
//   • never breaks a session: every failure path returns "" (adapters also exit 0)
//
// Works with the trigram FTS (schema.sql). Term extraction is language-neutral in the literal
// sense — EVERY writing system, not just the two that happen to be easy: ASCII identifier-ish
// tokens (any user language keeps code terms in ASCII), word runs in any script, and word-sized
// windows over scripts that write without spaces. Everything is floored at 3 characters, the
// FTS5 trigram matching floor; shorter terms cannot match and are dropped.
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { WikiIndex } from "./db.ts";
import { isRepoKorean, effectiveKo, getConfig } from "./config.ts";
import { COLD_INDEX_RELATIVE_PATH } from "./cold-index.ts";

const MAX_TERMS = 12;
const MAX_PAGES = 3;
// Header language + L0/meta page names resolve per repo at call time (per-repo config).
const HEADS = {
  en: "----- [llmwiki turn-context] wiki pages related to this prompt (pointers — Read on demand) -----",
  ko: "----- [llmwiki turn-context] 이 프롬프트와 관련된 위키 페이지 (포인터 — 필요 시 Read) -----",
};

// ---- term extraction (deterministic, language-neutral) ------------------------

// ASCII identifier-ish tokens: words, dotted/slashed paths, snake/kebab identifiers.
// ≥4 chars keeps "the/and/for"-class noise out without a stopword list. Runs FIRST so
// `src/engine/db.ts` stays one term instead of being cut at every separator.
const ASCII_RE = /[A-Za-z_][A-Za-z0-9_./-]{3,}/g;

// Scripts written without spaces between words. A run of these is a whole CLAUSE, not a word,
// and a clause is a literal substring no page will ever contain — so runs are sliced into
// word-sized windows below rather than queried whole. Hangul is deliberately absent: Korean
// puts spaces between words, so its runs already arrive word-sized.
// Script_Extensions, not Script: the prolonged-sound mark "ー" that ends マイグレーション is
// Script=Common, so a plain Script= class breaks the run in half at exactly the wrong place.
const UNSPACED_CHAR =
  "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}";
const UNSPACED_RUN_RE = new RegExp(`[${UNSPACED_CHAR}]{3,}`, "gu");
const UNSPACED_ONLY_RE = new RegExp(`^[${UNSPACED_CHAR}]+$`, "u");

// Any other script's words. \p{M} keeps combining marks attached, so "überhaupt" and Vietnamese
// "ngôn" survive whole — the ASCII pattern above cannot even start on ü, and used to hand back
// the fragment "berhaupt". Without this pass, Cyrillic, Thai, Devanagari, Arabic, Greek and
// Hebrew prompts yielded NOTHING and the turn injected nothing, ever.
// Two characters is the minimum here, not three: `add()` below is what enforces the per-script
// floor (ASCII 4, dense 3), and a two-character candidate is needed by the sub-floor pass — in
// Hangul the everyday technical words ARE two characters (토큰·만료·검사·배포). Latin two-letter
// matches are produced and then dropped by that same floor, so the default path is unchanged.
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_]{1,}/gu;

// Window size for unspaced scripts — about a word in Han/Kana/Thai, and short enough to occur
// inside a page. Overlapping windows so a word straddling two of them is still covered.
const UNSPACED_WINDOW = 4;
const UNSPACED_MAX_WINDOWS = 8;

function unspacedWindows(run: string): string[] {
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

export function extractTerms(prompt: string, denseFloor = 3): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (raw: string): void => {
    const t = raw.replace(/[./-]+$/, ""); // trim trailing punctuation-ish tail
    // 3 is the FTS5 trigram matching floor; Latin gets 4, because that is what keeps the
    // "the/and/for" class out without a stopword list. A dense script needs no such margin —
    // three characters of Hangul or Han are already a content word.
    if ([...t].length < (/^[\x00-\x7F]+$/.test(t) ? 4 : denseFloor)) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };
  for (const m of prompt.matchAll(ASCII_RE)) add(m[0]!);
  for (const m of prompt.matchAll(UNSPACED_RUN_RE)) for (const w of unspacedWindows(m[0]!)) add(w);
  for (const m of prompt.matchAll(WORD_RE)) {
    if (UNSPACED_ONLY_RE.test(m[0]!)) continue; // already windowed above; the whole run cannot match
    add(m[0]!);
  }
  // longer = more specific; keep the most specific MAX_TERMS
  return terms.sort((a, b) => b.length - a.length).slice(0, MAX_TERMS);
}

// FTS5 query: every term as a quoted phrase (raw prompt text must never reach the MATCH
// parser — quotes/parens/operators in any language would be syntax errors). "" escapes ".
export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// ---- per-session state (disposable tmp) ----------------------------------------
// One tiny JSON per (session, repo) in the OS tmpdir. Two fields:
//   seen  — pages already suggested this session, never re-suggested (dedup, as before)
//   terms — HQE-lite (P1): terms extracted on PRIOR turns with a recency-decayed weight,
//           so a follow-up like "continue where we left off" still retrieves against the session's
//           accumulated topic. Deterministic and lexical (no LLM/embedding) — the carry-over
//           only ever ADDS query terms; the precision gate below still requires a current-
//           prompt term to match, so a topic switch cannot be polluted by stale terms.
//           Kill switch: LLMWIKI_TURNCTX_ACCUM=off → exact pre-P1 behavior.
// Losing the file only means a repeated suggestion / a colder query — harmless by design.
interface TurnState {
  seen: Set<string>;
  terms: Record<string, number>; // term → decayed weight
}

const ACCUM_DECAY = 0.5; // per turn
const ACCUM_MIN_WEIGHT = 0.25; // two silent turns and a term ages out
const ACCUM_MAX_CARRY = 4; // carried terms appended to the current query
const ACCUM_MAX_STORE = 24; // cap the stored map (top by weight)

function accumEnabled(): boolean {
  return (process.env.LLMWIKI_TURNCTX_ACCUM ?? "").trim().toLowerCase() !== "off";
}

/** Where this (session, repo) pair's disposable state lives. Exported for the boundary test. */
export function _turnStatePath(repo: string, sessionId: string): string {
  const h = createHash("sha1").update(`${sessionId}\n${repo}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `llmwiki-turnctx-${h}.json`);
}

// The state path is derivable (hash of session id + repo) and lives in a temp dir another local
// user may share, so both ends refuse to traverse a symlink planted there: O_NOFOLLOW turns that
// into ELOOP, which the callers below treat like any other unreadable/unwritable state — the turn
// keeps working, it just doesn't remember. Mode 0600: the file lists this repo's page paths.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const STATE_MODE = 0o600;

function readStateFile(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    return readFileSync(fd, "utf-8");
  } catch {
    return null; // absent, unreadable, or a symlink → start fresh
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readState(p: string): TurnState {
  try {
    const text = readStateFile(p);
    if (text !== null) {
      const raw = JSON.parse(text);
      // legacy format: a bare array of seen paths (pre-P1 state files)
      if (Array.isArray(raw)) return { seen: new Set(raw), terms: {} };
      return {
        seen: new Set(Array.isArray(raw?.seen) ? raw.seen : []),
        terms: raw?.terms && typeof raw.terms === "object" ? raw.terms : {},
      };
    }
  } catch {
    /* disposable state — start fresh */
  }
  return { seen: new Set(), terms: {} };
}

function writeState(p: string, st: TurnState): void {
  let fd: number | null = null;
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, STATE_MODE);
    writeFileSync(fd, JSON.stringify({ seen: [...st.seen], terms: st.terms }), "utf-8");
  } catch {
    /* best-effort */
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Decay prior weights, fold in this turn's terms at weight 1, cap the store, and return the
// top carried terms that are NOT already in the current prompt. Pure function — unit-testable.
export function accumulate(
  prior: Record<string, number>,
  current: string[],
): { merged: Record<string, number>; carried: string[] } {
  const merged: Record<string, number> = {};
  for (const [t, w] of Object.entries(prior)) {
    const nw = w * ACCUM_DECAY;
    if (nw >= ACCUM_MIN_WEIGHT) merged[t] = nw;
  }
  const cur = new Set(current.map((t) => t.toLowerCase()));
  for (const t of current) merged[t.toLowerCase()] = 1;
  const kept = Object.entries(merged)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, ACCUM_MAX_STORE);
  const capped = Object.fromEntries(kept);
  const carried = kept
    .map(([t]) => t)
    .filter((t) => !cur.has(t))
    .slice(0, ACCUM_MAX_CARRY);
  return { merged: capped, carried };
}

// ---- main ----------------------------------------------------------------------

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

export function buildTurnContext(repo: string, prompt: string, sessionId = ""): string {
  try {
    const cfg = getConfig(repo);
    // L0 / meta pages are already injected whole at session start — never re-suggest them.
    const l0Basenames = new Set([cfg.files.overview, cfg.files.l0, cfg.files.log, "index.md"]);
    const terms = extractTerms(prompt ?? "");
    // Two-character Hangul/Han words cannot be represented by the trigram index, so they are kept
    // out of the MATCH query (a quoted 2-char phrase matches nothing). They are also most of what a
    // Korean technical prompt is made of — 토큰·만료·검사·배포 — so dropping them entirely made the
    // per-turn loop silent on exactly the prompts it exists to answer. Carried separately: the
    // substring pass below can see them, and scoring compares by substring anyway.
    const subFloor = extractTerms(prompt ?? "", 2).filter((t) => !terms.includes(t));
    if (!terms.length && !subFloor.length) return "";

    const w = new WikiIndex(repo);
    if (!existsSync(w.dbPath)) return ""; // no index yet — stay silent, never create state
    const head = HEADS[isRepoKorean(w.root) ? "ko" : "en"]; // the same answer the writers use

    // HQE-lite (P1): fold prior-turn terms into this turn's query. Persist the merged
    // weights immediately so even a silent turn feeds the next one.
    const sp = sessionId ? _turnStatePath(w.root, sessionId) : "";
    const state = sp ? readState(sp) : { seen: new Set<string>(), terms: {} as Record<string, number> };
    let carried: string[] = [];
    if (sp && accumEnabled()) {
      const acc = accumulate(state.terms, terms);
      state.terms = acc.merged;
      carried = acc.carried;
      writeState(sp, state);
    }
    const queryTerms = [...terms, ...carried];

    const db = w.connect();
    let rows: any[];
    try {
      rows = queryTerms.length ? w.search(db, ftsQuery(queryTerms), 40, "wiki", true) : []; // raw: pre-quoted OR query
      // Below-the-floor recall, the same answer search() gives its own callers. It runs only after
      // MATCH came back empty, so the scan it costs lands only on turns that were getting nothing.
      if (!rows.length && subFloor.length) {
        rows = w.searchBelowFloor(db, [...queryTerms, ...subFloor], 40, "wiki");
      }
    } finally {
      db.close();
    }
    if (!rows.length) return "";

    // aggregate chunk hits per page; score = distinct terms present in matched chunks.
    // Carried terms add score but can't qualify a page alone — a page must match ≥1 term
    // from the CURRENT prompt (precision gate: a topic switch is never polluted by history).
    // Sub-floor terms count as CURRENT-prompt terms: they came from this prompt, and the precision
    // gate below ("a page must match ≥1 term from the current prompt") would otherwise reject every
    // page a substring pass found, leaving the recall it just bought unused.
    const scoreTerms = [...queryTerms, ...subFloor];
    const curSet = new Set([...terms, ...subFloor].map((t) => t.toLowerCase()));
    const byPage = new Map<string, { title: string; terms: Set<string>; cur: number; hits: number }>();
    for (const r of rows) {
      const rel = String(r.relative_path ?? "");
      const base = rel.split("/").pop() ?? "";
       if (
         rel === COLD_INDEX_RELATIVE_PATH ||
         !rel.includes("docs/wiki/") ||
         l0Basenames.has(base) ||
         rel.includes(`/${cfg.queueDir}/`)
       ) continue;
      const e =
        byPage.get(rel) ?? { title: String(r.title ?? base), terms: new Set<string>(), cur: 0, hits: 0 };
      e.hits += 1;
      const content = String(r.content ?? "").toLowerCase();
      for (const t of scoreTerms) {
        const lt = t.toLowerCase();
        if (!content.includes(lt)) continue;
        if (!e.terms.has(lt) && curSet.has(lt)) e.cur += 1;
        e.terms.add(lt);
      }
      byPage.set(rel, e);
    }

    const score = (e: { terms: Set<string> }) =>
      [...e.terms].reduce((s, t) => s + termWeight(t), 0);
    // One gate for both paths. A stricter bar for sub-floor-only evidence was tried and measured on
    // this wiki (91 chunks): it cost a relevant prompt and removed no noise, because the one filler
    // prompt that qualifies clears either bar. Corpus frequency was tried as a filter too and is
    // backwards here — in a focused wiki the content words are the COMMON ones (캡처 37%, 훅 27%)
    // and the filler is rare (해야 5%, 이거 2%), so "common = uninformative" would drop exactly the
    // words worth matching. Measured trade: relevant Korean prompts 1/7 → 5/7, filler 0/5 → 1/5.
    let pages = [...byPage.entries()]
      .filter(([, e]) => e.cur >= 1 && score(e) >= 2) // current witness + (two weak / one specific)
      .sort((a, b) => score(b[1]) - score(a[1]) || b[1].hits - a[1].hits);
    if (!pages.length) return "";

    // session dedup BEFORE the top-N cut — if the best pages were already suggested this
    // session, the next-best FRESH page gets the slot (a follow-up turn used to go silent
    // because the whole top-3 was seen while candidate #4 never got a chance).
    if (sp) pages = pages.filter(([rel]) => !state.seen.has(rel));
    pages = pages.slice(0, MAX_PAGES);
    if (!pages.length) return "";
    if (sp) {
      for (const [rel] of pages) state.seen.add(rel);
      writeState(sp, state);
    }

    const L = [head];
    for (const [rel, e] of pages) L.push(`  • ${e.title}  →  ${rel}`);
    return L.join("\n");
  } catch {
    return ""; // fail-safe: a turn-context failure must never surface into the session
  }
}
