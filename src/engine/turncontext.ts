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
// Works with the trigram FTS (schema.sql): term extraction is language-neutral — ASCII
// identifier-ish tokens (any user language keeps code terms in ASCII) + CJK runs ≥3 chars
// (the FTS5 trigram floor; shorter runs cannot match and are dropped).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { WikiIndex } from "./db.ts";
import { effectiveKo, getConfig } from "./config.ts";

const MAX_TERMS = 12;
const MAX_PAGES = 3;
// Header language + L0/meta page names resolve per repo at call time (per-repo config).
const HEADS = {
  en: "----- [llmwiki turn-context] wiki pages related to this prompt (pointers — Read on demand) -----",
  ko: "----- [llmwiki turn-context] 이 프롬프트와 관련된 위키 페이지 (포인터 — 필요 시 Read) -----",
};

// ---- term extraction (deterministic, language-neutral) ------------------------

// ASCII identifier-ish tokens: words, dotted/slashed paths, snake/kebab identifiers.
// ≥4 chars keeps "the/and/for"-class noise out without a stopword list.
const ASCII_RE = /[A-Za-z_][A-Za-z0-9_./-]{3,}/g;
// Unspaced CJK runs (Hangul / Han / Kana). ≥3 chars — the FTS5 trigram matching floor.
const CJK_RE = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{3,}/gu;

export function extractTerms(prompt: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const re of [ASCII_RE, CJK_RE]) {
    for (const m of prompt.matchAll(re)) {
      const t = m[0]!.replace(/[./-]+$/, ""); // trim trailing punctuation-ish tail
      if (t.length < 3) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push(t);
    }
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

function dedupPath(repo: string, sessionId: string): string {
  const h = createHash("sha1").update(`${sessionId}\n${repo}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `llmwiki-turnctx-${h}.json`);
}

function readState(p: string): TurnState {
  try {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
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
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify({ seen: [...st.seen], terms: st.terms }), "utf-8");
  } catch {
    /* best-effort */
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
function termWeight(t: string): number {
  const cjk = /[^\x00-\x7F]/.test(t);
  return (cjk ? t.length >= 5 : t.length >= 8) ? 2 : 1;
}

export function buildTurnContext(repo: string, prompt: string, sessionId = ""): string {
  try {
    const cfg = getConfig(repo);
    // L0 / meta pages are already injected whole at session start — never re-suggest them.
    const l0Basenames = new Set([cfg.files.overview, cfg.files.l0, cfg.files.log, "index.md"]);
    const head = HEADS[effectiveKo(cfg) ? "ko" : "en"];
    const terms = extractTerms(prompt ?? "");
    if (!terms.length) return "";

    const w = new WikiIndex(repo);
    if (!existsSync(w.dbPath)) return ""; // no index yet — stay silent, never create state

    // HQE-lite (P1): fold prior-turn terms into this turn's query. Persist the merged
    // weights immediately so even a silent turn feeds the next one.
    const sp = sessionId ? dedupPath(w.root, sessionId) : "";
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
      rows = w.search(db, ftsQuery(queryTerms), 40, "wiki", true); // raw: pre-quoted OR query
    } finally {
      db.close();
    }
    if (!rows.length) return "";

    // aggregate chunk hits per page; score = distinct terms present in matched chunks.
    // Carried terms add score but can't qualify a page alone — a page must match ≥1 term
    // from the CURRENT prompt (precision gate: a topic switch is never polluted by history).
    const curSet = new Set(terms.map((t) => t.toLowerCase()));
    const byPage = new Map<string, { title: string; terms: Set<string>; cur: number; hits: number }>();
    for (const r of rows) {
      const rel = String(r.relative_path ?? "");
      const base = rel.split("/").pop() ?? "";
      if (!rel.includes("docs/wiki/") || l0Basenames.has(base) || rel.includes(`/${cfg.queueDir}/`)) continue;
      const e =
        byPage.get(rel) ?? { title: String(r.title ?? base), terms: new Set<string>(), cur: 0, hits: 0 };
      e.hits += 1;
      const content = String(r.content ?? "").toLowerCase();
      for (const t of queryTerms) {
        const lt = t.toLowerCase();
        if (!content.includes(lt)) continue;
        if (!e.terms.has(lt) && curSet.has(lt)) e.cur += 1;
        e.terms.add(lt);
      }
      byPage.set(rel, e);
    }

    const score = (e: { terms: Set<string> }) =>
      [...e.terms].reduce((s, t) => s + termWeight(t), 0);
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
