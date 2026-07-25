// gaps (P2): turn review's terminal report into a tracked, self-closing backlog.
//
// review (the semantic lint) surfaces "missing concept pages" and "next questions" but writes them
// into a dated 0_review report that nobody actions — the loop never closes. This materializes those
// findings as NAMED gaps (chum-mem: name gaps, don't silently omit) in a single append-managed
// queue, and closes a gap when review stops re-emitting it (wikidesk loop closure). LLM-0 — it only
// parses review's own output + the existing queue. Gaps are FACT bookkeeping (missing topic pages,
// cross-links), so filling them is the LLM's job, not the human's — /wiki-deep fills them directly
// (humans abandon wikis when maintenance lands on them; the model does the grunt work).
// Only genuine judgment calls (contradictory measurements, direction) are left for the human.
//
// Close safety: review is a (bounded, non-deterministic) LLM pass, so a single absence is not proof a
// gap is resolved. A gap is closed only after it is ABSENT from RESOLVE_AFTER consecutive reviews
// (loop-until-dry); any reappearance resets it to open.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { effectiveKo, getConfig, isRepoKorean } from "./config.ts";
import { gapStatePath, loadResolvedGapState, writeResolvedGapState } from "./gap-state.ts";

export const RESOLVE_AFTER = 2; // consecutive absent reviews before a gap is closed
export const RECENT_RESOLVED_LIMIT = 20;

export interface Gap {
  hash: string;
  type: string; // "missing-concept" | "next-question"
  text: string;
  status: "open" | "resolved";
  absent: number; // consecutive reviews this gap was NOT emitted
  firstSeen: string;
  lastSeen: string;
  resolvedAt?: string;
}

// normalize for stable identity across re-phrasings (lowercase, strip wikilinks/punct/space)
function _norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function _hash(type: string, text: string): string {
  return createHash("sha256").update(`${type}|${_norm(text)}`).digest("hex").slice(0, 12);
}

// Section heading matchers (review emits in the page's language — match EN + KO).
const SEC = {
  "missing-concept": /^##\s+.*(missing concept|개념\s*누락)/i,
  "next-question": /^##\s+.*(cross-reference|교차참조|next question|다음\s*질문)/i,
};
const NONE = /^\(?(none|없음|해당\s*없음|n\/a)\)?\.?$/i;
const QUEUE_ROW =
  /^\s*-\s*\[(x| )\]\s*\((missing-concept|next-question)\)\s*(.*?)\s*<!--\s*gap:([0-9a-f]+)\s+absent:(\d+)\s+seen:([0-9-]+)\.\.([0-9-]+)(?:\s+resolved:([0-9-]+))?\s*-->/i;

// Pull gap items out of a review report body. Returns {type, text} for each real bullet.
export function extractGapsFromReview(reviewText: string): { type: string; text: string }[] {
  const lines = reviewText.split("\n");
  const out: { type: string; text: string }[] = [];
  let cur: string | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s/.test(line)) {
      cur = null;
      for (const [type, re] of Object.entries(SEC)) if (re.test(line)) cur = type;
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m) continue;
    const text = m[1]?.trim();
    if (!text) continue;
    if (NONE.test(text)) continue;
    out.push({ type: cur, text });
  }
  return out;
}

// Parse an existing gap-queue.md back into Gap[] (state carried in HTML-comment markers).
export function parseQueue(md: string): Gap[] {
  const out: Gap[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(QUEUE_ROW);
    if (!m) continue;
    const status = m[1];
    const type = m[2];
    const text = m[3];
    const hash = m[4];
    const absent = m[5];
    const firstSeen = m[6];
    const lastSeen = m[7];
    if (
      (status !== "x" && status !== " ") ||
      type === undefined ||
      text === undefined ||
      hash === undefined ||
      absent === undefined ||
      firstSeen === undefined ||
      lastSeen === undefined
    ) {
      continue;
    }
    const gap: Gap = {
      status: status === "x" ? "resolved" : "open",
      type,
      text: text.replace(/—\s*covered.*$/, "").trim(),
      hash,
      absent: parseInt(absent, 10) || 0,
      firstSeen,
      lastSeen,
    };
    if (m[8]) gap.resolvedAt = m[8];
    out.push(gap);
  }
  return out;
}

function isQueueWellFormed(md: string): boolean {
  const lines = md.split("\n");
  const hasOpenHeading = lines.some((line) => /^## Open \(\d+\)\s*$/.test(line));
  const hasResolvedHeading = lines.some((line) => /^## Resolved \(\d+(?: total; showing \d+ most recent)?\)\s*$/.test(line));
  return hasOpenHeading && hasResolvedHeading && lines.filter((line) => /^\s*-\s*\[/.test(line)).every((line) => QUEUE_ROW.test(line));
}

function compareOpen(a: Gap, b: Gap): number {
  return a.firstSeen === b.firstSeen ? a.hash.localeCompare(b.hash) : a.firstSeen.localeCompare(b.firstSeen);
}

function compareRecentResolved(a: Gap, b: Gap): number {
  const aDate = a.resolvedAt ?? a.lastSeen;
  const bDate = b.resolvedAt ?? b.lastSeen;
  return aDate === bDate ? a.hash.localeCompare(b.hash) : bDate.localeCompare(aDate);
}

export function renderQueue(gaps: Gap[], date: string, ko: boolean = effectiveKo()): string {
  const open = gaps.filter((g) => g.status === "open").sort(compareOpen);
  const resolved = gaps.filter((g) => g.status === "resolved");
  const recentResolved = [...resolved].sort(compareRecentResolved).slice(0, RECENT_RESOLVED_LIMIT);
  const row = (g: Gap) =>
    `- [${g.status === "resolved" ? "x" : " "}] (${g.type}) ${g.text}` +
    `  <!-- gap:${g.hash} absent:${g.absent} seen:${g.firstSeen}..${g.lastSeen}${g.resolvedAt ? ` resolved:${g.resolvedAt}` : ""} -->`;
  // Page content in the user's repository — the header follows the wiki's language. The rows and
  // the `## Open (N)` / `## Resolved (N …)` headings stay language-invariant: they are the
  // machine-managed part this file's own parser reads back.
  const fm =
    `---\ntitle: Gap queue\n` +
    (ko
      ? `description: review가 표면화한 미해결 갭(개념 누락·다음 질문) 추적 — 채우면 자동 close\n`
      : `description: open gaps surfaced by review (missing concepts · next questions) — auto-closes once filled\n`) +
    `date: ${date}\nupdated: ${date}\ntags: [gap-queue, meta]\nstatus: ready\ndomain: meta\nsource: semantic-lint\n---\n`;
  const note = ko
    ? `\n> 자동 관리(LLM-0): review가 표면화한 사실 갭(개념 페이지·교차링크). 채우는 것도 LLM의 북키핑 — /wiki-deep 가 직접 작성. 사람 판단은 모순·방향성만.\n` +
      `> ${RESOLVE_AFTER}회 연속 review에서 안 보이면 자동 close.\n\n`
    : `\n> Auto-managed (LLM-0): fact gaps surfaced by review (concept pages · cross-links). Filling them is the LLM's bookkeeping too — /wiki-deep writes them; humans judge only contradictions and direction.\n` +
      `> Absent from ${RESOLVE_AFTER} consecutive reviews → closed automatically.\n\n`;
  return (
    fm +
    note +
    `> Summary: ${open.length} open · ${resolved.length} resolved total · showing ${recentResolved.length} most recent resolved.\n\n` +
    `## Open (${open.length})\n\n` +
    (open.length ? open.map(row).join("\n") : "(none)") +
    `\n\n## Resolved (${resolved.length} total; showing ${recentResolved.length} most recent)\n\n` +
    (recentResolved.length ? recentResolved.map(row).join("\n") : "(none)") +
    "\n"
  );
}

function _latestReview(root: string): string | null {
  const dir = join(root, "docs", "wiki", getConfig(root).queueDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^semantic-review-.*\.md$/.test(f))
    .sort();
  const latest = files.at(-1);
  return latest === undefined ? null : join(dir, latest);
}

export interface GapResult {
  verdict: "refreshed" | "skip";
  open?: number;
  resolved?: number;
  added?: number;
  path?: string;
  reason?: string;
}

// Merge the latest review's gaps into the queue: reappearing → open(absent=0); newly-absent →
// absent+1 (→ resolved at RESOLVE_AFTER); brand-new → open. Pure-ish (only reads review + queue).
export function refreshGapQueue(ws: string, date: string, opts: { check?: boolean } = {}): GapResult {
  const root = resolve(ws);
  const reviewPath = _latestReview(root);
  if (!reviewPath) {
    const ko = isRepoKorean(root);
    return { verdict: "skip", reason: ko ? "review 리포트 없음(먼저 review 실행)" : "no review report yet (run review first)" };
  }
  const current = extractGapsFromReview(readFileSync(reviewPath, "utf-8"));
  const queuePath = join(root, "docs", "wiki", getConfig(root).queueDir, "gap-queue.md");
  const queue = existsSync(queuePath) ? readFileSync(queuePath, "utf-8") : null;
  if (queue !== null && !isQueueWellFormed(queue)) {
    return { verdict: "skip", reason: "gap queue malformed; preserve it and recover before refresh" };
  }
  const prior = queue === null ? [] : parseQueue(queue);

  const byHash = new Map<string, Gap>(prior.map((g) => [g.hash, g]));
  const resolvedState = loadResolvedGapState(gapStatePath(root));
  if (resolvedState !== null) {
    for (const gap of resolvedState) if (!byHash.has(gap.hash)) byHash.set(gap.hash, { ...gap });
  }
  const seenNow = new Set<string>();
  let added = 0;
  for (const c of current) {
    const h = _hash(c.type, c.text);
    seenNow.add(h);
    const ex = byHash.get(h);
    if (ex) {
      ex.status = "open";
      ex.absent = 0;
      ex.lastSeen = date;
      ex.text = c.text; // refresh phrasing
      ex.resolvedAt = undefined;
    } else {
      byHash.set(h, { hash: h, type: c.type, text: c.text, status: "open", absent: 0, firstSeen: date, lastSeen: date });
      added++;
    }
  }
  // gaps not emitted this run → age them; close after RESOLVE_AFTER consecutive absences
  for (const g of byHash.values()) {
    if (seenNow.has(g.hash)) continue;
    if (g.status === "resolved") continue;
    g.absent += 1;
    if (g.absent >= RESOLVE_AFTER) {
      g.status = "resolved";
      g.resolvedAt = date;
    }
  }
  const gaps = [...byHash.values()].sort((a, b) =>
    a.status !== b.status ? (a.status === "open" ? -1 : 1) : a.firstSeen < b.firstSeen ? -1 : 1,
  );
  const open = gaps.filter((g) => g.status === "open").length;
  const resolved = gaps.filter((g) => g.status === "resolved").length;
  if (!opts.check) {
    const dir = join(root, "docs", "wiki", getConfig(root).queueDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(queuePath, renderQueue(gaps, date, isRepoKorean(root)), "utf-8");
    const stateDir = join(root, ".llmwiki");
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeResolvedGapState(gapStatePath(root), gaps);
  }
  return { verdict: "refreshed", open, resolved, added, path: queuePath };
}
