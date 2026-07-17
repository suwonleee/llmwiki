// Harness-neutral cold-start context builder — the "read" loop of the compounding cycle.
//
// Emits this repo's docs/wiki cold-start blob so ANY harness can inject it:
//   Claude Code  → SessionStart hook runs `llmwiki context` (the hook is a thin adapter)
//   Codex / etc. → AGENTS.md or a startup prompt runs the same command
//   manual       → run it and paste the output
//
// Language: LLMWIKI_LANG=ko switches the operating-rules/headers to Korean (default: en).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pending } from "./capture.ts";
import { uncitedPending } from "./reconcile.ts";
import { sourceForKind } from "./source.ts";
import { buildSpine, topicGaps } from "./synthesis.ts";
import { auditNudge } from "./context-audit.ts";
import { parseQueue } from "./gaps.ts";
import { dueCount } from "./quiz.ts";
import { effectiveKo, getConfig, renderRuleCategories, renderRuleHumanQueue, scanDirs, type WikiConfig } from "./config.ts";
import { detectConfigDrift } from "./migrate.ts";


// Cold-start L0 standard. The L0 page (current-state, or overview as fallback)
// is injected into EVERY session, so its size is a per-session tax. Principle (human decision
// 2026-07-12): the ~1600-char budget is a STANDARD to trim back to, not a knife — the injection
// NEVER cuts content. A blind tail cut was measured eating exactly what the next session needed
// most (a 1,639-char L0 lost its final Next bullet — a pending-push reminder — at a 1,600 cut),
// and any cut loses signal silently. An over-standard page injects WHOLE with a one-line notice
// appended, so every session SEES the overage and the warm close-out (/wiki-update) is nudged
// into ONE structural trim (move detail to current-state-detail). Discipline comes from
// visibility, not from loss; the oversized-l0 lint adds its structural nag from 1.25× (budgets.ts).
import { L0_BUDGET } from "./budgets.ts";

function l0OverNotice(body: string, notice: (chars: number) => string, budget = L0_BUDGET): string {
  return body.length <= budget ? body : body + "\n" + notice(body.length);
}

// Cold-start footer pointer — overview page + the first two log categories (reading order).
// Stock config renders the historical "overview·1_direction·2_milestone" byte-identically.
const csPointer = (cfg: WikiConfig) =>
  [cfg.files.overview.replace(/\.md$/, ""), ...cfg.categories.slice(0, 2).map((c) => c.dir)].join("·");

// Bilingual UI strings, rendered per resolved config (per-repo). The 0_review [LLM] instruction
// stays English (instruction to the model). Stock config renders the historical text byte-identically.
const makeT = (lang: "ko" | "en", cfg: WikiConfig) =>
  ({
  en: {
    csDetail: (w: string) => `===== (details: ${w}/ ${csPointer(cfg)}) =====`,
    ovDetail: (w: string) => `===== (details: ${w}/) =====`,
    csHead: (n: string) => `===== [llmwiki] ${n} — docs/wiki/current-state (cold-start) =====`,
    ovHead: (n: string) => `===== [llmwiki] ${n} — docs/wiki/overview (cold-start) =====`,
    stale: "----- [llmwiki staleness] L0 (current-state) is older than recent pages — run /wiki-update at session end to refresh -----",
    rulesHead: "----- [llmwiki operating rules] this wiki is maintained by THIS session (warm, human-present — not an unattended cron) -----",
    rules: [
      "1) Use the cold-start above as direction. If the wiki helps answer something, Read the relevant page (read the index first).",
      renderRuleCategories("en", cfg),
      "3) Humans don't hand-write docs — the LLM summarizes, grounded in evidence, what the human decided/realized this session. Routine judgment (filing, grounding-check, confirming decisions/insights) the model makes directly as status: ready (no human sign-off) — but never fabricate ungrounded opinions/decisions; omit instead.",
      renderRuleHumanQueue("en", cfg),
      "4) Session end: if there was real work → close with /wiki-update (fast: file this session + L0 freshness + overview·lint). Periodic deep pass = /wiki-sync (backlog·review·gaps·re-distill). Warm human-present condensing is primary; the unattended scheduler is off.",
    ],
    indexHead: "----- [llmwiki index] recent pages in this repo's wiki (Read as needed) -----",
    spineHead: "----- [llmwiki synthesis] conceptual spine — most-referenced pages (the wiki's hubs; full view: llmwiki digest) -----",
    pending: (n: number) => `[llmwiki] ${n} un-updated session(s) in this repo → drain the backlog with the deep pass:  /wiki-sync`,
    quizDue: (n: number) => `[llmwiki quiz] ${n} review(s) due (day-granular forgetting curve) → reinforce YOUR memory with  /wiki-quiz`,
    l0Over: (n: number) =>
      `----- [llmwiki] L0 is ${n} chars — over the ~${L0_BUDGET}-char standard; injected whole (nothing cut). Trim back at /wiki-update -----`,
    gapBacklog: (n: number) =>
      `----- [llmwiki gap backlog] ${n} open fact gap(s) — LLM-owned bookkeeping; the next /wiki-sync fills them (no human action needed) -----`,
    behind: (n: number) =>
      `----- [llmwiki team] this wiki is ${n} commit(s) behind origin — a teammate may have merged context; consider \`git pull\` before starting -----`,
  },
  ko: {
    csDetail: (w: string) => `===== (상세: ${w}/ ${csPointer(cfg)}) =====`,
    ovDetail: (w: string) => `===== (상세: ${w}/) =====`,
    csHead: (n: string) => `===== [llmwiki] ${n} — docs/wiki/current-state (cold-start) =====`,
    ovHead: (n: string) => `===== [llmwiki] ${n} — docs/wiki/overview (cold-start) =====`,
    stale: "----- [llmwiki 최신성 주의] L0(현재상태)가 최근 기록보다 낡음 — 세션 마감 시 /wiki-update 로 갱신 권장 -----",
    rulesHead: "----- [llmwiki 운영 규칙] 이 위키는 '이 세션'이 유지한다 (사람 동석·웜 — 무인 cron 아님) -----",
    rules: [
      "1) 위 cold-start 를 방향 삼아 작업. 위키가 답에 도움되면 관련 페이지를 Read (read index first).",
      renderRuleCategories("ko", cfg),
      "3) 인간은 docs를 직접 쓰지 않는다. LLM이 '이 세션에서 인간이 결정·깨달은 것'을 근거 기반으로 요약 기록한다. 분류·근거검증·decision/insight 확정 같은 일상 판단은 강한 모델이 대신 내려 status: ready 로 확정한다(사람 확인 불필요) — 단 grounded 안 된 의견·결정은 지어내지 말고 기각.",
      renderRuleHumanQueue("ko", cfg),
      "4) 세션 마감: 실질 작업이 있었으면 → /wiki-update 로 닫는다 (fast: 이 세션 반영 + L0 신선도 + overview·lint). 주기 deep 패스 = /wiki-sync (백로그·리뷰·갭·재증류). 업데이트는 사람 동석 웜이 주력; 무인 스케줄러 비활성.",
    ],
    indexHead: "----- [llmwiki 인덱스] 이 레포 위키 최근 페이지 (필요 시 Read) -----",
    spineHead: "----- [llmwiki 종합] 개념 spine — 가장 많이 참조된 페이지(위키 허브; 전체: llmwiki digest) -----",
    pending: (n: number) => `[llmwiki] 이 레포 미update 세션 ${n}건 → deep 패스로 백로그 소진 권장:  /wiki-sync`,
    quizDue: (n: number) => `[llmwiki quiz] 복습 due ${n}건 (망각곡선·일 단위) → /wiki-quiz 로 '사람 기억' 강화`,
    l0Over: (n: number) =>
      `----- [llmwiki] L0 가 ${n}자 — 기준(~${L0_BUDGET}자) 초과; 전량 주입(자르지 않음). /wiki-update 에서 기준 이하로 트리밍 권장 -----`,
    gapBacklog: (n: number) =>
      `----- [llmwiki 갭 백로그] open ${n}건 — 사실 북키핑(LLM 소유), 다음 /wiki-sync 가 직접 채움 (사람 액션 불필요) -----`,
    behind: (n: number) =>
      `----- [llmwiki 팀] 이 위키가 origin보다 ${n}커밋 뒤 — 팀원이 병합한 맥락이 있을 수 있음, 시작 전 \`git pull\` 권장 -----`,
  },
  })[lang];

const reviewLlmNote = (cfg: WikiConfig) =>
  `  [LLM] Surface these to the user now. If a file's 'A.' has an answer, finalize its 'Draft' into the chosen N_category and delete the file; otherwise show its 'Q.' and ask. ${cfg.queueDir} should be empty when idle.`;

function base(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

function title(file: string): string {
  try {
    for (const ln of readFileSync(file, "utf-8").split("\n")) {
      const m = ln.match(/^title:\s*(.+)$/);
      if (m) return m[1]!.trim().replace(/^"|"$/g, "");
    }
  } catch {
    /* fail-safe: unreadable page → fall back to filename (mirrors the old hook's set +e) */
  }
  return base(file);
}

// Optional `owner:` frontmatter on a 0_review item — names WHOSE judgment is awaited, so on a
// shared team wiki each person can tell their questions from a teammate's. Absent → "".
function owner(file: string): string {
  try {
    for (const ln of readFileSync(file, "utf-8").split("\n")) {
      const m = ln.match(/^owner:\s*(.+)$/);
      if (m) return m[1]!.trim().replace(/^"|"$/g, "");
    }
  } catch {
    /* fail-safe */
  }
  return "";
}

// How many commits this repo is behind its upstream, using ONLY local refs (no network, no
// fetch — the answer is as fresh as the user's last fetch/pull). 0 on any failure: not a git
// repo, no upstream configured, git absent — the cold-start must never slow down or break.
function behindUpstream(repo: string): number {
  try {
    const r = spawnSync("git", ["-C", repo, "rev-list", "--count", "HEAD..@{upstream}"], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (r.status !== 0) return 0;
    const n = parseInt((r.stdout ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// category folders scanned for the page index + staleness (numbered + legacy), from the
// resolved per-repo config: log categories + topic + legacy flat names (scanDirs(cfg)).
function categoryPages(wiki: string, catDirs: string[]): string[] {
  const out: { p: string; m: number }[] = [];
  for (const c of catDirs) {
    const d = join(wiki, c);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith(".md")) continue;
      const p = join(d, f);
      try {
        out.push({ p, m: statSync(p).mtimeMs });
      } catch {
        /* fail-safe: skip unstattable entry */
      }
    }
  }
  out.sort((a, b) => b.m - a.m); // newest first
  return out.map((x) => x.p);
}

export function buildContext(repo: string): string {
  const proj = repo;
  const cfg = getConfig(proj); // per-repo conventions (configs/ → root file → defaults)
  const lang: "ko" | "en" = effectiveKo(cfg) ? "ko" : "en";
  const T = makeT(lang, cfg);
  const catDirs = scanDirs(cfg);
  const wiki = join(proj, "docs", "wiki");
  const cs = join(wiki, cfg.files.l0);
  const overview = join(wiki, cfg.files.overview);
  const rel = (p: string) => {
    // forward-slash-normalize so the repo-prefix strip works on Windows backslash paths too.
    const a = p.replace(/\\/g, "/");
    const b = proj.replace(/\\/g, "/");
    return a.startsWith(b + "/") ? a.slice(b.length + 1) : p;
  };
  const L: string[] = [];

  // (A) cold-start context: prefer current-state (L0), fall back to overview.
  if (existsSync(cs)) {
    L.push(T.csHead(base(proj)));
    L.push(l0OverNotice(readFileSync(cs, "utf-8").replace(/\n+$/, ""), T.l0Over));
    L.push(T.csDetail(wiki));
    L.push("");
  } else if (existsSync(overview)) {
    L.push(T.ovHead(base(proj)));
    L.push(l0OverNotice(readFileSync(overview, "utf-8").replace(/\n+$/, ""), T.l0Over));
    L.push(T.ovDetail(wiki));
    L.push("");
  }

  const hasWiki = existsSync(wiki);
  const l0 = existsSync(cs) ? cs : existsSync(overview) ? overview : "";

  // (A1) human-judgment queue — force-surface any 0_review/ items.
  // gap-queue.md and semantic-review-*.md are NOT human questions: they are the LLM's own managed
  // backlog/inputs (fact bookkeeping — /wiki-sync fills them). Counting them here made every
  // session open with a permanent "pending" nag, inverting the labor split (maintenance
  // is the model's job; the human only judges). The gap backlog gets one bounded line instead.
  const reviewDir = join(wiki, cfg.queueDir);
  if (existsSync(reviewDir)) {
    const files = readdirSync(reviewDir)
      .filter((f) => f.endsWith(".md") && f !== "gap-queue.md" && !/^semantic-review-/.test(f))
      .map((f) => join(reviewDir, f));
    if (files.length) {
      L.push(`===== [llmwiki] ${cfg.queueDir} pending ${files.length} — docs/wiki/${cfg.queueDir}/ =====`);
      for (const rf of files) {
        const o = owner(rf);
        L.push(`  - ${title(rf)}${o ? `  [→ ${o}]` : ""}  ->  ${rel(rf)}`);
      }
      L.push(reviewLlmNote(cfg));
      L.push("");
    }
    try {
      const gq = join(reviewDir, "gap-queue.md");
      if (existsSync(gq)) {
        const open = parseQueue(readFileSync(gq, "utf-8")).filter((g) => g.status === "open").length;
        if (open > 0) {
          L.push(T.gapBacklog(open));
          L.push("");
        }
      }
    } catch {
      /* fail-safe: the backlog line must never break cold-start */
    }
  }

  // (A1b) team continuity — one line when the wiki's repo is behind its upstream: a teammate
  // may have merged wiki context this session should start from. Local refs only (see
  // behindUpstream); silent for solo/no-remote/up-to-date setups.
  if (hasWiki) {
    const behind = behindUpstream(proj);
    if (behind > 0) {
      L.push(T.behind(behind));
      L.push("");
    }
  }

  // (A1c) config drift — one line when the wiki's structure or committed .schema-version
  // disagrees with this engine's config (team config changed, or MY engine clone is stale).
  // Detection only; migration is always an explicit `llmwiki migrate`. Fail-safe.
  if (hasWiki) {
    try {
      const drift = detectConfigDrift(proj, cfg);
      if (drift) {
        L.push(`----- [llmwiki config drift] ${drift} -----`);
        L.push("");
      }
    } catch {
      /* fail-safe: cold-start must never break on drift detection */
    }
  }

  // (A2) staleness — warn only if newest category page is newer than L0 (silent if fresh).
  if (l0) {
    const pages = categoryPages(wiki, catDirs);
    if (pages.length) {
      try {
        if (statSync(pages[0]!).mtimeMs > statSync(l0).mtimeMs) {
          L.push(T.stale);
          L.push("");
        }
      } catch {
        /* fail-safe */
      }
    }
  }

  // (B) operating rules — only in repos that have a wiki.
  if (hasWiki) {
    L.push(T.rulesHead);
    for (const r of T.rules) L.push(r);
    L.push("");
  }

  // (B2) lightweight on-the-fly page index — recent 6 titles (filesystem-derived, never stale).
  if (hasWiki) {
    const pages = categoryPages(wiki, catDirs).slice(0, 6);
    if (pages.length) {
      L.push(T.indexHead);
      for (const p of pages) L.push(`  • ${title(p)}  →  ${rel(p)}`);
      L.push("");
    }
  }

  // (B3) synthesis spine — the conceptual centers (most-referenced pages by in-degree, NOT just
  // recent). Deterministic/regenerable relational synthesis — no LLM, no
  // new claims, just links from the grounded graph. Bounded; failure-safe (never breaks cold-start).
  if (hasWiki) {
    const spine = buildSpine(proj);
    if (spine.length) {
      L.push(T.spineHead);
      for (const s of spine) L.push(s);
      L.push("");
    }
  }

  // (B4) topic-gap nudge — concepts that recur across log pages but have no 5_topic page yet.
  // One bounded line (top few tags) so each session sees what to consolidate next. Failure-safe.
  if (hasWiki) {
    try {
      const gaps = topicGaps(proj);
      if (gaps.length) {
        const top = gaps.slice(0, 5).map((g) => `${g.tag}(${g.pageCount})`).join(", ");
        L.push(
          lang === "ko"
            ? `----- [llmwiki 주제 갭] 주제 페이지 없는 재발 개념 ${gaps.length}건 → /wiki-sync 로 통합:  ${top} -----`
            : `----- [llmwiki topic-gap] ${gaps.length} recurring concept(s) without a topic page → /wiki-sync to consolidate:  ${top} -----`,
        );
        L.push("");
      }
    } catch {
      /* fail-safe: cold-start must never break on the gap nudge */
    }
  }

  // (C) pending-update notice (central capture queue, this repo's slice).
  // P0 "yesterday bridge": show WHAT the most recent un-condensed sessions were about, not
  // just how many — recap comes from artifacts the harness already wrote (ai-title /
  // last-prompt), read via the source's optional recapFor. Deterministic, 0 LLM, ≤3 lines.
  //
  // Honesty: count only GENUINELY UN-CITED sessions,
  // not raw pending(). A cited-but-partial session (byte_offset>0, tail deferred to autoupdate/deep)
  // and a cited session whose live transcript keeps growing both re-enter pending() but are already
  // represented in the wiki — nagging them makes the first impression lie and summons the human as a
  // verifier. uncitedPending() subtracts the cited set (reconcile's own citation scan).
  let pendRows: ReturnType<typeof pending> = [];
  try {
    pendRows = uncitedPending(proj);
  } catch {
    pendRows = [];
  }
  if (pendRows.length > 0) {
    L.push(T.pending(pendRows.length));
    try {
      // pending() is first_seen ASC → the last rows are the most recent sessions.
      for (const row of pendRows.slice(-3).reverse()) {
        const recap = sourceForKind(row.source_kind).recapFor?.(row.transcript_path);
        if (!recap) continue;
        let stamp = "";
        try {
          const d = new Date(statSync(row.transcript_path).mtimeMs);
          const p = (n: number) => String(n).padStart(2, "0");
          stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} `;
        } catch {
          /* stamp is decoration only */
        }
        L.push(`  • ${stamp}${recap}`);
      }
    } catch {
      /* fail-safe: recap must never break cold-start; the count line above still stands */
    }
  }

  // (C2) human memory loop — one bounded line when spaced-repetition reviews are due.
  // Ledger-only read (no page walk): cold-start must stay cheap; /wiki-quiz does the real scan.
  // Quiz CONTENT never enters this blob (the quiz layer is unindexed by design) — only the count.
  {
    const due = dueCount(proj);
    if (due > 0) L.push(T.quizDue(due));
  }

  // (D) one-line nudge if agent-config files (CLAUDE.md/AGENTS.md/MEMORY.md) carry discoverable bloat.
  // Bounded, advisory, never edits; silent when the files are absent or clean.
  if (hasWiki) {
    const nudge = auditNudge(proj);
    if (nudge) L.push(nudge);
  }

  return L.join("\n");
}
