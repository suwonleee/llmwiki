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
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { WikiIndex } from "./db.ts";
import { UNSPACED_ONLY_RE, UNSPACED_RUN_RE, unspacedWindows } from "./segment.ts";
import { isRepoKorean, effectiveKo, getConfig } from "./config.ts";
import { COLD_INDEX_RELATIVE_PATH } from "./cold-index.ts";

const MAX_TERMS = 12;
const MAX_PAGES = 3;
// Terms shown as a pointer's reason. Three is the point where the reason still reads as a reason
// rather than a term dump — and the per-pointer cost stays inside the noise of a 612B emission.
const WHY_MAX_TERMS = 3;
// Header language + L0/meta page names resolve per repo at call time (per-repo config).
// The banner names the clone it is speaking for, because the pointer lines under it are
// REPO-RELATIVE and a session does not always stay in the repository it started in: in hook mode
// the harness's cwd wins (cli.ts), so a session that moves into another enrolled repo is served
// THAT repo's wiki — and two clones can share a basename, so the path is what disambiguates.
// Cold start already prints its repo; this is the same courtesy on the per-turn path. Home
// collapses to `~`, keeping the addition to a few bytes a turn.
const HEADS = {
  en: (repo: string) =>
    `----- [llmwiki turn-context] ${repo} — wiki pages related to this prompt (pointers — Read on demand) -----`,
  ko: (repo: string) =>
    `----- [llmwiki turn-context] ${repo} — 이 프롬프트와 관련된 위키 페이지 (포인터 — 필요 시 Read) -----`,
};

// `/Users/me/repo` → `~/repo`. Cosmetic only: the banner is read by a person, and an absolute
// home path is both longer and less recognisable than the tilde form they type themselves.
export function displayRoot(root: string): string {
  const home = (homedir() || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const r = String(root ?? "").replace(/\\/g, "/");
  if (!home) return r;
  if (r === home) return "~";
  return r.startsWith(`${home}/`) ? `~${r.slice(home.length)}` : r;
}

// ---- term extraction (deterministic, language-neutral) ------------------------

// ASCII identifier-ish tokens: words, dotted/slashed paths, snake/kebab identifiers.
// ≥4 chars keeps "the/and/for"-class noise out without a stopword list. Runs FIRST so
// `src/engine/db.ts` stays one term instead of being cut at every separator.
const ASCII_RE = /[A-Za-z_][A-Za-z0-9_./-]{3,}/g;

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

export function extractTerms(prompt: string, denseFloor = 3): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (raw: string): void => {
    const t = raw.replace(/[./-]+$/, ""); // trim trailing punctuation-ish tail
    // 3 is the FTS5 trigram matching floor; Latin gets 4, because that is what keeps the
    // "the/and/for" class out without a stopword list. A dense script needs no such margin —
    // three characters of Hangul or Han are already a content word.
    if ([...t].length >= (/^[\x00-\x7F]+$/.test(t) ? 4 : denseFloor)) {
      const key = t.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(t);
      }
    }
    const stripped = stripJosa(t);
    if (stripped && [...stripped].length >= denseFloor) {
      const key = stripped.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(stripped);
      }
    }
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
    const koRepo = isRepoKorean(w.root);
    const head = HEADS[koRepo ? "ko" : "en"](displayRoot(w.root)); // the same answer the writers use

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
      // Identity candidates ride along LAST, after both body passes have said their piece — this
      // block must never preempt the below-floor gate above (it keys on "body found nothing", and
      // an identity row is not a body hit). They exist because a hub page whose BODY never repeats
      // its own title (or spells it with different spacing) is invisible to both passes above, so
      // it could never be scored at all. Appended, not prepended — the scorer owns the order, and
      // the witness/score gate still decides whether anything is said.
      if (queryTerms.length || subFloor.length) {
        rows = [...rows, ...w.identityCandidates(db, [...new Set([...queryTerms, ...subFloor])])];
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
    const byPage = new Map<
      string,
      { title: string; terms: Set<string>; idTerms: Set<string>; shownIdTerms: Set<string>; cur: number; hits: number }
    >();
    for (const r of rows) {
      const rel = String(r.relative_path ?? "");
      const base = rel.split("/").pop() ?? "";
       if (
         rel === COLD_INDEX_RELATIVE_PATH ||
         !rel.includes("docs/wiki/") ||
         l0Basenames.has(base) ||
         rel.includes(`/${cfg.queueDir}/`)
       ) continue;
      const fresh = !byPage.has(rel);
      const e =
        byPage.get(rel) ??
        {
          title: String(r.title ?? base),
          terms: new Set<string>(),
          idTerms: new Set<string>(),
          shownIdTerms: new Set<string>(),
          cur: 0,
          hits: 0,
        };
      // A term in the page's IDENTITY (title/filename/description) is a stronger witness than one
      // in a body chunk — it is the hub-vs-mention distinction. Query helpers label provenance
      // explicitly: identity rows can contribute identity terms, but never inflate the body-hit
      // tie-breaker. The identity haystack carries a whitespace-stripped copy, so "문서허브" can
      // match "문서 허브". Chunks are not despaced — this is a title privilege, not fuzzy body
      // matching.
      const identityCandidate = r.candidate_kind === "identity";
      if (!identityCandidate) e.hits += 1;
      const content = identityCandidate ? "" : String(r.content ?? "").toLowerCase();
      let identity = "";
      if (fresh) {
        const idBase = `${e.title} ${base}`.toLowerCase();
        identity = `${idBase} ${idBase.replace(/[\s-]+/g, "")}`;
      }
      if (identityCandidate) {
        const description = String(r.content ?? "").toLowerCase();
        identity += ` ${description} ${description.replace(/[\s-]+/g, "")}`;
      }
      for (const t of scoreTerms) {
        const lt = t.toLowerCase();
        const inIdentity = identity.includes(lt);
        if (!content.includes(lt) && !inIdentity) continue;
        if (!e.terms.has(lt) && curSet.has(lt)) e.cur += 1;
        e.terms.add(lt);
        // Identity promotion is reserved for terms at or above the trigram floor (3 dense / 4
        // Latin). A 2-char word in a title is everyday vocabulary, not a topic — promoting it let
        // "내일 회의 몇 시더라" clear the gate off one title's "회의" (measured filler FP).
        if (inIdentity && [...t].length >= (/^[\x00-\x7F]+$/.test(t) ? 4 : 3)) e.idTerms.add(lt);
        // The length floor above protects the SCORE — a 2-char word in a title is everyday
        // vocabulary and promoting it was a measured false positive. It is the wrong floor for the
        // pointer's stated reason: 품질·루프·검수 are 2 chars each and are most of what a Korean
        // technical prompt is made of, so gating the explanation on it left the reason blank on
        // exactly those prompts. Saying "this word is in the title" is a fact about the title, not
        // a claim about relevance, so it carries no floor — and it never touches the gate.
        if (inIdentity) e.shownIdTerms.add(lt);
      }
      byPage.set(rel, e);
    }

    // An identity-matched term is specific regardless of its length: a compact identifier can be
    // weight 1 by the length rule, so a prompt about exactly one topic could never clear the ≥2 gate even
    // when a page's TITLE names that topic — the gate meant to stop filler was stopping hubs.
    // Identity carries the same authority here as in search's title boost, and only identity:
    // body mentions keep the length-based weight that was measured against filler.
    const score = (e: { terms: Set<string>; idTerms: Set<string> }) =>
      [...e.terms].reduce((s, t) => s + (e.idTerms.has(t) ? 2 : termWeight(t)), 0);
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

    // Why this page, in the engine's own evidence — but only the part that DISCRIMINATES.
    //
    // Showing every matched term was tried first and is useless here: the score gate already
    // requires each pointer to match the current prompt, so all three pointers print the same
    // list (measured on the largest wiki here (236 pages): "품질·루프·검수" on all three, including the two pages
    // that merely mention the words). A reason identical across the set is worse than none —
    // it asserts equal relevance the engine never established.
    //
    // What differs between pointers is IDENTITY: a prompt term in the page's title/description
    // is why that page is a hub for the question, not merely a page the word appears in. So only
    // identity terms are shown, and a body-only match prints nothing — the absence is itself the
    // signal. Current-prompt terms only; carried terms explain the session, not this question.
    const why = (e: { shownIdTerms: Set<string> }): string => {
      const shown: string[] = [];
      for (const lt of [...e.shownIdTerms].filter((t) => curSet.has(t)).sort((a, b) => b.length - a.length)) {
        // "L-GATE" and "GATE" are one reason wearing two spellings; keep the longer, drop the
        // substring, so three slots hold three reasons instead of three surface forms of one.
        if (shown.some((s) => s.toLowerCase().includes(lt))) continue;
        shown.push(scoreTerms.find((t) => t.toLowerCase() === lt) ?? lt);
        if (shown.length >= WHY_MAX_TERMS) break;
      }
      return shown.length ? `  (${koRepo ? "제목" : "titled"}: ${shown.join("·")})` : "";
    };
    const L = [head];
    for (const [rel, e] of pages) L.push(`  • ${e.title}  →  ${rel}${why(e)}`);
    return L.join("\n");
  } catch {
    return ""; // fail-safe: a turn-context failure must never surface into the session
  }
}
