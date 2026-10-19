// Harness-neutral per-turn context builder — the fine-grained sibling of
// the cold-start read loop (context.ts).
//
// Given the user's just-submitted prompt, deterministically surface AT MOST a few wiki-page
// POINTERS (title → path) whose content lexically matches the prompt, each followed by a short
// EXCERPT of the page. Any harness that can run a command on prompt submission injects the stdout:
//   Claude Code / Codex → UserPromptSubmit hook (stdin JSON carries {prompt, session_id, cwd})
//   OpenCode            → plugin (experimental.chat.system.transform) shelling out to the CLI
//
// Precision-first policy (the anti-debt line):
//   • a pointer plus a bounded excerpt — the page's `x-llmwiki` rule line, else its best-matching
//     section — never a whole body. Measured 2026-10-14 (32 real coding runs): agents never
//     followed a pointer (no wiki Read, no `llmwiki search`); only text IN the context changed
//     behaviour. LLMWIKI_TURN_EXCERPT=off restores the pointer-only form (A/B).
//   • at most MAX_PAGES pages and TURN_MAX_CHARS in all; SILENT (empty output) when confidence is low
//   • retired knowledge (deprecated / superseded / has a successor) is never emitted
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
import { observeSaveNudge } from "./save-nudge.ts";
import { inspectEnrollment } from "./enrollment.ts";
import { sourceChangedPages } from "./source-freshness.ts";
import { WikiIndex } from "./db.ts";
import { extractTerms, stripJosa, subFloorTerms, termWeight } from "./query-terms.ts";
import { commitLines, commitsEnabled, readLog, relevantCommits, type CommitHit } from "./commit-context.ts";
import { absenceLine, absentNames, isQuestion, writtenNames } from "./absent-subject.ts";
import { loadWikiPages, rankPages, type WikiPage } from "./page-rank.ts";
import { reportedWrongPages } from "./reported-wrong.ts";

export { extractTerms, stripJosa, termWeight };
import { isRepoKorean, effectiveKo, getConfig } from "./config.ts";
import { COLD_INDEX_RELATIVE_PATH } from "./cold-index.ts";
import { adjustedScore, loadAffinity, type AffinityFile } from "./affinity.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { isRetired, splitFrontmatter } from "./okf.ts";
import { readRepoFile } from "./repo-write.ts";

const MAX_PAGES = 3;
// Terms shown as a pointer's reason. Three is the point where the reason still reads as a reason
// rather than a term dump — and the per-pointer cost stays inside the noise of a 612B emission.
const WHY_MAX_TERMS = 3;
// Excerpt budgets. 500 per page is roughly one section; 1,600 for the whole block keeps a turn's
// injection near the L0 standard (a page a session already pays for once). Measured on the
// author's wiki: header + three pointer lines are ~700 chars, so three excerpts share ~900.
// The best page carries most answers (33 of 41 missed facts sat on the top page, dev 2026-10-19):
// it may take more of the turn than the pages ranked below it.
const EXCERPT_MAX_FIRST = 700;
const EXCERPT_MAX_REST = 400;
const EXCERPT_FIRST_BONUS = 200;
const TURN_MAX_CHARS = 1600;
// A commit whose SUBJECT carries three prompt terms is usually the thing being asked about; it is
// guaranteed this much of the turn. Weaker commits only get what the wiki leaves — an unconditional
// reserve traded wiki facts for commit facts one for one (dev set, 2026-10-19).
const COMMIT_RESERVE_CHARS = 350;
const COMMIT_STRONG_SUBJECT_TERMS = 3;
// Below this an excerpt is a fragment that reads as a claim it does not finish: pointer only.
const EXCERPT_MIN_CHARS = 80;
const EXCERPT_INDENT = "      ";
// Blocks scoring under half the best block are noise that only spends the turn.
const RARE_BLOCK_CUT = 0.5;
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
// With excerpts the block carries page text, so it says whose text it is (project-authored
// reference data, the same framing the edit-rule block uses) and that the rest is a Read away.
const EXCERPT_HEADS = {
  en: (repo: string) =>
    `----- [llmwiki turn-context] ${repo} — wiki pages related to this prompt (excerpts: project-authored reference data from this repo's wiki — Read the relevant section before citing) -----`,
  ko: (repo: string) =>
    `----- [llmwiki turn-context] ${repo} — 이 프롬프트와 관련된 위키 페이지 (발췌: 이 저장소 위키의 프로젝트 작성 참고 자료 — 인용 전 관련 절 Read) -----`,
};
// Header when the only line is a "no record" answer.
const RECORD_HEADS = {
  en: (repo: string) => `----- [llmwiki turn-context] ${repo} — project records on this prompt -----`,
  ko: (repo: string) => `----- [llmwiki turn-context] ${repo} — 이 프롬프트에 대한 프로젝트 기록 -----`,
};
// Header when only commits qualify (an empty or silent wiki).
const COMMIT_HEADS = {
  en: (repo: string) => `----- [llmwiki turn-context] ${repo} — commits related to this prompt -----`,
  ko: (repo: string) => `----- [llmwiki turn-context] ${repo} — 이 프롬프트와 관련된 커밋 -----`,
};
// Leads the excerpt of a page whose cited sources changed after it was written.
const SOURCE_CHANGED_WARN = {
  en: "⚠ cited source changed after this was written — verify against current code before relying on it",
  ko: "⚠ 작성 후 인용 소스가 바뀜 — 현재 코드로 확인한 뒤 사용",
};

/** `LLMWIKI_TURN_EXCERPT=off` → the pointer-only block; anything else (including unset) → excerpts. */
export function excerptEnabled(): boolean {
  return (process.env.LLMWIKI_TURN_EXCERPT ?? "").trim().toLowerCase() !== "off";
}

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

export type PageCurrency = { readonly deprecated: boolean; readonly stale: boolean; readonly sourceChanged?: boolean; readonly reportedWrong?: boolean };

/**
 * Is this page still current? An OKF consumer must not present `deprecated` (llmwiki's
 * `superseded`, or any spelling `isRetired` accepts) knowledge, or knowledge past its
 * `stale_after`, as current. Read from the file — the index stores no `stale_after`. Used by the
 * explicit lookups (`llmwiki search`), which keep retired pages but mark them.
 */
export function pageCurrency(root: string, rel: string): PageCurrency {
  try {
    const text = readRepoFile(root, rel);
    if (text === null) return { deprecated: false, stale: false };
    const fm = parseFrontmatter(text);
    return { deprecated: isRetired(fm.data), stale: fm.stale,
      ...(sourceChangedPages(root).has(rel) ? { sourceChanged: true } : {}),
      ...(reportedWrongPages(root).has(rel) ? { reportedWrong: true } : {}) };
  } catch {
    return { deprecated: false, stale: false };
  }
}

/** ` (deprecated)` / ` (stale)` — the suffix a pointer carries so it is never read as current. */
export function currencyMark(c: PageCurrency): string {
  return (c.deprecated ? " (deprecated)" : c.stale ? " (stale)" : "") +
    (c.sourceChanged ? " (source changed; recheck required)" : "") +
    (c.reportedWrong ? " (reported wrong; recheck required)" : "");
}

// ---- excerpt -----------------------------------------------------------------------------

const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
const FOOTNOTE_REF = /\[\^[^\]]+\]/g;
const EVIDENCE = /^[ \t]{2,}>[ \t]/;
const MD_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const SECTION_HEAD = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const SUMMARY_HEAD = /tl;?dr|요약|summary|概要|摘要/i;
// A cross-link line (`- [Page](../x.md) — grounds`, the topic-page Related form): navigation, not
// knowledge — and it repeats the linked pages' title words, so it would out-score real content.
const RELATION_LINE = /[—-]\s*(grounds|extends|contradicts|exemplifies|enables)\s*$/;

type ExcerptBlock = { readonly lines: string[]; atomic: boolean };
type Section = { readonly heading: string; readonly lines: string[]; readonly blocks: ExcerptBlock[] };

// OKF permits H1 sections (Schema, Examples, Computation) as well as nested H2–H6.
// A page body as sections a reader can quote: headings start a section; footnote
// markers and definitions and their evidence lines go (provenance, not content), links keep
// their text, bold markers go (budget). `→` becomes `->`: it is the pointer-line delimiter three
// parsers key on (bench, observe, downstream-read), and an excerpt line must never read as one.
function sections(body: string): Section[] {
  const out: Section[] = [{ heading: "", lines: [], blocks: [] }];
  let block: ExcerptBlock | null = null;
  let blank = false;
  let fence: { marker: string; size: number } | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (delimiter) {
      const marker = delimiter[1]![0]!;
      const size = delimiter[1]!.length;
      if (!fence && !(marker === "`" && delimiter[2]!.includes("`"))) {
        block = null;
        fence = { marker, size };
        continue;
      }
      if (fence && marker === fence.marker && size >= fence.size && !delimiter[2]!.trim()) {
        fence = null;
        block = null;
        continue;
      }
    }
    if (!fence) {
      const h = SECTION_HEAD.exec(raw);
      if (h) {
        out.push({ heading: clean(h[1]!), lines: [], blocks: [] });
        block = null;
        continue;
      }
      if (FOOTNOTE_DEF.test(raw) || EVIDENCE.test(raw) || /^[ \t]*<!--.*-->[ \t]*$/.test(raw)) continue;
    }
    const line = clean(raw).trimEnd();
    if (!line.trim()) {
      // Blank lines inside list items/code do not detach an exception or code tail.
      if (!fence && !block?.atomic) block = null;
      blank = true;
      continue;
    }
    if (RELATION_LINE.test(line)) continue;
    const listItem = /^( {0,3})(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
    // Nested list items and wrapped continuation lines belong to their parent item.
    // A fresh unindented paragraph after a blank line is a new block, even after a list.
    if (!fence && blank && !/^[ \t]/.test(line)) block = null;
    const parentIndent = block?.lines[0]?.match(/^[ \t]*/)?.[0].length ?? 0;
    if (!fence && listItem && listItem[1]!.length <= parentIndent) block = null;
    blank = false;
    const atomic = !!fence || !!listItem || /^[ \t]/.test(line);
    const sec = out[out.length - 1]!;
    if (!block) {
      block = { lines: [], atomic };
      sec.blocks.push(block);
    }
    block.atomic ||= atomic;
    block.lines.push(line);
    sec.lines.push(line);
  }
  return out.filter((s) => s.heading || s.lines.length);
}

function clean(s: string): string {
  return s.replace(FOOTNOTE_REF, "").replace(MD_LINK, "$1").replaceAll("**", "").replaceAll("→", "->");
}

/** Whole lines or sentence prefixes that fit. Never split an identifier, unit or condition. */
function fit(lines: readonly string[], max: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = EXCERPT_INDENT.length + line.length + 1;
    if (used + cost <= max) {
      out.push(line);
      used += cost;
      continue;
    }
    const room = max - used - EXCERPT_INDENT.length - 1;
    // Sentence segmentation understands abbreviations and decimal points better than a punctuation
    // regex. Keep only completed sentences; an unfinished final sentence is not a usable claim.
    let prefix = "";
    for (const part of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(line)) {
      const candidate = (prefix + part.segment).trimEnd();
      if (candidate.length > room) break;
      if (!/[.!?。！？]["'”’)]*$/.test(candidate)) break;
      prefix += part.segment;
    }
    if (prefix.trim()) out.push(prefix.trimEnd());
    break;
  }
  return out.length === 1 && out[0]!.startsWith("§ ") ? [] : out;
}

/**
 * What to show under a pointer: the page's `x-llmwiki` rule verbatim when it declares one (the
 * author's own one-line statement of what to do); else the H1–H6 section sharing the most prompt
 * terms (ties → earlier); with no overlap, the TL;DR/summary section, then the description.
 * A term in `named` (it names the page — the pointer line already shows that match) counts half:
 * the section worth quoting is the one that answers the REST of the prompt.
 * Returns unindented lines totalling at most `max` characters once indented. Pure.
 */
export function pageExcerpt(
  body: string,
  opts: { rule?: string; description?: string; terms: readonly string[]; named?: readonly string[]; max: number; ko?: boolean; weights?: ReadonlyMap<string, number> },
): string[] {
  if (opts.max < EXCERPT_MIN_CHARS) return [];
  if (opts.rule) {
    const rule = `${opts.ko ? "규칙" : "rule"}: ${opts.rule.replaceAll("→", "->")}`;
    // A rule is atomic: dropping a later exception can reverse its meaning.
    return EXCERPT_INDENT.length + rule.length + 1 <= opts.max ? [rule] : [];
  }
  const terms = [...new Set(opts.terms.map((t) => t.toLowerCase()))].filter(Boolean);
  const named = new Set((opts.named ?? []).map((t) => t.toLowerCase()));
  const secs = sections(body);
  if (opts.weights) {
    const picked = rarestBlocks(secs, terms, named, opts.weights, opts.max);
    if (picked.length) return picked;
  }
  let best: Section | null = null;
  let bestHits = 0;
  for (const sec of secs) {
    const text = `${sec.heading}\n${sec.lines.join("\n")}`.toLowerCase();
    const hits = terms.filter((t) => text.includes(t)).reduce((n, t) => n + (named.has(t) ? 1 : 2), 0);
    if (hits > bestHits && sec.lines.length) {
      best = sec;
      bestHits = hits;
    }
  }
  if (!best) best = secs.find((s) => SUMMARY_HEAD.test(s.heading) && s.lines.length) ?? null;
  if (!best) {
    const d = clean(opts.description ?? "").trim();
    if (d) return fit([d], opts.max);
    best = secs.find((s) => s.lines.length) ?? null;
  }
  if (!best) return [];
  const heading = best.heading ? [`§ ${best.heading}`] : [];
  const normalize = (lines: readonly string[]) => lines.map((l) => l.replace(/\t/g, "  "));
  const cost = (lines: readonly string[]) => lines.reduce((n, line) => n + EXCERPT_INDENT.length + line.length + 1, 0);
  const full = [...heading, ...normalize(best.lines)];
  if (cost(full) <= opts.max) return full;

  // Rank complete blocks inside the winning section: fitting its prefix can otherwise omit
  // the very passage that earned the page a place. Heading matches cannot discriminate blocks.
  // Ties keep document order. A list item (including nested exceptions), wrapped paragraph,
  // or fenced sample is indivisible; do not turn its first line into an unconditional claim.
  let start = 0;
  let blockHits = 0;
  best.blocks.forEach((block, i) => {
    const text = block.lines.join("\n").toLowerCase();
    const hits = terms.filter((t) => text.includes(t)).reduce((n, t) => n + (named.has(t) ? 1 : 2), 0);
    if (hits > blockHits) { start = i; blockHits = hits; }
  });
  const result = [...heading];
  for (const block of best.blocks.slice(start)) {
    const lines = normalize(block.lines);
    if (cost([...result, ...lines]) <= opts.max) {
      result.push(...lines);
      continue;
    }
    // Preserve the legacy section-prefix fallback only when starting at the first block.
    // Newly selected later passages must fit whole: even a single prose line can place a
    // qualification after its first sentence. Structural/multi-line blocks are always atomic.
    if (start === 0 && !block.atomic && lines.length === 1) result.push(...fit(lines, opts.max - cost(result)));
    break;
  }
  return result.length === heading.length ? [] : result;
}

/**
 * The page's best blocks by the RARITY of the prompt terms they hold, from any section, in
 * document order under their headings. One section was the old unit: a question asking for a cause
 * and its fix found the cause section and lost the fix, and everyday words (결과 · 실행) outvoted the
 * one rare name the question was about. Blocks stay indivisible; a block that does not fit is skipped
 * whole, never cut.
 */
function rarestBlocks(
  secs: readonly Section[], terms: readonly string[], named: ReadonlySet<string>, weights: ReadonlyMap<string, number>, max: number,
): string[] {
  const w = (t: string) => (weights.get(t) ?? 1) * (named.has(t) ? 0.5 : 1);
  const score = (text: string) => terms.filter((t) => text.includes(t)).reduce((n, t) => n + w(t), 0);
  const cands: { si: number; bi: number; s: number }[] = [];
  secs.forEach((sec, si) => {
    const head = score(sec.heading.toLowerCase()) / 2; // a matching heading lends its blocks half its weight
    sec.blocks.forEach((b, bi) => {
      const s = score(b.lines.join("\n").toLowerCase());
      if (s > 0) cands.push({ si, bi, s: s + head });
    });
  });
  if (!cands.length) return [];
  cands.sort((a, b) => b.s - a.s || a.si - b.si || a.bi - b.bi);
  const lineCost = (l: string) => EXCERPT_INDENT.length + l.length + 1;
  const blockLines = (si: number, bi: number) => secs[si]!.blocks[bi]!.lines.map((l) => l.replace(/\t/g, "  "));
  const chosen = new Map<number, Set<number>>();
  let used = 0;
  const cut = cands[0]!.s * RARE_BLOCK_CUT;
  for (const { si, bi, s } of cands) {
    if (s < cut) break;
    const heading = secs[si]!.heading && !chosen.has(si) ? lineCost(`§ ${secs[si]!.heading}`) : 0;
    const add = heading + blockLines(si, bi).reduce((n, l) => n + lineCost(l), 0);
    if (used + add > max) continue;
    used += add;
    if (!chosen.has(si)) chosen.set(si, new Set());
    chosen.get(si)!.add(bi);
  }
  const out: string[] = [];
  for (const si of [...chosen.keys()].sort((a, b) => a - b)) {
    if (secs[si]!.heading) out.push(`§ ${secs[si]!.heading}`);
    for (const bi of [...chosen.get(si)!].sort((a, b) => a - b)) out.push(...blockLines(si, bi));
  }
  return out;
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
  // Hook adapters retain their enrollment gate. No transcript reads or project-state writes.
  // Reserve the reminder before retrieval so it never pushes a turn over the shared cap.
  const hint = observeSaveNudge(repo, prompt ?? "", sessionId, { ko: isRepoKorean(repo) });
  const room = TURN_MAX_CHARS - (hint ? hint.length + 1 : 0);
  const records = recordsTurnContext(repo, prompt, sessionId, opts, room);
  // An exceptionally long absence-name list may exceed its channel's allowance. Omit that
  // block whole rather than clipping a factual sentence or an exception inside an excerpt.
  const bounded = records.length <= room ? records : "";
  return [bounded, hint].filter(Boolean).join("\n");
}

function recordsTurnContext(
  repo: string,
  prompt: string,
  sessionId = "",
  opts: { affinity?: AffinityFile | null } = {},
  maxChars = TURN_MAX_CHARS,
): string {
  const absent = absentEnabled(), commits = commitsEnabled();
  if (!absent && !commits) return wikiTurnContext(repo, prompt, sessionId, opts, {}, maxChars);
  const seen: { pages?: WikiPage[] } = {};
  let wiki = "";
  try {
    const terms = extractTerms(prompt ?? "");
    const ko = isRepoKorean(repo);
    let log: CommitHit[] | undefined;
    let hits: CommitHit[] = [];
    if (commits) {
      log = readLog(repo);
      hits = relevantCommits(repo, [...terms, ...subFloorTerms(prompt ?? "", terms)], undefined, log);
    }
    // A qualifying commit gets its share up front; left to what the wiki leaves, it got nothing
    // whenever three excerpts filled the turn.
    const strong = hits.length > 0 && (hits[0]!.subjectTerms ?? 0) >= COMMIT_STRONG_SUBJECT_TERMS;
    wiki = wikiTurnContext(repo, prompt, sessionId, opts, seen, strong ? maxChars - COMMIT_RESERVE_CHARS : maxChars);
    if (absent) {
      // A question about something this project never mentions gets that fact, not near-miss
      // pages; an instruction may name what it is about to create, so it keeps the pages.
      const pages = seen.pages ?? loadWikiPages(repo);
      const inWiki = (t: string) => pages.some((p) => p.identity.includes(t) || p.trigger.includes(t) || p.body.includes(t));
      const unknown = writtenNames(prompt ?? "").filter((t) => !inWiki(t.toLowerCase()));
      if (unknown.length) {
        log ??= readLog(repo);
        const names = absentNames(repo, unknown, inWiki, log.map((c) => `${c.subject}\n${c.body}`).join("\n"));
        if (names.length) {
          const line = absenceLine(names, ko);
          if (isQuestion(prompt ?? "")) return [RECORD_HEADS[ko ? "ko" : "en"](displayRoot(repo)), line].join("\n");
          wiki = wiki ? `${wiki}\n${line}` : [RECORD_HEADS[ko ? "ko" : "en"](displayRoot(repo)), line].join("\n");
        }
      }
    }
    if (!hits.length) return wiki;
    const head = wiki ? "" : COMMIT_HEADS[ko ? "ko" : "en"](displayRoot(repo));
    const used = wiki ? wiki.length + 1 : head.length + 1;
    const lines = commitLines(hits, terms, maxChars - used, ko);
    if (!lines.length) return wiki;
    return [wiki || head, ...lines].join("\n");
  } catch {
    return wiki || wikiTurnContext(repo, prompt, sessionId, opts, {}, maxChars); // fail-safe: extra channels never cost the wiki block
  }
}

/** Report a question's subject that the project never mentions; `LLMWIKI_TURN_ABSENT=off` disables.
 * Sealed test across 7 repositories (2026-10-19): misleading context on unanswerable questions
 * 21/44 → 8/44, no answerable question lost a page. */
export function absentEnabled(): boolean {
  return (process.env.LLMWIKI_TURN_ABSENT ?? "").trim().toLowerCase() !== "off";
}

function wikiTurnContext(
  repo: string,
  prompt: string,
  sessionId: string,
  opts: { affinity?: AffinityFile | null },
  seen: { pages?: WikiPage[] } = {},
  maxChars = TURN_MAX_CHARS,
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
    const subFloor = subFloorTerms(prompt ?? "", terms);
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
    seen.pages = wikiPages; // the extra channels reuse this read instead of walking the wiki again
    // Retired knowledge is never pushed (okf.ts isRetired). Withheld, not demoted: a `deprecated`
    // mark still let 27% of runs follow the stale page (okf-skills, measured). It still counts
    // toward rarity below — it is part of the wiki, just not an answer.
    const ranked0 = rankPages(wikiPages, scoreTerms).filter((r) => !r.page.retired);
    // Session history may reorder eligible pages, but it is not evidence that a page answers
    // this prompt. Evaluate both admission thresholds against current terms alone.
    const currentRanks = new Map(
      (carried.length ? rankPages(wikiPages, [...curSet]) : ranked0).map((r) => [r.page.rel, r]),
    );
    // Relevance floor, scaled to the wiki's size (idf grows with ln N). The coverage gate alone let
    // everyday words that run through a focused wiki (테스트 · 커밋 · 로그) qualify a page; measured
    // on 4 project wikis: filler prompts fired 19/80 before, 8/80 with this floor, while 119/120
    // real questions still got pointers. Below 20 pages there is too little to estimate rarity.
    const floor = wikiPages.length >= RELEVANCE_FLOOR_MIN_PAGES ? RELEVANCE_FLOOR * Math.log(1 + wikiPages.length) : 0;
    const byPage = new Map(
      ranked0.map((r) => [
        `docs/wiki/${r.page.rel}`,
        {
          page: r.page,
          title: r.page.title,
          terms: new Set(r.terms),
          idTerms: new Set(r.idTerms),
          shownIdTerms: new Set(r.shownIdTerms),
          cur: [...r.terms].filter((t) => curSet.has(t)).length,
          currentRelevance: currentRanks.get(r.page.rel)?.relevance ?? 0,
          currentCoverage: currentRanks.get(r.page.rel)?.coverage ?? 0,
          rule: r.page.rule,
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
    let pages = [...byPage.entries()].filter(([, e]) => e.cur >= 1 && e.currentCoverage >= 2 && e.currentRelevance >= floor);
    const affinity = pages.length < 2 ? null : opts.affinity !== undefined ? opts.affinity : loadAffinity(repo);
    const top = pages.reduce((m, [, e]) => Math.max(m, e.relevance), 0) || 1;
    // Relevance is rescaled so the best page scores 10: affinity's bounded shift keeps the
    // magnitude it was tuned on (a gap of ~2 points never flips).
    const ranked = (rel: string, e: { relevance: number; page: WikiPage }) =>
      adjustedScore((10 * e.relevance) / top, affinity, rel);
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
    const pointer = ([rel, e]: (typeof pages)[number]) =>
      `  • ${e.title}${currencyMark({ deprecated: false, stale: e.page.stale, sourceChanged: e.page.sourceChanged, reportedWrong: e.page.reportedWrong })}  →  ${rel}${why(e)}`;
    if (!excerptEnabled()) return [head, ...pages.map(pointer)].join("\n");

    // Excerpts share what the header and pointer lines leave of TURN_MAX_CHARS, in rank order: each
    // page may take an equal share of the remainder (≤ EXCERPT_MAX_FIRST / _REST), and what a short excerpt
    // leaves passes to the next. Body text is read only for the ≤ MAX_PAGES pages shown.
    const xhead = EXCERPT_HEADS[koRepo ? "ko" : "en"](displayRoot(root));
    // Rarity of each current term across this wiki — the same idf the ranker scores with.
    const rarity = new Map([...curSet].map((t) => {
      const df = wikiPages.filter((p) => p.identity.includes(t) || p.trigger.includes(t) || p.body.includes(t)).length;
      return [t, Math.log(1 + wikiPages.length / (1 + df))] as const;
    }));
    let left = maxChars - xhead.length - pages.reduce((n, p) => n + 1 + pointer(p).length, 0);
    const L = [xhead];
    pages.forEach((p, i) => {
      const [rel, e] = p;
      L.push(pointer(p));
      // A source change does not prove this page false, and silencing it hid nearly every page of
      // a code-citing wiki. Its claims still come through, behind a recheck warning; a declared
      // rule does not, because a rule is injected as an instruction to follow.
      if ((e.page.sourceChanged || e.page.reportedWrong) && e.rule) return;
      const warn = e.page.reportedWrong
        ? (koRepo ? "⚠ 이전 세션이 틀림으로 보고함 — 원자료 재확인 전 현재 지침으로 사용하지 말 것" : "⚠ reported wrong by a prior session — recheck raw evidence before using as current guidance")
        : e.page.sourceChanged ? SOURCE_CHANGED_WARN[koRepo ? "ko" : "en"] : null;
      const warnCost = warn ? EXCERPT_INDENT.length + warn.length + 1 : 0;
      const cap = i === 0 ? EXCERPT_MAX_FIRST : EXCERPT_MAX_REST;
      const share = Math.min(cap, Math.floor((left - warnCost) / (pages.length - i)) + (i === 0 ? EXCERPT_FIRST_BONUS : 0));
      const text = e.rule ? "" : (readRepoFile(root, rel) ?? "");
      const lines = pageExcerpt(splitFrontmatter(text).body, {
        rule: e.rule,
        description: e.page.description,
        terms: [...e.terms].filter((t) => curSet.has(t)),
        named: [...e.shownIdTerms],
        max: share,
        ko: koRepo,
        weights: rarity,
      });
      // The warning qualifies text; with no excerpt it would only spend budget.
      if (warn && lines.length) {
        L.push(`${EXCERPT_INDENT}${warn}`);
        left -= warnCost;
      }
      for (const l of lines) {
        L.push(`${EXCERPT_INDENT}${l}`);
        left -= EXCERPT_INDENT.length + l.length + 1;
      }
    });
    return L.join("\n");
  } catch {
    return ""; // fail-safe: a turn-context failure must never surface into the session
  }
}
