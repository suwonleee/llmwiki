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
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inspectEnrollment } from "./enrollment.ts";
import { WikiIndex } from "./db.ts";
import { extractTerms, stripJosa, termWeight } from "./query-terms.ts";
import { loadWikiPages, rankPages } from "./page-rank.ts";

export { extractTerms, stripJosa, termWeight };
import { isRepoKorean, effectiveKo, getConfig } from "./config.ts";
import { COLD_INDEX_RELATIVE_PATH } from "./cold-index.ts";
import { adjustedScore, loadAffinity, type AffinityFile } from "./affinity.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { readRepoFile } from "./repo-write.ts";

const MAX_PAGES = 3;
// Terms shown as a pointer's reason. Three is the point where the reason still reads as a reason
// rather than a term dump — and the per-pointer cost stays inside the noise of a 612B emission.
const WHY_MAX_TERMS = 3;
// A deprecated page loses ties and one-point leads to a current one; a clearly better match
// (≥ 2 points) still ranks first — retired knowledge can be the answer, it is just not the default.
const DEPRECATED_FACTOR = 0.5;
const RELEVANCE_FLOOR = 1.5;
const RELEVANCE_FLOOR_MIN_PAGES = 20;
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

// ---- currency (OKF consumer duty) ---------------------------------------------

export type PageCurrency = { readonly deprecated: boolean; readonly stale: boolean };

/**
 * Is this page still current? An OKF consumer must not present `deprecated` (llmwiki's
 * `superseded`) knowledge, or knowledge past its `stale_after`, as current. Read from the file —
 * the index stores no `stale_after`, and a pointer costs one small read per shown page.
 */
export function pageCurrency(root: string, rel: string): PageCurrency {
  try {
    const text = readRepoFile(root, rel);
    if (text === null) return { deprecated: false, stale: false };
    const fm = parseFrontmatter(text);
    return { deprecated: fm.status === "superseded", stale: fm.stale };
  } catch {
    return { deprecated: false, stale: false };
  }
}

/** ` (deprecated)` / ` (stale)` — the suffix a pointer carries so it is never read as current. */
export function currencyMark(c: PageCurrency): string {
  return c.deprecated ? " (deprecated)" : c.stale ? " (stale)" : "";
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

/**
 * The same wiki root inside the enrolled MAIN worktree, when `repo` sits in a linked worktree that
 * is itself enrolled (own marker or inherited). null for everything else.
 */
function mainCheckoutOf(repo: string): string | null {
  let real: string;
  try {
    real = realpathSync(repo);
  } catch {
    return null;
  }
  const st = inspectEnrollment(real);
  if (!st.enabled || !st.mainWorktree || !st.worktree) return null;
  const rel = relative(st.worktree, real);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return join(st.mainWorktree, rel);
}

function hasWikiRows(w: WikiIndex): boolean {
  const db = w.connect();
  try {
    return db.query("SELECT 1 FROM documents WHERE relative_path LIKE 'docs/wiki/%' LIMIT 1").get() !== null;
  } finally {
    db.close();
  }
}

// `opts.affinity` pins the page-affinity input (null = none) instead of the live aggregate — the
// seam deterministic callers (bench) use.
export function buildTurnContext(
  repo: string,
  prompt: string,
  sessionId = "",
  opts: { affinity?: AffinityFile | null } = {},
): string {
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

    let w = new WikiIndex(repo);
    // A linked worktree with no index of its own borrows its main worktree's WIKI index instead of
    // staying silent (building a full index is a close-out cost, never a per-turn one). The branch
    // may lack pages the main tree has, so a borrowed hit counts only when the page exists in THIS
    // checkout, and every path shown is relative to this checkout — which is where it gets read.
    // "No index" includes an index with no wiki rows: the cold start's synthesis readers open
    // (and so create) an empty one in a fresh worktree before any turn runs.
    let here: string | null = null;
    const main = mainCheckoutOf(repo);
    if (main !== null && (!existsSync(w.dbPath) || !hasWikiRows(w))) {
      const borrowed = new WikiIndex(main);
      if (existsSync(borrowed.dbPath)) {
        w = borrowed;
        here = resolve(repo);
      }
    }
    if (!existsSync(w.dbPath)) return ""; // no index yet — stay silent, never create state
    const root = here ?? w.root;
    const koRepo = isRepoKorean(root);
    const head = HEADS[koRepo ? "ko" : "en"](displayRoot(root)); // the same answer the writers use

    // HQE-lite (P1): fold prior-turn terms into this turn's query. Persist the merged
    // weights immediately so even a silent turn feeds the next one.
    const sp = sessionId ? _turnStatePath(root, sessionId) : "";
    const state = sp ? readState(sp) : { seen: new Set<string>(), terms: {} as Record<string, number> };
    let carried: string[] = [];
    if (sp && accumEnabled()) {
      const acc = accumulate(state.terms, terms);
      state.terms = acc.merged;
      carried = acc.carried;
      writeState(sp, state);
    }
    const queryTerms = [...terms, ...carried];

    // Rank the checkout's own pages (page-rank.ts): every page is scored by substring term matches
    // weighted by rarity across the wiki, so 2-char words and particle-glued forms count, and a
    // page shown is always one that exists in THIS checkout (a borrowed index only decided above
    // whether a wiki is set up at all). Carried terms add relevance; they cannot qualify a page.
    const scoreTerms = [...queryTerms, ...subFloor];
    const curSet = new Set([...terms, ...subFloor].map((t) => t.toLowerCase()));
    const wikiPages = loadWikiPages(root, cfg, l0Basenames);
    const ranked0 = rankPages(wikiPages, scoreTerms);
    // Relevance floor, scaled to the wiki's size (idf grows with ln N). The coverage gate alone let
    // everyday words that run through a focused wiki (테스트 · 커밋 · 로그) qualify a page; measured
    // on 4 project wikis: filler prompts fired 19/80 before, 8/80 with this floor, while 119/120
    // real questions still got pointers. Below 20 pages there is too little to estimate rarity.
    const floor = wikiPages.length >= RELEVANCE_FLOOR_MIN_PAGES ? RELEVANCE_FLOOR * Math.log(1 + wikiPages.length) : 0;
    const byPage = new Map(
      ranked0.map((r) => [
        `docs/wiki/${r.page.rel}`,
        {
          title: r.page.title,
          terms: new Set(r.terms),
          idTerms: new Set(r.idTerms),
          shownIdTerms: new Set(r.shownIdTerms),
          cur: [...r.terms].filter((t) => curSet.has(t)).length,
          relevance: r.relevance,
          coverage: r.coverage,
        },
      ]),
    );
    if (!byPage.size) return "";

    // One gate, unchanged in meaning: a page must match a CURRENT-prompt term, and carry two weak
    // or one specific witness (identity terms are specific). Measured trade when it was set:
    // relevant Korean prompts 1/7 → 5/7, filler 0/5 → 1/5. Relevance only ORDERS what passed.
    // Page affinity (affinity.ts) is a bounded correction applied AFTER the gate: it can reorder
    // near-ties among pages that already earned a place on relevance, never admit one that did not.
    let pages = [...byPage.entries()].filter(([, e]) => e.cur >= 1 && e.coverage >= 2 && e.relevance >= floor);
    const affinity = pages.length < 2 ? null : opts.affinity !== undefined ? opts.affinity : loadAffinity(repo);
    const currency = new Map(pages.map(([rel]) => [rel, pageCurrency(root, rel)]));
    const top = pages.reduce((m, [, e]) => Math.max(m, e.relevance), 0) || 1;
    // Relevance is rescaled so the best page scores 10: affinity's bounded shift and the
    // deprecated penalty keep the magnitude they were tuned on (a gap of ~2 points never flips).
    // A retired page keeps half its relevance: it still surfaces when nothing current answers,
    // but a current peer of comparable relevance always leads it (OKF §5.4 `deprecated`).
    const ranked = (rel: string, e: { relevance: number }) =>
      adjustedScore((10 * e.relevance * (currency.get(rel)?.deprecated ? DEPRECATED_FACTOR : 1)) / top, affinity, rel);
    pages.sort((a, b) => ranked(b[0], b[1]) - ranked(a[0], a[1]) || (a[0] < b[0] ? -1 : 1));
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
    for (const [rel, e] of pages) {
      const mark = currencyMark(currency.get(rel) ?? { deprecated: false, stale: false });
      L.push(`  • ${e.title}${mark}  →  ${rel}${why(e)}`);
    }
    return L.join("\n");
  } catch {
    return ""; // fail-safe: a turn-context failure must never surface into the session
  }
}
