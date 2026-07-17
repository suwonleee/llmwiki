// quiz — the human-side memory loop (spaced repetition over the wiki's judgment layer).
//
// The compounding loop so far closes only the LLM's side: capture → update → read-injection
// keeps the MODEL grounded, while the human's memory of their own decisions decays on the
// forgetting curve. The labor split leaves exactly one duty that cannot
// be delegated — direction + contradiction judgment — and that judgment is only as good as
// what the human still REMEMBERS of past decisions and their why. This module closes the
// human loop deterministically: day-granular spaced repetition (Ebbinghaus-flavored,
// minimum 1 day) over the wiki's own pages.
//
// Labor split within the feature (same rule as the rest of the engine):
//   • ENGINE (this file, LLM-0): candidate scan, priority selection, box/interval scheduling,
//     the ledger. Deterministic, regenerable, testable.
//   • SKILL (/wiki-quiz, warm session): question authoring + gist-grading + the human-readable
//     session record. Judgment stays warm; bookkeeping stays deterministic.
//
// Design rules:
//   • docs/wiki/<quizDir>/ is a HUMAN-ONLY layer: excluded from indexing at the db.ts walk
//     guard, hence invisible to search/lint/review/synthesis/cold-start. The wiki must never
//     re-ingest its own quiz artifacts (a self-feeding loop the anti-drift rule forbids) —
//     the flow is one-directional: wiki → human.
//   • Ledger = quiz-ledger.md in the gap-queue pattern: one human-readable line per item plus
//     a machine marker (<!-- quiz:{json} -->). Engine-owned; hand-editing markers is
//     unsupported (any quiz-record rewrites the file whole).
//   • Dates are day-granular UTC YYYY-MM-DD (the engine-wide convention). An item asked today
//     is never re-selected today — the minimum interval really is 1 day.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, isHumanReviewDir, logDirs, effectiveKo, type WikiConfig } from "./config.ts";
import { parseFrontmatter } from "./lint.ts";

// Box intervals in days. Ebbinghaus reviews are minutes/hours/days, but a chat-ritual quiz
// can't fire sub-daily — so the curve is flattened to day granularity with the classic
// expanding cadence; the last box repeats as long-term maintenance.
export const INTERVALS = [1, 3, 7, 16, 35, 60];
export const LEDGER_BASENAME = "quiz-ledger.md";

export type QuizResult = "correct" | "wrong" | "skip";
const RESULTS = new Set<string>(["correct", "wrong", "skip"]);

export interface QuizEntry {
  page: string; // wiki-relative path ("3_decision/x.md") — the item's identity
  box: number; // index into INTERVALS (clamped to the last box)
  due: string; // YYYY-MM-DD next review date
  asked: number;
  correct: number;
  last: string; // YYYY-MM-DD last asked
  lastResult: QuizResult;
  lastQ: string; // last question asked (so the next one varies the angle)
}

export interface QuizCandidate {
  page: string;
  dir: string;
  domain: string;
  title: string;
  date: string; // frontmatter updated ?? date ?? "" (newest-first sort key)
  weight: number;
}

export type SelectionKind = "wrong-due" | "review-due" | "new";

export interface QuizPick {
  kind: SelectionKind;
  page: string;
  entry?: QuizEntry; // ledger-backed picks
  candidate?: QuizCandidate; // new picks
}

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const t = Date.parse(iso + "T00:00:00Z");
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accept "docs/wiki/3_decision/x.md" or "3_decision/x.md" (posix or windows slashes) and
// return the canonical wiki-relative identity. Rejects traversal — the ledger must never
// point outside docs/wiki.
export function normalizePage(page: string): string {
  let p = (page || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("docs/wiki/")) p = p.slice("docs/wiki/".length);
  if (!p || !p.endsWith(".md")) throw new Error(`quiz page must be a .md path under docs/wiki: ${JSON.stringify(page)}`);
  if (p.split("/").some((seg) => seg === ".." || seg === "")) throw new Error(`quiz page path invalid: ${JSON.stringify(page)}`);
  return p;
}

// One-line, HTML-comment-safe question text ("-->" would terminate the marker).
function sanitizeQ(q: string): string {
  return q.replace(/\s+/g, " ").replace(/-->/g, "→").trim().slice(0, 200);
}

function ledgerPath(root: string, cfg: WikiConfig): string {
  return join(root, "docs", "wiki", cfg.quizDir, LEDGER_BASENAME);
}

// ---- ledger (parse ↔ render round-trip; markers carry the state) ---------------------------

export function parseLedger(md: string): QuizEntry[] {
  const out: QuizEntry[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/<!--\s*quiz:(\{.*\})\s*-->\s*$/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]!);
      const box = Number(j.box);
      const result = String(j.lastResult ?? "");
      if (typeof j.page !== "string" || !j.page.endsWith(".md")) continue;
      // Markers are engine-written canonical identities; a hand-edited traversal path must not
      // become an existsSync/readFileSync probe outside docs/wiki.
      try {
        if (normalizePage(j.page) !== j.page) continue;
      } catch {
        continue;
      }
      if (!Number.isInteger(box) || box < 0 || box >= INTERVALS.length) continue;
      if (!DATE_RE.test(String(j.due)) || !DATE_RE.test(String(j.last))) continue;
      if (!RESULTS.has(result)) continue;
      out.push({
        page: j.page,
        box,
        due: String(j.due),
        asked: Math.max(0, Number(j.asked) || 0),
        correct: Math.max(0, Number(j.correct) || 0),
        last: String(j.last),
        lastResult: result as QuizResult,
        lastQ: typeof j.lastQ === "string" ? j.lastQ : "",
      });
    } catch {
      /* fail-safe: a malformed marker is skipped; the next rewrite re-normalizes the file */
    }
  }
  return out;
}

export function renderLedger(entries: QuizEntry[], date: string, ko: boolean): string {
  const sorted = [...entries].sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.page < b.page ? -1 : 1));
  const row = (e: QuizEntry) =>
    `- ${e.page} — box ${e.box} · due ${e.due} · ${e.correct}/${e.asked} · last ${e.last} ${e.lastResult}` +
    `  <!-- quiz:${JSON.stringify(e)} -->`;
  const fm =
    `---\ntitle: Quiz ledger\n` +
    (ko
      ? `description: 사람 기억 장부 — 망각곡선(일 단위) 복습 스케줄. 엔진 관리(quiz-record), 마커 수동 수정 금지\n`
      : `description: human memory ledger — day-granular spaced-repetition schedule. Engine-managed (quiz-record); never hand-edit markers\n`) +
    `date: ${date}\nupdated: ${date}\ntags: [quiz, meta]\nstatus: ready\ndomain: meta\nsource: quiz-engine\n---\n`;
  const note = ko
    ? `\n> 자동 관리(LLM-0): /wiki-quiz 가 문항을 내고(웜), quiz-record 가 이 장부를 갱신한다(결정적).\n` +
      `> 정답 → 다음 박스(${INTERVALS.join("·")}일), 오답·모름 → box 0 리셋. due ≤ 오늘 = 복습 대상.\n` +
      `> 이 폴더(퀴즈 레이어)는 인덱스·검색·콜드스타트에서 제외된다 — 위키→사람 단방향.\n\n`
    : `\n> Auto-managed (LLM-0): /wiki-quiz authors questions (warm); quiz-record updates this ledger (deterministic).\n` +
      `> correct → next box (${INTERVALS.join("·")} days), wrong/skip → reset to box 0. due ≤ today = up for review.\n` +
      `> This folder (the quiz layer) is excluded from index/search/cold-start — one-directional wiki → human.\n\n`;
  return fm + note + `## Items (${sorted.length})\n\n` + (sorted.length ? sorted.map(row).join("\n") : "(none)") + "\n";
}

export function loadLedger(ws: string): { entries: QuizEntry[]; path: string } {
  const root = resolve(ws);
  const path = ledgerPath(root, getConfig(root));
  if (!existsSync(path)) return { entries: [], path };
  try {
    return { entries: parseLedger(readFileSync(path, "utf-8")), path };
  } catch {
    return { entries: [], path };
  }
}

function saveLedger(root: string, cfg: WikiConfig, entries: QuizEntry[], date: string): string {
  const dir = join(root, "docs", "wiki", cfg.quizDir);
  mkdirSync(dir, { recursive: true });
  const path = ledgerPath(root, cfg);
  writeFileSync(path, renderLedger(entries, date, effectiveKo(cfg)), "utf-8");
  return path;
}

// ---- candidates (what has never been quizzed) -----------------------------------------------

// Question-worthiness weight: the human-judgment layer first (direction-class), then decisions,
// then insights/topics, milestones last — "ask about judgment and why, not execution detail".
// Custom configs keep a sane order via the review field; stock domains get the exact intent.
// The dir is the authoritative filing truth — the config category's domain outranks a missing
// or nonstandard frontmatter `domain:` (else a domain-less milestone would outrank a real one).
export function weightFor(dir: string, domain: string, cfg: WikiConfig): number {
  if (isHumanReviewDir(dir, cfg)) return 4;
  if (dir === cfg.topicDir) return 2;
  const d = (cfg.categories.find((c) => c.dir === dir)?.domain ?? domain ?? "").toLowerCase();
  if (d.includes("decision") || d.includes("adr")) return 3;
  if (d.includes("milestone") || d.includes("progress")) return 1;
  return 2;
}

// Scan the log layer + topic encyclopedia for quizzable pages. legacyDirs are deliberately
// NOT scanned (pre-loop flat content; the memory loop covers the current-format wiki), and
// neither is the queue (0_review is a queue, not knowledge). Category folders are flat by
// convention, so no recursion. superseded pages are history, draft pages await the human —
// neither is memory-worthy yet.
export function scanCandidates(ws: string): QuizCandidate[] {
  const root = resolve(ws);
  const cfg = getConfig(root);
  const wiki = join(root, "docs", "wiki");
  const out: QuizCandidate[] = [];
  for (const dir of [...logDirs(cfg), cfg.topicDir]) {
    const abs = join(wiki, dir);
    if (!existsSync(abs)) continue;
    let files: string[];
    try {
      files = readdirSync(abs).filter((n) => n.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      let meta: Record<string, string | string[]>;
      try {
        meta = parseFrontmatter(readFileSync(join(abs, f), "utf-8"));
      } catch {
        continue;
      }
      const status = String(meta.status ?? "ready");
      if (status === "superseded" || status === "draft") continue;
      const domain = String(meta.domain ?? "");
      out.push({
        page: `${dir}/${f}`,
        dir,
        domain,
        title: String(meta.title ?? f.replace(/\.md$/, "")),
        date: String(meta.updated ?? meta.date ?? ""),
        weight: weightFor(dir, domain, cfg),
      });
    }
  }
  return out;
}

// A ledger entry stays selectable only while its page is still live knowledge (an existing
// file that is neither superseded history nor an unconfirmed draft).
function statusLive(abs: string): boolean {
  try {
    const status = String(parseFrontmatter(readFileSync(abs, "utf-8")).status ?? "ready");
    return status !== "superseded" && status !== "draft";
  } catch {
    return false;
  }
}

// ---- selection (the priority contract) ------------------------------------------------------
//
// ① wrong/skip items due (the answer the human couldn't give — highest value), oldest due first
// ② correct items whose forgetting-curve review has arrived, oldest due first
// ③ never-quizzed pages, weight desc (direction > decision > insight/topic > milestone),
//    then newest first — recent work while it's still warm
// Items asked today are excluded outright (day granularity: one exposure per day per item).

export interface QuizSelection {
  picks: QuizPick[];
  dueWrong: number; // total due in ① (before limit)
  dueReview: number; // total due in ② (before limit)
  newCandidates: number; // total in ③ (before limit)
  askedToday: number;
  missing: string[]; // ledger pages that vanished / went superseded (pruned on next record)
}

export function selectNext(ws: string, opts: { limit?: number; date?: string } = {}): QuizSelection {
  const root = resolve(ws);
  const date = opts.date ?? todayUTC();
  const limit = Math.max(1, opts.limit ?? 5);
  const { entries } = loadLedger(root);

  // Vanished pages are reported (and pruned on the next record); a page that merely went
  // superseded/draft leaves rotation SILENTLY — its entry is history, not an error.
  const missing: string[] = [];
  const live: QuizEntry[] = [];
  for (const e of entries) {
    const abs = join(root, "docs", "wiki", e.page);
    if (!existsSync(abs)) missing.push(e.page);
    else if (statusLive(abs)) live.push(e);
  }

  const askedToday = live.filter((e) => e.last === date).length;
  const eligible = live.filter((e) => e.last !== date);
  const byDue = (a: QuizEntry, b: QuizEntry) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.page < b.page ? -1 : 1);
  const wrongDue = eligible.filter((e) => e.lastResult !== "correct" && e.due <= date).sort(byDue);
  const reviewDue = eligible.filter((e) => e.lastResult === "correct" && e.due <= date).sort(byDue);

  const inLedger = new Set(entries.map((e) => e.page));
  const news = scanCandidates(root)
    .filter((c) => !inLedger.has(c.page))
    .sort((a, b) =>
      a.weight !== b.weight ? b.weight - a.weight : a.date !== b.date ? (a.date > b.date ? -1 : 1) : a.page < b.page ? -1 : 1,
    );

  const picks: QuizPick[] = [
    ...wrongDue.map((e): QuizPick => ({ kind: "wrong-due", page: e.page, entry: e })),
    ...reviewDue.map((e): QuizPick => ({ kind: "review-due", page: e.page, entry: e })),
    ...news.map((c): QuizPick => ({ kind: "new", page: c.page, candidate: c })),
  ].slice(0, limit);

  return { picks, dueWrong: wrongDue.length, dueReview: reviewDue.length, newCandidates: news.length, askedToday, missing };
}

// ---- record (the only writer; forgetting-curve step) ----------------------------------------

export interface RecordOutcome {
  entry: QuizEntry;
  path: string;
  isNew: boolean;
  pruned: string[]; // vanished pages dropped from the ledger on this rewrite
}

export function recordResult(
  ws: string,
  opts: { page: string; result: QuizResult; question?: string; date?: string },
): RecordOutcome {
  const root = resolve(ws);
  const cfg = getConfig(root);
  const date = opts.date ?? todayUTC();
  if (!RESULTS.has(opts.result)) throw new Error(`result must be correct|wrong|skip: ${JSON.stringify(opts.result)}`);
  if (!DATE_RE.test(date)) throw new Error(`--date must be YYYY-MM-DD: ${JSON.stringify(date)}`);
  const page = normalizePage(opts.page);
  if (!existsSync(join(root, "docs", "wiki", page))) throw new Error(`page not found under docs/wiki/: ${page}`);
  // Only quizzable content is recordable — the same dirs scanCandidates feeds from. Blocks the
  // queue, the quiz layer itself (yes, the ledger was recordable), L0/overview/log root files.
  const top = page.split("/")[0] ?? "";
  const allowed = [...logDirs(cfg), cfg.topicDir];
  if (!allowed.includes(top))
    throw new Error(`page must live in a quizzable dir (${allowed.join(", ")}): ${page}`);

  const { entries } = loadLedger(root);
  const kept: QuizEntry[] = [];
  const pruned: string[] = [];
  for (const e of entries) {
    if (e.page === page) continue; // re-inserted below
    if (!existsSync(join(root, "docs", "wiki", e.page))) pruned.push(e.page);
    else kept.push(e);
  }
  const prior = entries.find((e) => e.page === page);
  // Leitner step, day-granular: correct climbs one box (a NEW page answered correctly starts
  // at box 1 — it was recallable, skip the 1-day check); wrong/skip resets to box 0 (due
  // tomorrow — never same-day, the curve's floor).
  const box = opts.result === "correct" ? Math.min((prior ? prior.box : 0) + 1, INTERVALS.length - 1) : 0;
  const entry: QuizEntry = {
    page,
    box,
    due: addDays(date, INTERVALS[box]!),
    asked: (prior?.asked ?? 0) + 1,
    correct: (prior?.correct ?? 0) + (opts.result === "correct" ? 1 : 0),
    last: date,
    lastResult: opts.result,
    lastQ: opts.question !== undefined ? sanitizeQ(opts.question) : (prior?.lastQ ?? ""),
  };
  kept.push(entry);
  const path = saveLedger(root, cfg, kept, date);
  return { entry, path, isNew: !prior, pruned };
}

// ---- status / cold-start hint ----------------------------------------------------------------

export interface QuizStatus {
  total: number;
  dueWrong: number;
  dueReview: number;
  askedToday: number;
  newCandidates: number;
  nextDue: string; // earliest future due ("" when none scheduled)
  weak: { page: string; asked: number; correct: number }[]; // <50% over 3+ asks — re-read these
  missing: string[];
}

export function quizStatus(ws: string, opts: { date?: string } = {}): QuizStatus {
  const date = opts.date ?? todayUTC();
  const sel = selectNext(ws, { limit: 1, date });
  const { entries } = loadLedger(ws);
  const weak = entries
    .filter((e) => e.asked >= 3 && e.correct / e.asked < 0.5)
    .map((e) => ({ page: e.page, asked: e.asked, correct: e.correct }))
    .sort((a, b) => a.correct / a.asked - b.correct / b.asked);
  const future = entries.filter((e) => e.due > date).map((e) => e.due).sort();
  return {
    total: entries.length,
    dueWrong: sel.dueWrong,
    dueReview: sel.dueReview,
    askedToday: sel.askedToday,
    newCandidates: sel.newCandidates,
    nextDue: future[0] ?? "",
    weak,
    missing: sel.missing,
  };
}

// Cheap due-count for the cold-start hint: one ledger read + an existence/status check per DUE
// item only — no page walk (cold-start latency contract). Must agree with what selectNext can
// actually offer (existing + live), or a superseded due page nags forever with nothing pickable.
// Fail-safe 0 — the hint must never break a session.
export function dueCount(ws: string, date?: string): number {
  try {
    const root = resolve(ws);
    const d = date ?? todayUTC();
    const { entries } = loadLedger(root);
    return entries.filter((e) => {
      if (e.due > d || e.last === d) return false;
      const abs = join(root, "docs", "wiki", e.page);
      return existsSync(abs) && statusLive(abs);
    }).length;
  } catch {
    return 0;
  }
}
