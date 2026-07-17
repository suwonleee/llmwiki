// Deterministic synthesis (the safe revival of the removed generative `synthesize`).
//
// Decision 16 disabled UNATTENDED synthesis to avoid model-collapse (an LLM re-summarizing
// its own summaries, drifting from ground truth). But that conflated two things:
//   1. mechanical/relational synthesis — cross-references, hubs, supersession/freshness,
//      open contradictions. Pure bookkeeping over ALREADY-grounded pages.
//   2. interpretive synthesis — "what does it all mean", an evolving thesis. Judgment.
//
// (1) is "the synthesis already reflects everything" AND the near-zero
// maintenance burden that keeps a wiki alive — and it carries NO collapse risk when it only
// ASSEMBLES links/flags from the grounded citation graph (no new prose, no wiki→wiki
// re-derivation). This module delivers (1): a bounded, regenerable relational digest built
// deterministically from the index (zero LLM calls). (2) stays human/warm (wiki-deep L0,
// wiki-ask) and is intentionally NOT produced here.
//
// The output is a DERIVED VIEW (like the index/refs graph), never a committed wiki page —
// so it is always rebuildable and can never accumulate error.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { WikiIndex } from "./db.ts";
import { effectiveKo, getConfig, logDirs, type WikiConfig } from "./config.ts";

// User-facing output adapts to LLMWIKI_LANG (default English, Korean when set) — same policy as
// the cold-start context builder. (The LLM-facing prompts stay English elsewhere by design.)
// Language + category/topic dirs resolve per repo at call time (per-repo config).
const T = {
  en: {
    head: (n: string) => `===== [llmwiki] ${n} — synthesis (auto·regenerable, LLM-0) =====`,
    note: "> Derived view assembled deterministically from the citation graph — links · hubs · freshness only, no new claims, rebuild anytime. (Interpretive synthesis stays human/warm.)",
    empty: "\nNo category pages yet — start condensing with /wiki-fast.",
    cat: {
      "1_direction": "Direction",
      "2_milestone": "Milestone",
      "3_decision": "Decision",
      "4_insight": "Insight",
    } as Record<string, string>,
    hubs: "## Key hubs (most-referenced)",
    inbound: (n: number) => `${n} inbound`,
    stale: "## Freshness (a linked source changed — review at the next /wiki-deep)",
    open: "## Open items (0_review — awaiting human confirmation)",
  },
  ko: {
    head: (n: string) => `===== [llmwiki] ${n} — synthesis (auto·재생성, LLM-0) =====`,
    note: "> 인용 그래프에서 결정적으로 조립한 파생 뷰 — 링크·허브·신선도만, 새 주장 0. 언제든 재생성. (해석적 종합은 사람·웜 영역)",
    empty: "\n아직 카테고리 페이지가 없음 — /wiki-fast 로 업데이트를 시작하세요.",
    cat: {
      "1_direction": "방향성 (direction)",
      "2_milestone": "마일스톤 (milestone)",
      "3_decision": "결정 (decision)",
      "4_insight": "통찰 (insight)",
    } as Record<string, string>,
    hubs: "## 핵심 허브 (가장 많이 참조됨)",
    inbound: (n: number) => `${n} inbound`,
    stale: "## 신선도 주의 (연결된 소스가 갱신됨 — 다음 /wiki-deep 때 검토)",
    open: "## 열린 항목 (0_review — 사람 확정 대기)",
  },
};

function catOf(rel: string, cats: string[]): string | null {
  for (const c of cats) if (rel.includes(`docs/wiki/${c}/`)) return c;
  return null;
}

function titleOf(d: any): string {
  const t = String(d.title ?? "").trim();
  if (t) return t;
  return String(d.filename ?? "").replace(/\.md$/, "");
}

// docs/wiki/0_review/*.md titles (the human-judgment queue) read straight from disk —
// these never become content pages, so they aren't in the category lists above.
// gap-queue.md / semantic-review-*.md are the LLM's own managed backlog (fact bookkeeping,
// filled at /wiki-deep), not human questions — excluded so the count matches cold-start's.
function openReviewItems(repo: string): string[] {
  const dir = join(repo, "docs", "wiki", getConfig(repo).queueDir);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "gap-queue.md" && !/^semantic-review-/.test(f))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

interface Analysis {
  pages: any[]; // category pages only
  indeg: Map<string, number>; // doc id → inbound reference count (hub signal)
  open: string[]; // 0_review titles
}

// Shared deterministic read of the grounded graph (no LLM). Used by both the full digest and
// the compact cold-start spine, so they never diverge.
function analyze(repo: string, cfg: WikiConfig = getConfig(repo)): Analysis {
  const cats = logDirs(cfg);
  const w = new WikiIndex(repo);
  const db = w.connect();
  const pages = w.listDocumentsWithContent(db).filter((d) => catOf(String(d.relative_path), cats));
  const indeg = new Map<string, number>();
  for (const d of pages) indeg.set(String(d.id), w.getBacklinks(db, String(d.id)).length);
  db.close();
  return { pages, indeg, open: openReviewItems(repo) };
}

// Compact synthesis spine for the cold-start read loop: the conceptual centers (top hubs by
// in-degree — distinct from "recent pages") + a one-line freshness/open summary. Bounded to a
// handful of lines so it never bloats cold-start. Returns content lines (no header).
export function buildSpine(repo: string, max = 4): string[] {
  let a: Analysis;
  let cfg: WikiConfig;
  try {
    cfg = getConfig(repo);
    a = analyze(repo, cfg);
  } catch {
    return []; // cold-start must never break on a digest failure
  }
  if (!a.pages.length) return [];
  const out: string[] = [];
  const hubs = a.pages
    .map((d) => ({ d, n: a.indeg.get(String(d.id)) ?? 0 }))
    .filter((x) => x.n >= 2)
    .sort((x, y) => y.n - x.n)
    .slice(0, max);
  for (const { d, n } of hubs) out.push(`  • ${titleOf(d)}  →  ${d.relative_path}  (${n}x)`);
  const staleN = a.pages.filter((d) => d.stale_since).length;
  if (staleN || a.open.length) {
    out.push(`  (freshness: ${staleN} stale · ${cfg.queueDir}: ${a.open.length} open)`);
  }
  return out;
}

export interface DigestOptions {
  maxPerDomain?: number; // cap pages listed per category (keeps output bounded at any wiki size)
  maxHubs?: number;
  maxStale?: number;
}

// Build the relational digest as bounded markdown. Deterministic: same index → same output.
export function buildDigest(repo: string, opts: DigestOptions = {}): string {
  const maxPer = opts.maxPerDomain ?? 6;
  const maxHubs = opts.maxHubs ?? 8;
  const maxStale = opts.maxStale ?? 8;

  const cfg = getConfig(repo);
  const cats = logDirs(cfg);
  const lang: "ko" | "en" = effectiveKo(cfg) ? "ko" : "en";
  const t = T[lang];
  const { pages, indeg, open } = analyze(repo, cfg);

  const name = resolve(repo).split("/").filter(Boolean).pop() || repo; // resolve: a relative "." must render as the repo name, not "."
  const L: string[] = [];
  L.push(t.head(name));
  L.push(t.note);

  if (!pages.length) {
    L.push(t.empty);
    return L.join("\n");
  }

  // by category, sorted by hub-degree then date desc
  for (const c of cats) {
    const group = pages
      .filter((d) => catOf(String(d.relative_path), cats) === c)
      .sort(
        (a, b) =>
          (indeg.get(String(b.id)) ?? 0) - (indeg.get(String(a.id)) ?? 0) ||
          String(b.date ?? "").localeCompare(String(a.date ?? "")),
      );
    if (!group.length) continue;
    L.push(`\n## ${t.cat[c] ?? c} — ${group.length}`); // custom-config categories fall back to the dir name
    for (const d of group.slice(0, maxPer)) {
      const deg = indeg.get(String(d.id)) ?? 0;
      const flags = [deg >= 2 ? `★${deg}` : "", d.stale_since ? (lang === "ko" ? "⚠신선도" : "⚠stale") : ""].filter(Boolean).join(" ");
      L.push(`- [${titleOf(d)}](${d.relative_path})${flags ? " " + flags : ""}`);
    }
    if (group.length > maxPer) L.push(`- (+${group.length - maxPer} more)`);
  }

  // hubs across all domains (the spine of the wiki)
  const hubs = [...pages]
    .map((d) => ({ d, n: indeg.get(String(d.id)) ?? 0 }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, maxHubs);
  if (hubs.length) {
    L.push(`\n${t.hubs}`);
    for (const { d, n } of hubs) L.push(`- [${titleOf(d)}](${d.relative_path}) — ${t.inbound(n)}`);
  }

  // freshness: pages whose linked source changed → may need a refresh pass (supersession signal)
  const stale = pages.filter((d) => d.stale_since).slice(0, maxStale);
  if (stale.length) {
    L.push(`\n${t.stale}`);
    for (const d of stale) L.push(`- [${titleOf(d)}](${d.relative_path}) (since ${String(d.stale_since).slice(0, 10)})`);
  }

  // open human-judgment items (direction/contradiction confirmation)
  if (open.length) {
    L.push(`\n${t.open}`);
    for (const t of open) L.push(`- ${t}`);
  }

  return L.join("\n");
}

// ---- topic view (Phase-0 of the topic encyclopedia: deterministic, LLM-0) --------------
//
// The materialized topic pages (5_topic/) are merged by consolidate.ts (a generative pass).
// This is the SAFE precursor: a regenerable, LLM-free view of the topic layer's *shape* —
// (a) the materialized 5_topic pages with their in-degree, and (b) emergent topic clusters
// derived purely from shared `tags` across the log pages. No new claims, no merge, no drift —
// just the relational grouping already implied by the grounded pages. Useful to eyeball which
// concepts recur (= consolidation candidates) before any generative merge exists.
// Rendered per resolved config (per-repo) — the topic dir name is interpolated, so the stock
// config reproduces the historical "5_topic" prose byte-identically.
const makeT2 = (lang: "ko" | "en", cfg: WikiConfig) =>
  ({
    en: {
      head: (n: string) => `===== [llmwiki] ${n} — topic view (auto·regenerable, LLM-0) =====`,
      note: `> Deterministic view of the topic layer — materialized ${cfg.topicDir} pages + emergent clusters by shared tag. No new claims; rebuild anytime. (Generative topic merge is /wiki-fast·/wiki-deep.)`,
      empty: "\nNo topic pages or taggable wiki pages yet — consolidate with /wiki-fast.",
      materialized: `## Topic pages (${cfg.topicDir} — most-referenced first)`,
      clusters: "## Emergent clusters (pages sharing a tag — consolidation candidates)",
      inbound: (n: number) => `${n} inbound`,
      gapMark: "  ◇ no topic page yet",
      gapSummary: (n: number) => `→ ${n} recurring concept(s) have no topic page yet — /wiki-deep to consolidate.`,
    },
    ko: {
      head: (n: string) => `===== [llmwiki] ${n} — 주제 뷰 (auto·재생성, LLM-0) =====`,
      note: `> 주제층의 결정적 뷰 — 실체화된 ${cfg.topicDir} 페이지 + 공유 태그로 묶인 잠재 클러스터. 새 주장 0, 언제든 재생성. (생성형 주제 병합은 /wiki-fast·/wiki-deep.)`,
      empty: "\n아직 주제 페이지나 태그된 위키 페이지가 없음 — /wiki-fast 로 통합하세요.",
      materialized: `## 주제 페이지 (${cfg.topicDir} — 참조 많은 순)`,
      clusters: "## 잠재 클러스터 (같은 태그를 공유하는 페이지 — 통합 후보)",
      inbound: (n: number) => `${n} inbound`,
      gapMark: "  ◇ 주제 페이지 없음",
      gapSummary: (n: number) => `→ 재발 개념 ${n}건이 주제 페이지 없음 — /wiki-deep 로 통합 권장.`,
    },
  })[lang];

// Tags too generic to signal a real topic cluster (frontmatter scaffolding + category labels,
// not concepts). The numbered-category words (milestone/decision/insight/direction) are the
// page's domain, not a topic — excluding them stops the whole category showing as one "cluster".
const _STOP_TAGS = new Set([
  "meta", "topic", "overview", "log", "l0", "current-state", "index", "draft", "ready",
  "milestone", "decision", "insight", "direction",
]);

// Parse `tags` straight from a page's YAML frontmatter. The index stores tags as '[]'
// (db.ts doesn't extract frontmatter), so cluster the topic view on the page body itself —
// markdown is the source of truth anyway. Handles both inline (`tags: [a, b]`) and block
// (`tags:\n  - a\n  - b`) forms; only looks inside the leading `---` frontmatter block.
function parseTags(content: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  const fm = end === -1 ? content : content.slice(0, end);
  const lines = fm.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^tags:\s*(.*)$/);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (inline.startsWith("[")) {
      for (const t of inline.replace(/^\[|\]$/g, "").split(",")) {
        const v = t.trim().replace(/^['"]|['"]$/g, "");
        if (v) out.push(v);
      }
    } else {
      // block form: subsequent `  - value` lines
      for (let j = i + 1; j < lines.length; j++) {
        const bm = lines[j]!.match(/^\s*-\s*(.+)$/);
        if (!bm) break;
        const v = bm[1]!.trim().replace(/^['"]|['"]$/g, "");
        if (v) out.push(v);
      }
    }
    break;
  }
  return out;
}

export interface TopicViewOptions {
  maxClusters?: number;
  maxPerCluster?: number;
  maxTopics?: number;
}

export function buildTopicView(repo: string, opts: TopicViewOptions = {}): string {
  const maxClusters = opts.maxClusters ?? 12;
  const maxPer = opts.maxPerCluster ?? 8;
  const maxTopics = opts.maxTopics ?? 20;

  const cfg = getConfig(repo);
  const t2 = makeT2(effectiveKo(cfg) ? "ko" : "en", cfg);
  const name = resolve(repo).split("/").filter(Boolean).pop() || repo; // resolve: a relative "." must render as the repo name, not "."
  const L: string[] = [t2.head(name), t2.note];

  let w: WikiIndex;
  let pages: any[];
  let indeg = new Map<string, number>();
  try {
    w = new WikiIndex(repo);
    const db = w.connect();
    const all = w
      .listDocumentsWithContent(db)
      .filter(
        (d) =>
          String(d.source_kind) === "wiki" &&
          String(d.relative_path).includes("docs/wiki/") &&
          !/(overview|current-state|log|index)\.md$/.test(String(d.relative_path)),
      );
    pages = all;
    for (const d of all) {
      if (String(d.relative_path).includes(`docs/wiki/${cfg.topicDir}/`)) {
        indeg.set(String(d.id), w.getBacklinks(db, String(d.id)).length);
      }
    }
    db.close();
  } catch {
    L.push(t2.empty);
    return L.join("\n");
  }

  if (!pages.length) {
    L.push(t2.empty);
    return L.join("\n");
  }

  // (a) materialized topic pages, most-referenced first
  const topicPages = pages
    .filter((d) => String(d.relative_path).includes(`docs/wiki/${cfg.topicDir}/`))
    .map((d) => ({ d, n: indeg.get(String(d.id)) ?? 0 }))
    .sort((a, b) => b.n - a.n || String(b.d.date ?? "").localeCompare(String(a.d.date ?? "")))
    .slice(0, maxTopics);
  if (topicPages.length) {
    L.push(`\n${t2.materialized}`);
    for (const { d, n } of topicPages) {
      L.push(`- [${titleOf(d)}](${d.relative_path})${n >= 2 ? ` — ${t2.inbound(n)}` : ""}`);
    }
  }

  // (b) emergent clusters from shared tags across ALL wiki pages (the consolidation signal).
  // `covered` = tags that already have a materialized 5_topic page; a cluster whose tag is NOT
  // covered is a GAP — a concept that recurs across log pages but has no living topic page yet,
  // i.e. the next thing /wiki-deep should consolidate. Deterministic, no LLM.
  const covered = new Set<string>();
  const byTag = new Map<string, { title: string; rel: string }[]>();
  for (const d of pages) {
    const isTopic = String(d.relative_path).includes(`docs/wiki/${cfg.topicDir}/`);
    for (const raw of parseTags(String(d.content || ""))) {
      const key = String(raw).toLowerCase().trim();
      if (!key || _STOP_TAGS.has(key)) continue;
      if (isTopic) covered.add(key);
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push({ title: titleOf(d), rel: String(d.relative_path) });
    }
  }
  const clusters = [...byTag.entries()]
    .filter(([, ps]) => ps.length >= 2) // a cluster needs ≥2 pages to be a topic
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, maxClusters);
  if (clusters.length) {
    L.push(`\n${t2.clusters}`);
    for (const [tag, ps] of clusters) {
      const gap = !covered.has(tag); // no 5_topic page carries this tag yet
      L.push(`\n**${tag}** — ${ps.length}${gap ? t2.gapMark : ""}`);
      for (const p of ps.slice(0, maxPer)) L.push(`- [${p.title}](${p.rel})`);
      if (ps.length > maxPer) L.push(`- (+${ps.length - maxPer} more)`);
    }
    const gaps = clusters.filter(([tag]) => !covered.has(tag)).length;
    if (gaps) L.push(`\n${t2.gapSummary(gaps)}`);
  }

  if (!topicPages.length && !clusters.length) L.push(t2.empty);
  return L.join("\n");
}

// Topic gaps (deterministic, LLM-0): concepts that recur across ≥2 log pages but have NO
// 5_topic page yet — the actionable "what to consolidate next" list. Shared by the cold-start
// nudge and any caller; failure-safe (returns [] on any error so cold-start never breaks).
export function topicGaps(repo: string): { tag: string; pageCount: number }[] {
  try {
    const cfg = getConfig(repo);
    const w = new WikiIndex(repo);
    const db = w.connect();
    const all = w
      .listDocumentsWithContent(db)
      .filter(
        (d) =>
          String(d.source_kind) === "wiki" &&
          String(d.relative_path).includes("docs/wiki/") &&
          !/(overview|current-state|log|index)\.md$/.test(String(d.relative_path)),
      );
    db.close();
    const covered = new Set<string>();
    const counts = new Map<string, number>();
    for (const d of all) {
      const isTopic = String(d.relative_path).includes(`docs/wiki/${cfg.topicDir}/`);
      for (const raw of parseTags(String(d.content || ""))) {
        const key = String(raw).toLowerCase().trim();
        if (!key || _STOP_TAGS.has(key)) continue;
        if (isTopic) covered.add(key);
        else counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .filter(([tag, n]) => n >= 2 && !covered.has(tag))
      .map(([tag, pageCount]) => ({ tag, pageCount }))
      .sort((a, b) => b.pageCount - a.pageCount);
  } catch {
    return [];
  }
}
