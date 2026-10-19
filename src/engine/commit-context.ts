// Commit messages as a second per-turn source, next to the wiki.
//
// A commit message says what changed and often why, it is never rotated away like a transcript,
// and a fresh clone has thousands of them before its wiki has a page. Measured 2026-10-19 on one
// project wiki (22 questions, same 1,600-char budget): wiki alone delivered 24% of the needed
// facts, wiki + commit messages 75% (the question set favoured commits; on the older 10 questions
// both sources tied at 36%). Sealed test across 7 repositories (2026-10-19): commit-only answers
// 1/36 → 30/36, wiki facts unchanged or better. On by default; `LLMWIKI_TURN_COMMITS=off` disables.
//
// Read-only and fail-safe: one bounded `git log`, no state, no index. Ranked by the wiki's own
// scorer so a commit qualifies under the same evidence rules as a page.
import { spawnSync } from "node:child_process";
import { rankPages, type WikiPage } from "./page-rank.ts";
import { readProjectState, writeProjectStateQuietly } from "./project-state.ts";

const MAX_COMMITS = 3000; // ≈50 ms on a 2,781-commit repo; bounds cost on very long histories
const SHOW = 2;
const BODY_CHARS = 160;
const TOP_BODY_LINES = 3;
const RELEVANCE_FLOOR = 1.5; // same scale as the wiki gate in turncontext.ts
const MIN_BLOCK_CHARS = 120;
const CACHE_FILE = "commit-log.json";

/** On unless `LLMWIKI_TURN_COMMITS=off`. */
export function commitsEnabled(): boolean {
  return (process.env.LLMWIKI_TURN_COMMITS ?? "").trim().toLowerCase() !== "off";
}

export type CommitHit = { sha: string; date: string; subject: string; body: string; subjectTerms?: number; strength?: number };

/** The bounded log, cached per HEAD in the project's existing machine-local state: `git log` is
 * ~50 ms a turn and HEAD rarely moves between turns. No state directory → no cache, never created. */
export function readLog(repo: string): CommitHit[] {
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 1000 });
  const sha = head.status === 0 ? head.stdout.trim() : "";
  if (sha) {
    try {
      const cached = JSON.parse(readProjectState(repo, CACHE_FILE, 32 * 1024 * 1024) ?? "null") as { head?: string; max?: number; log?: CommitHit[] } | null;
      if (cached?.head === sha && cached.max === MAX_COMMITS && Array.isArray(cached.log)) return cached.log;
    } catch { /* a corrupt cache is just a miss */ }
  }
  const log = gitLog(repo);
  if (sha && log.length) {
    try { writeProjectStateQuietly(repo, [CACHE_FILE], JSON.stringify({ head: sha, max: MAX_COMMITS, log })); } catch { /* best effort */ }
  }
  return log;
}

function gitLog(repo: string): CommitHit[] {
  const r = spawnSync(
    "git",
    ["-C", repo, "log", "--no-merges", "-n", String(MAX_COMMITS), "--date=short", "--format=%h%x1f%ad%x1f%s%x1f%b%x1e"],
    { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  return r.stdout.split("\x1e").map((rec) => rec.replace(/^\n/, "").split("\x1f")).filter((f) => f.length >= 3 && f[0])
    .map(([sha, date, subject, body]) => ({ sha: sha!, date: date!, subject: subject!.trim(), body: (body ?? "").trim() }));
}

/** The commits that answer `terms` under the wiki's evidence gate, best first. */
export function relevantCommits(repo: string, terms: readonly string[], limit = SHOW, log: CommitHit[] = readLog(repo)): CommitHit[] {
  if (!terms.length) return [];
  if (!log.length) return [];
  const pages: WikiPage[] = log.map((c) => {
    const text = `${c.subject}\n${c.body}`.toLowerCase();
    return { rel: c.sha, title: c.subject, description: "", status: "stable", identity: c.subject.toLowerCase(), trigger: "",
      rule: "", retired: false, stale: false, body: text };
  });
  const floor = RELEVANCE_FLOOR * Math.log(1 + pages.length);
  const bySha = new Map(log.map((c) => [c.sha, c]));
  return rankPages(pages, terms).filter((r) => r.coverage >= 2 && r.relevance >= floor).slice(0, limit)
    .map((r) => ({ ...bySha.get(r.page.rel)!, subjectTerms: r.idTerms.size, strength: r.relevance / floor }));
}

/** Lines for the turn block, within `budget` characters; [] when nothing fits or qualifies. */
export function commitLines(hits: readonly CommitHit[], terms: readonly string[], budget: number, ko: boolean): string[] {
  if (budget < MIN_BLOCK_CHARS) return [];
  const label = ko ? "  관련 커밋 (git log — 현재 코드로 확인)" : "  related commits (git log — verify against current code)";
  const out = [label];
  let left = budget - label.length - 1;
  const lower = terms.map((t) => t.toLowerCase());
  const matches = (l: string) => lower.filter((t) => l.toLowerCase().includes(t)).length;
  hits.forEach((c, rank) => {
    const head = `  • ${c.sha} ${c.date} — ${c.subject}`;
    if (head.length + 1 > left) return;
    out.push(head);
    left -= head.length + 1;
    // The body lines that share the most prompt terms, kept in the message's own order — the
    // reason is rarely the first line. The best commit shows more of its body than the runner-up.
    const lines = c.body.split("\n").map((l) => l.replace(/^[-*•\s]+/, "").trim()).filter(Boolean);
    const keep = new Set(
      lines.map((l, i) => [matches(l), -i, i] as const).sort((a, b) => b[0] - a[0] || b[1] - a[1])
        .slice(0, rank === 0 ? TOP_BODY_LINES : 1).map(([, , i]) => i),
    );
    for (const [i, l] of lines.entries()) {
      if (!keep.has(i)) continue;
      const line = `      ${l.length > BODY_CHARS ? `${l.slice(0, BODY_CHARS)}…` : l}`;
      if (line.length + 1 > left) break;
      out.push(line);
      left -= line.length + 1;
    }
  });
  return out.length > 1 ? out : [];
}
