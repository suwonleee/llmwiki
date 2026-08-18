// Deterministic wiki hygiene checks (the Lint operation).
//
// Checks: required frontmatter, footnote hygiene,
// citation resolution, citation-graph edges, dangling wiki links, orphan pages,
// uncited sources, stale pages.
import type { Database } from "bun:sqlite";
import { resolve as pathResolve, dirname as pathDirname } from "node:path";
import { existsSync } from "node:fs";
import { repoFileExists, repoRelative } from "./repo-write.ts";
import {
  buildLinkIndex,
  lookupKey,
  parseCitationFilename,
  parseWikiLinkTargets,
  resolveWikiLink,
  stripCode,
  stripEvidence,
  type LinkIndex,
} from "./refs.ts";
import { parseExcerpts, verifyExcerpt } from "./excerpt.ts";
import { hasSecret } from "./screen.ts";
import { L0_BUDGET, L0_LINT_BUDGET } from "./budgets.ts";
import { effectiveKo, getConfig, type WikiConfig } from "./config.ts";
import { parseFrontmatter as parseFrontmatterBoundary } from "./frontmatter.ts";

export function parseFrontmatter(content: string): Record<string, string | string[]> {
  const legacy: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(parseFrontmatterBoundary(content).fields)) {
    legacy[key] = typeof value === "string" ? value : [...value];
  }
  return legacy;
}

// NOTE: WikiIndex (./db.ts) is being ported in parallel. We declare a minimal
// structural interface here for the methods we call; once db.ts lands, that
// class will satisfy this shape. Methods take a bun:sqlite Database first arg.
export interface WikiIndexLike {
  root: string;
  listDocumentsWithContent(db: Database): WikiDoc[];
  findUncitedSources(db: Database): SourceRow[];
  findStalePages(db: Database): StaleRow[];
  getForwardReferences(db: Database, docId: string): ForwardRef[];
  getBacklinks(db: Database, docId: string): unknown[];
}

export interface WikiDoc {
  id: string | number;
  path: string;
  filename: string;
  relative_path: string;
  content?: string | null;
  source_kind?: string | null;
  title?: string | null;
  metadata?: string | null; // JSON; for a registered transcript holds { transcript_path, session_id }
}

export interface SourceRow {
  path: string;
  filename: string;
}

export interface StaleRow {
  path: string;
  filename: string;
  stale_since?: string | null;
}

export interface ForwardRef {
  id?: string | number;
  reference_type?: string;
}

export type Severity = "error" | "warn";

export interface LintIssue {
  severity: Severity;
  code: string;
  path: string;
  message: string;
}

const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
const FOOTNOTE_USE = /\[\^([^\]]+)\](?!:)/g;
const RAW_LINK_RE = /(?<!!)\[(?:[^\]]*)\]\(([^)]+)\)/g;

const SRC_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|html?|md|txt|jsonl)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MATCH_ALL = new Set(["*", "**", "**/*"]);
const MAX_PER_GROUP = 40;

// Topic pages accrete by design: merges add bullets and never rewrite existing lines
// (anti-drift), so a hot page grows linearly with the sessions that touch it — and every
// future merge must re-read all of it. Past this budget we surface advisory debt pointing
// at the sanctioned fix (re-distill from the page's cited transcripts; see the warn text).
// Env-overridable; floored so a typo'd env can't spam every topic page.
export const TOPIC_BUDGET = Math.max(
  2000,
  parseInt(process.env.LLMWIKI_TOPIC_BUDGET ?? "10000", 10) || 10000,
);

// Body-shape advisory thresholds. Deliberately generous: a page only gets nagged once it is long
// enough that a human genuinely needs grouping, or once one line has clearly swallowed a list.
// Structure-only counts, so they read the same for Korean, English, and Chinese prose.
const FLAT_BODY_BULLETS = 6; // top-level `-` lines with no `## N.` section — matches the written contract
// A crammed line is long AND multi-item. Separator count alone punishes the shape the contract
// actually wants — a child bullet holding a few short sibling tokens (`a` · `b` · `c` · `d` · `e`)
// is easier to scan than five more nested lines, and real pages are full of them.
const DENSE_BULLET_SEPARATORS = 4; // `·`-joined items inside a single bullet…
const DENSE_BULLET_MIN_CHARS = 100; // …and long enough that the line stops being scannable
const DENSE_BULLET_CHARS = 240; // or one bullet this long regardless of separators

function clamp(href: string, currentDir: string): string {
  if (href.startsWith("./")) {
    return currentDir ? currentDir + href.slice(2) : href.slice(2);
  }
  if (href.startsWith("../")) {
    const parts = (currentDir.replace(/\/+$/, "") + "/" + href).split("/");
    const rp: string[] = [];
    for (const p of parts) {
      if (p === "..") {
        if (rp.length) rp.pop();
      } else if (p && p !== ".") {
        rp.push(p);
      }
    }
    return rp.join("/");
  }
  if (!href.includes("/")) {
    return currentDir ? currentDir + href : href;
  }
  return href;
}

// Glob match minimal — mirrors Python fnmatch.fnmatch for the `_match` use case.
function fnmatch(name: string, pattern: string): boolean {
  // Translate fnmatch glob → regex: *, ?, [seq]
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      re += ".*";
      i++;
    } else if (c === "?") {
      re += ".";
      i++;
    } else if (c === "[") {
      const j = pattern.indexOf("]", i);
      if (j === -1) {
        re += "\\[";
        i++;
      } else {
        re += "[" + pattern.slice(i + 1, j) + "]";
        i = j + 1;
      }
    } else {
      re += c.replace(/[.+^${}()|\\\/]/g, "\\$&");
      i++;
    }
  }
  return new RegExp("^" + re + "$").test(name);
}

export class Linter {
  index: WikiIndexLike | null;
  conn: Database | null;
  cfg: WikiConfig;
  // Forbidden jargon — surfaced as warnings so wiki pages keep human-natural wording.
  // Advisory (warn only), so it never blocks the autoupdate gate (which fails on errors).
  banned: ReadonlyArray<readonly [string, string]>;
  // Lint warning messages adapt to LLMWIKI_LANG (default English, Korean when set).
  ko: boolean;
  // Pages injected at cold-start (whichever exists): current-state is the canonical L0; overview
  // is the fallback when there is no current-state. Both are subject to the L0 standard (F1:
  // over-standard notice at injection — never a cut), so both get the structural-trim warning
  // (F2) — no asymmetry between standard and signal.
  l0Pages: Set<string>;
  rootPages: Set<string>;
  ledgerPages: Set<string>;

  constructor(index: WikiIndexLike | null, conn: Database | null, cfg: WikiConfig = getConfig()) {
    this.index = index;
    this.conn = conn;
    this.cfg = cfg;
    this.banned = cfg.bannedTerms;
    this.ko = effectiveKo(cfg);
    const f = cfg.files;
    this.l0Pages = new Set([f.l0, f.overview]);
    // The destination `oversized-l0` sends detail to (context.ts/budgets.ts name it by this
    // spelling). Derived from the configured L0 so a renamed l0 keeps its satellite. It is the
    // SAME kind of page as the L0 — a curated state/backlog surface, not a claim-making content
    // page — so it inherits the root-page exemptions. Without this, following the engine's own
    // trim advice immediately earned a `no-citation` warning the source page was exempt from:
    // the advice loop marked its own outcome as a defect.
    // Deliberately NOT in l0Pages: the whole point is that this page is never injected, so a size
    // ceiling on it would defeat the trim it exists to absorb.
    const l0Detail = f.l0.replace(/\.md$/i, "-detail.md");
    this.rootPages = new Set([f.overview, "index.md", "readme.md", f.log, f.l0, l0Detail]);
    this.ledgerPages = new Set([f.log]);
  }

  run(path = "*", scope = "all"): [LintIssue[], number] {
    const idx = this.index!;
    const conn = this.conn!;
    // 0_review/ is the human-judgment queue (auto-quarantine + LLM-posed questions),
    // not a real wiki category — its files aren't finished pages, so skip them entirely.
    // The link index is built from EVERY document, including the queue: a page may legitimately
    // link into 0_review (the gap queue is linked from the pages it tracks), and the indexer
    // creates that edge. Lint must judge links against the same set or it would warn about links
    // that do resolve.
    const everyDoc = idx.listDocumentsWithContent(conn);
    const linkIndex = buildLinkIndex(everyDoc as any);
    const allDocs = everyDoc.filter((d) => !this._p(d).includes(`/${this.cfg.queueDir}/`));
    const wikiPages = allDocs.filter((d) => this._isWiki(d));
    const sourceLookup = this._sourceLookup(allDocs);
    const wikiLookup = this._wikiLookup(allDocs);

    let docs = allDocs;
    if (scope === "wiki") {
      docs = wikiPages;
    } else if (scope === "sources") {
      docs = allDocs.filter((d) => !this._isWiki(d));
    }
    docs = docs.filter((d) => this._match(this._p(d), path));

    const issues: LintIssue[] = [];
    for (const d of docs) {
      if (this._isWiki(d)) {
        issues.push(...this._lintPage(d, sourceLookup, wikiLookup, linkIndex, wikiPages.length));
      }
    }
    if (scope === "all" || scope === "sources") {
      for (const i of this._uncited()) if (this._match(i.path, path)) issues.push(i);
    }
    if (scope === "all" || scope === "wiki") {
      for (const i of this._stale()) if (this._match(i.path, path)) issues.push(i);
    }
    return [issues, docs.length];
  }

  // ---- per page ----
  _lintPage(
    doc: WikiDoc,
    sourceLookup: Record<string, WikiDoc>,
    wikiLookup: Record<string, WikiDoc>,
    linkIndex: LinkIndex,
    wikiCount: number,
  ): LintIssue[] {
    const path = this._p(doc);
    const content = doc.content || "";
    const issues: LintIssue[] = [];
    if (!this._isLedger(doc)) {
      issues.push(...this._frontmatter(doc, parseFrontmatterBoundary(content).fields));
      issues.push(...this._footnotes(path, content));
    }
    issues.push(...this._banned(path, content));
    issues.push(...this._citations(path, content, sourceLookup));
    issues.push(...this._excerpts(doc, content, sourceLookup));
    issues.push(...this._pageSecrets(doc, content));
    issues.push(...this._links(doc, content, wikiLookup, linkIndex));
    issues.push(...this._graph(doc, content, sourceLookup));
    issues.push(...this._orphan(doc, wikiCount));
    issues.push(...this._noCitation(doc, content));
    issues.push(...this._oversizedL0(doc, content));
    issues.push(...this._oversizedTopic(doc, content));
    issues.push(...this._bodyStructure(doc, content));
    return issues;
  }

  /**
   * Advisory shape checks for what a HUMAN scans: numbered sections over a flat wall of bullets,
   * and one point per line instead of an enumeration crammed behind separators.
   *
   * Both are warnings by design. The format is a writing contract, not a gate — but drift has to
   * be visible or the contract is only aspirational. Structure, never prose: the thresholds count
   * bullets and separators, so a Korean, English, or Chinese page is judged identically. Machine-
   * managed files (log, ledgers, L0/overview) are exempt — their shape is fixed elsewhere.
   */
  _bodyStructure(doc: WikiDoc, content: string): LintIssue[] {
    const path = this._p(doc);
    const name = doc.filename || path.split("/").pop() || "";
    if (this._isLedger(doc) || this.l0Pages.has(name) || name === this.cfg.files.log) return [];
    if (path.includes(`/${this.cfg.quizDir}/`)) return [];

    const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
    const lines = body.split("\n");
    const topLevel = lines.filter((line) => /^- \S/.test(line)).length;
    const hasNumberedSection = lines.some((line) => /^#{2,3} \d+(-\d+)*\. \S/.test(line));
    const issues: LintIssue[] = [];

    if (topLevel >= FLAT_BODY_BULLETS && !hasNumberedSection) {
      issues.push({
        severity: "warn",
        code: "flat-body",
        path,
        message: this.ko
          ? `본문이 최상위 불릿 ${topLevel}개의 평면 나열 — 사람이 훑을 수 있게 \`## 1. <제목>\` 번호 섹션으로 묶고(필요하면 \`### 1-1.\`), 각 섹션 안에서 \`-\` → \`    -\` → \`        -\` 계층으로 쓸 것`
          : `body is a flat run of ${topLevel} top-level bullets — group it under numbered sections (\`## 1. <label>\`, split as \`### 1-1.\` when needed) and keep the \`-\` → \`    -\` → \`        -\` hierarchy inside each`,
      });
    }

    for (const line of lines) {
      if (!/^\s*- \S/.test(line)) continue;
      const separators = (line.match(/·/g) ?? []).length;
      const crammed = separators >= DENSE_BULLET_SEPARATORS && line.length >= DENSE_BULLET_MIN_CHARS;
      if (!crammed && line.length <= DENSE_BULLET_CHARS) continue;
      issues.push({
        severity: "warn",
        code: "dense-bullet",
        path,
        message: this.ko
          ? `한 불릿에 열거가 뭉쳐 있음(구분자 ${separators}개, ${line.length}자) — 부모 한 줄 + 항목별 자식 불릿(\`    -\`)으로 펼칠 것: ${line.trim().slice(0, 60)}…`
          : `one bullet carries a whole enumeration (${separators} separators, ${line.length} chars) — expand it into a parent line plus one child bullet (\`    -\`) per item: ${line.trim().slice(0, 60)}…`,
      });
      break; // one advisory per page is enough to start the rework
    }
    return issues;
  }

  /** Advisory oversize check for the topic encyclopedia (5_topic). Warn only — oversize is
   * debt, never a gate-blocker. The fix it points at is the one the anti-drift rule allows:
   * rebuild the page FROM ITS CITED TRANSCRIPTS (raw re-grounding), never from other wiki
   * pages, keeping every citation — so compaction can't silently lose grounded claims. */
  _oversizedTopic(doc: WikiDoc, content: string): LintIssue[] {
    const path = this._p(doc);
    const dir = this.cfg.topicDir;
    if (!path.includes(`/${dir}/`) && !path.startsWith(`${dir}/`)) return [];
    // Measure PROSE, not evidence. This budget is a re-distill trigger whose only sanctioned fix
    // is compressing prose while keeping every citation — so counting v3 excerpts would fire it on
    // pages whose prose is fine, and make "cite less" the cheapest way to get under budget. In a
    // system whose entire value is provenance, that incentive points the wrong way.
    const prose = stripEvidence(content);
    if (prose.length <= TOPIC_BUDGET) return [];
    return [
      {
        severity: "warn",
        code: "topic-oversize",
        path,
        message: this.ko
          ? `주제 페이지 본문이 예산(${TOPIC_BUDGET}자)을 초과 (${prose.length}자, 근거 발췌 제외) — deep 패스에서 인용된 transcript들로부터 재증류 권장 (인용 세트 축소 금지·위키→위키 재유도 금지)`
          : `topic page prose is over budget (${prose.length} > ${TOPIC_BUDGET} chars, excluding evidence excerpts) — re-distill it from its cited transcripts in a deep pass (keep every citation; never rewrite from other wiki pages)`,
      },
    ];
  }

  // A cold-start page (current-state, or overview as fallback) is injected every
  // session, so unbounded growth is a per-session tax. Surface over-budget as advisory debt (the
  // overflow rides whole with a per-session over-standard notice — context.ts, never a cut).
  // Budget is characters, matching the page's own "~1000자" (~1,000 chars) contract.
  _oversizedL0(doc: WikiDoc, content: string): LintIssue[] {
    const path = this._p(doc);
    const name = doc.filename || path.split("/").pop() || "";
    if (!this.l0Pages.has(name)) return [];
    // overview is the injected cold-start page ONLY when there is no current-state (context.ts
    // prefers current-state). If current-state exists, overview isn't injected → not budget-bound,
    // so don't false-warn a legitimately rich index.
    if (
      name === "overview.md" &&
      this.index &&
      repoFileExists(this.index.root, "docs/wiki/current-state.md")
    ) {
      return [];
    }
    // Nag only past the SOFT ceiling (L0_LINT_BUDGET ≈ 1.25× the standard), not at the standard
    // itself: the injection never cuts (2026-07-12 no-cut principle) — an over-standard page
    // already rides whole with a per-session notice, so lint piles on only when meaningfully
    // bloated. This stops char-by-char trimming of a human-owned page (signal sacrificed to a number).
    if (content.length <= L0_LINT_BUDGET) return [];
    return [
      {
        severity: "warn",
        code: "oversized-l0",
        path,
        message: this.ko
          ? `${name} 가 기준(${L0_BUDGET}자)을 25% 이상 초과 (${content.length}자) — 주입은 자르지 않으므로(전량+초과 통지) 이 크기가 매 세션 비용. detail 페이지로 1회 구조 트림 권장 (글자 단위 추격 불필요)`
          : `${name} is >25% over the ${L0_BUDGET}-char standard at ${content.length} — injection never cuts (whole page + notice rides every cold-start), so this size is a per-session cost. Do ONE structural trim (move detail out); no char-by-char chasing`,
      },
    ];
  }

  _frontmatter(doc: WikiDoc, meta: Readonly<Record<string, string | readonly string[]>>): LintIssue[] {
    const path = this._p(doc);
    if (!meta || Object.keys(meta).length === 0) {
      return [
        { severity: "error", code: "missing-frontmatter", path, message: "wiki page has no YAML frontmatter" },
      ];
    }
    const out: LintIssue[] = [];
    const titleVal = meta["title"];
    if (!String(titleVal ?? "").trim()) {
      out.push({ severity: "error", code: "missing-title", path, message: "frontmatter missing `title`" });
    }
    const descVal = meta["description"];
    if (!String(descVal ?? "").trim()) {
      out.push({
        severity: "warn",
        code: "missing-description",
        path,
        message: "frontmatter missing `description`",
      });
    }
    const dateRaw = meta["date"] ?? meta["updated"] ?? "";
    if (!String(dateRaw).trim()) {
      out.push({
        severity: "warn",
        code: "missing-date",
        path,
        message: "frontmatter missing `date`/`updated`",
      });
    }
    const tags = meta["tags"];
    if (tags === undefined) {
      out.push({ severity: "warn", code: "missing-tags", path, message: "frontmatter missing `tags`" });
    } else if (Array.isArray(tags) && tags.length < 2) {
      out.push({
        severity: "warn",
        code: "too-few-tags",
        path,
        message: "frontmatter should include >=2 tags",
      });
    }
    // Honesty rules (P0-4, after pm-llm-wiki SCHEMA + semantica transaction-time):
    // a retired page must point at what replaced it — supersession without a pointer
    // silently orphans the successor and breaks "current belief = superseded_by absent".
    if (String(meta["status"] ?? "").trim() === "superseded" && !String(meta["superseded_by"] ?? "").trim()) {
      out.push({
        severity: "error",
        code: "superseded-missing-pointer",
        path,
        message: this.ko
          ? "`status: superseded`인데 `superseded_by`(대체 페이지 링크)가 없음 — 옛 결정은 지우지 말고 새 페이지로 연결"
          : "`status: superseded` without `superseded_by` — retired pages must link their replacement",
      });
    }
    // Numeric confidence is banned (evidence chains only) — a bare 0.85 hides its basis,
    // while a footnoted claim carries it. Frontmatter-key check only: language-invariant,
    // no per-language prose patterns to maintain.
    const conf = meta["confidence"];
    if (conf !== undefined && /^[\d.]+\s*%?$/.test(String(conf).trim())) {
      out.push({
        severity: "warn",
        code: "numeric-confidence",
        path,
        message: this.ko
          ? "숫자 confidence 금지 — 신뢰도는 각주 증거체인으로 표현 (evidence chains only)"
          : "numeric confidence scores are banned — express certainty via footnoted evidence chains",
      });
    }
    return out;
  }

  /** Flag human-unnatural jargon (Korean 진북/북극성 "north-star", or "distill") as advisory warnings.
   * Scans prose only (code spans stripped) so example/code refs are not flagged. */
  _banned(path: string, content: string): LintIssue[] {
    const body = stripCode(content);
    const out: LintIssue[] = [];
    for (const [term, suggestion] of this.banned) {
      // re.escape(term) → term is plain text; build a case-insensitive search.
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(escaped, "i").test(body)) {
        out.push({
          severity: "warn",
          code: "banned-term",
          path,
          message: this.ko
            ? `사람이 잘 안 쓰는 표현 \`${term}\` → \`${suggestion}\` 권장`
            : `unnatural jargon \`${term}\` → prefer \`${suggestion}\``,
        });
      }
    }
    return out;
  }

  _footnotes(path: string, content: string): LintIssue[] {
    const out: LintIssue[] = [];
    const defs: string[] = [];
    for (const m of content.matchAll(FOOTNOTE_DEF)) {
      defs.push(m[1]!);
    }
    const uses: string[] = [];
    for (const m of content.matchAll(FOOTNOTE_USE)) {
      uses.push(m[1]!);
    }
    const defSet = new Set(defs);
    const useSet = new Set(uses);
    const dupIds = new Set<string>();
    for (const f of defs) {
      if (defs.filter((x) => x === f).length > 1) dupIds.add(f);
    }
    for (const fid of [...dupIds].sort()) {
      out.push({
        severity: "error",
        code: "duplicate-footnote",
        path,
        message: `footnote \`^${fid}\` defined more than once`,
      });
    }
    const useMinusDef = [...useSet].filter((x) => !defSet.has(x)).sort();
    for (const fid of useMinusDef) {
      out.push({
        severity: "error",
        code: "footnote-without-definition",
        path,
        message: `footnote \`^${fid}\` used but not defined`,
      });
    }
    const defMinusUse = [...defSet].filter((x) => !useSet.has(x)).sort();
    for (const fid of defMinusUse) {
      out.push({
        severity: "warn",
        code: "unused-footnote-definition",
        path,
        message: `footnote \`^${fid}\` defined but not used`,
      });
    }
    return out;
  }

  _citations(path: string, content: string, sourceLookup: Record<string, WikiDoc>): LintIssue[] {
    const out: LintIssue[] = [];
    for (const m of content.matchAll(FOOTNOTE_DEF)) {
      const fid = m[1]!;
      const raw = m[2]!;
      const [filename] = parseCitationFilename(raw);
      if (!this._resolveSource(filename, sourceLookup)) {
        // NOTE (team wikis): a teammate's clean transcript citation (`<id>.jsonl`) never reaches
        // here — autoRegisterCitedTranscripts (refs.ts) self-heals it into a virtual source on
        // every index/refs rebuild, deliberately (transcripts rotate; a .jsonl citation is
        // unambiguously a transcript). What DOES land here: malformed citations (parenthetical
        // suffixes etc.) and missing non-transcript sources — both genuine author-side errors.
        out.push({
          severity: "error",
          code: "unresolved-citation",
          path,
          message: `footnote \`^${fid}\` cites \`${filename}\`, but no matching source exists`,
        });
      }
    }
    return out;
  }

  // ---- page-wide secret screen ---------------------------------------------------------------
  //
  // page-secret (error) — the prose-side twin of excerpt-secret. The excerpt path is hard-gated
  // at mint (screenSecrets) and re-checked below, but nothing stopped the author's own PROSE from
  // carrying a credential the session had in context — an env value pasted into a milestone, a
  // token inside a quoted command. Same screener, same severity: a wiki that commits to git is
  // clone-distributed, and a pushed credential cannot be recalled. Runs on every committed wiki
  // file, ledgers included; excerpt lines are skipped (excerpt-secret below already owns those,
  // and one finding per leak keeps the fix obvious). Placeholder examples (`API_KEY=<your-key>`)
  // pass — the screener recognizes documentation shapes, so config examples don't cost close-outs.
  _pageSecrets(doc: WikiDoc, content: string): LintIssue[] {
    if (!this._isWiki(doc)) return [];
    const path = this._p(doc);
    const out: LintIssue[] = [];
    const excerptLines = new Set(parseExcerpts(content).map((e) => e.line));
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (excerptLines.has(i + 1)) continue;
      if (!hasSecret(lines[i]!)) continue;
      out.push({
        severity: "error",
        code: "page-secret",
        path,
        message: this.ko
          ? `${i + 1}행에 비밀정보로 보이는 값이 있다 — 값을 지우고 서술로 바꿀 것 (한 번 푸시되면 되돌릴 수 없다; 긴 hex/base64 덩어리 포함, 커밋 해시는 짧은 형태로)`
          : `line ${i + 1} contains what looks like a secret — drop the value and describe it instead (a pushed secret cannot be recalled; long hex/base64 blobs count, shorten commit hashes)`,
      });
    }
    return out;
  }

  // ---- v3 evidence excerpts ------------------------------------------------------------------
  //
  // Three checks over the indented evidence lines under footnote definitions. All three are
  // deliberately quiet where they cannot be right:
  //   • excerpt-secret     (error) — always checkable, and a leak is unrecoverable once pushed.
  //   • unverified-excerpt (error) — only when the cited transcript is READABLE HERE. On a
  //     teammate's machine the transcript is absent, and "cannot check" must never read as
  //     "wrong" — that would make every shared page fail lint, the exact failure v3 prevents.
  //   • missing-excerpt    (warn)  — only when the transcript is readable, i.e. when someone can
  //     actually fill it. An old page whose transcript has rotated away would otherwise carry a
  //     warning nobody can ever resolve, which is how warnings become noise.
  _excerpts(doc: WikiDoc, content: string, sourceLookup: Record<string, WikiDoc>): LintIssue[] {
    if (!this._isWiki(doc) || this._isLedger(doc)) return [];
    const path = this._p(doc);
    const out: LintIssue[] = [];

    // footnote id → the transcript path it cites, when that file is readable on THIS machine
    const localTranscript = new Map<string, string>();
    const footnotes = new Set<string>();
    for (const m of content.matchAll(FOOTNOTE_DEF)) {
      const fid = m[1]!;
      footnotes.add(fid);
      const [filename] = parseCitationFilename(m[2]!);
      const src = this._resolveSource(filename, sourceLookup);
      if (!src?.metadata) continue;
      try {
        const p = JSON.parse(String(src.metadata))?.transcript_path;
        if (typeof p === "string" && p.includes("/") && existsSync(p)) localTranscript.set(fid, p);
      } catch {
        /* unparseable metadata → treat as "no local transcript" */
      }
    }

    const withExcerpt = new Set<string>();
    for (const ex of parseExcerpts(content)) {
      withExcerpt.add(ex.footnote);

      if (hasSecret(ex.text)) {
        out.push({
          severity: "error",
          code: "excerpt-secret",
          path,
          message: this.ko
            ? `${ex.line}행 근거 발췌에 비밀정보로 보이는 값이 있다 — 커밋 전에 제거할 것 (한 번 푸시되면 되돌릴 수 없다)`
            : `evidence excerpt on line ${ex.line} contains what looks like a secret — remove it before committing (a pushed secret cannot be recalled)`,
        });
      }

      const tp = localTranscript.get(ex.footnote);
      if (tp && verifyExcerpt(ex.text, tp) === false) {
        out.push({
          severity: "error",
          code: "unverified-excerpt",
          path,
          message: this.ko
            ? `${ex.line}행 발췌가 인용한 transcript에 없다 (\`^${ex.footnote}\`) — 원문 그대로 옮기거나 주장을 내릴 것`
            : `excerpt on line ${ex.line} does not appear in the transcript it cites (\`^${ex.footnote}\`) — quote it verbatim or drop the claim`,
        });
      }
    }

    // Judgment pages assert what a human decided and why; that is the class a teammate cannot
    // re-derive from code, so it is where portable evidence pays. Canonical domains only — a
    // custom config's domains simply don't trigger this, which is the safe direction to fail.
    const domain = String(parseFrontmatterBoundary(content).fields["domain"] ?? "");
    if (domain === "direction" || domain === "decision") {
      for (const fid of footnotes) {
        if (withExcerpt.has(fid) || !localTranscript.has(fid)) continue;
        out.push({
          severity: "warn",
          code: "missing-excerpt",
          path,
          message: this.ko
            ? `각주 \`^${fid}\`에 근거 발췌가 없다 — transcript가 아직 이 머신에 있으니 지금 채울 수 있다 (\`llmwiki excerpt\`)`
            : `footnote \`^${fid}\` carries no evidence excerpt — its transcript is still readable here, so it can be filled now (\`llmwiki excerpt\`)`,
        });
      }
    }

    return out;
  }

  _links(doc: WikiDoc, content: string, wikiLookup: Record<string, WikiDoc>, linkIndex: LinkIndex): LintIssue[] {
    const path = this._p(doc);
    let curDir = "";
    if (doc.path.includes("/docs/wiki/")) {
      curDir = doc.path.split("/docs/wiki/")[1] ?? "";
    }
    const root = this.index!.root;
    const pageDir = pathResolve(root, pathDirname(doc.relative_path));
    const out: LintIssue[] = [];
    for (const m of stripCode(content).matchAll(RAW_LINK_RE)) {
      const href = m[1]!;
      if (
        href.startsWith("http") ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("data:")
      ) {
        continue;
      }
      if (IMG_EXT.test(href)) continue;
      const bare = href.split("#")[0]!;
      const target = pathResolve(pageDir, bare);
      if (target.startsWith(root)) {
        try {
          if (repoFileExists(root, repoRelative(root, target))) continue;
        } catch {
          // outside/root paths are unresolved links
        }
      }
      if (this._resolveLink(clamp(bare, curDir), wikiLookup)) continue;
      out.push({
        severity: "error",
        code: "dangling-link",
        path,
        message: `wiki link \`${href}\` does not resolve`,
      });
    }
    // [[wikilink]] targets. The loop above only sees markdown links, so until now the wiki's
    // PRIMARY linking idiom was the one nobody checked: a [[...]] pointing at nothing produced no
    // edge, no warning, and an orphaned page — invisible rot.
    //
    // Advisory, unlike the error above: pages deliberately link forward to work not written yet
    // (the gap queue is built on exactly that), and an intention must never block a close-out.
    for (const target of parseWikiLinkTargets(content)) {
      if (resolveWikiLink(target, linkIndex)) continue;
      out.push({
        severity: "warn",
        code: "dangling-wikilink",
        path,
        message: this.ko
          ? `\`[[${target}]]\` 가 아무 페이지도 가리키지 않는다 — 대상을 만들거나 링크를 고칠 것 (아직 쓰지 않은 페이지를 가리키는 것이면 그대로 둬도 된다)`
          : `\`[[${target}]]\` points at no page — create the target or fix the link (leave it if it names a page you have yet to write)`,
      });
    }
    return out;
  }

  _graph(doc: WikiDoc, content: string, sourceLookup: Record<string, WikiDoc>): LintIssue[] {
    const path = this._p(doc);
    const expected = new Set<string>();
    for (const m of content.matchAll(FOOTNOTE_DEF)) {
      const raw = m[2]!;
      const [filename] = parseCitationFilename(raw);
      const t = this._resolveSource(filename, sourceLookup);
      if (t && String(t.id) !== String(doc.id)) expected.add(String(t.id));
    }
    if (expected.size === 0) return [];
    const forward = this.index!.getForwardReferences(this.conn!, String(doc.id));
    const actual = new Set<string>();
    for (const r of forward) {
      if (r.reference_type === "cites" && r.id !== undefined && r.id !== null) {
        actual.add(String(r.id));
      }
    }
    const missing = [...expected].filter((x) => !actual.has(x));
    if (missing.length === 0) return [];
    return [
      {
        severity: "error",
        code: "citation-graph-mismatch",
        path,
        message: "citation footnotes not materialized into graph edges (run index)",
      },
    ];
  }

  _orphan(doc: WikiDoc, wikiCount: number): LintIssue[] {
    if (this.rootPages.has(doc.filename.toLowerCase()) || wikiCount <= 1) return [];
    const backlinks = this.index!.getBacklinks(this.conn!, String(doc.id));
    if (backlinks && backlinks.length > 0) return [];
    return [
      {
        severity: "warn",
        code: "orphan-page",
        path: this._p(doc),
        message: "wiki page has no incoming links or citations",
      },
    ];
  }

  /** Cheap deterministic flag: a content page with ZERO footnote citations. Advisory
   * (warn), never an error — the grounding rule wants claims cited, but whether an
   * uncited page is actually a problem is a judgment call left to the Opus `review`
   * pass. Root/ledger/README pages are exempt (they make no fact claims).
   * 0_review pages are already filtered out before linting. */
  _noCitation(doc: WikiDoc, content: string): LintIssue[] {
    if (this.rootPages.has(doc.filename.toLowerCase()) || this._isLedger(doc)) return [];
    const defs = content.match(FOOTNOTE_DEF);
    if (defs && defs.length > 0) return [];
    return [
      {
        severity: "warn",
        code: "no-citation",
        path: this._p(doc),
        message: "page has no footnote citations — fact/judgment claims should cite a source (or run `review` for adjudication)",
      },
    ];
  }

  // ---- kb wide ----
  _uncited(): LintIssue[] {
    const rows = this.index!.findUncitedSources(this.conn!);
    return rows.map((r) => ({
      severity: "warn" as const,
      code: "uncited-source",
      path: `${r.path}${r.filename}`,
      message: "source not cited by any wiki page",
    }));
  }

  _stale(): LintIssue[] {
    const rows = this.index!.findStalePages(this.conn!);
    return rows.map((r) => ({
      severity: "warn" as const,
      code: "stale-page",
      path: `${r.path}${r.filename}`,
      message: `page stale since ${r.stale_since || "?"}`,
    }));
  }

  // ---- helpers ----
  _sourceLookup(docs: WikiDoc[]): Record<string, WikiDoc> {
    const out: Record<string, WikiDoc> = {};
    for (const d of docs) {
      if (this._isWiki(d)) continue;
      const fn = lookupKey(d.filename);
      if (!(fn in out)) out[fn] = d;
      const stripped = fn.replace(SRC_EXT, "");
      if (!(stripped in out)) out[stripped] = d;
      const rp = lookupKey(d.relative_path || "");
      if (rp && !(rp in out)) out[rp] = d;
      if (d.title) {
        const tk = lookupKey(d.title);
        if (!(tk in out)) out[tk] = d;
      }
    }
    return out;
  }

  _wikiLookup(docs: WikiDoc[]): Record<string, WikiDoc> {
    const out: Record<string, WikiDoc> = {};
    for (const d of docs) {
      if (!this._isWiki(d)) continue;
      const parts = d.relative_path.split("docs/wiki/");
      const rel = lookupKey(parts.length > 1 ? parts[parts.length - 1]! : parts[0]!);
      out[rel] = d;
      const fn = lookupKey(d.filename);
      if (!(fn in out)) out[fn] = d;
    }
    return out;
  }

  _resolveSource(filename: string, lookup: Record<string, WikiDoc>): WikiDoc | undefined {
    const k = lookupKey(filename.trim());
    return lookup[k] || lookup[k.replace(SRC_EXT, "")];
  }

  _resolveLink(link: string, lookup: Record<string, WikiDoc>): WikiDoc | undefined {
    const k = lookupKey(link.split("#")[0]!);
    const tail = k.split("/").pop() || "";
    return lookup[k] || lookup[k + ".md"] || lookup[tail];
  }

  _isWiki(doc: WikiDoc): boolean {
    return (doc.relative_path || "").includes("docs/wiki/") || doc.source_kind === "wiki";
  }

  _isLedger(doc: WikiDoc): boolean {
    return this.ledgerPages.has(lookupKey(doc.filename));
  }

  _p(doc: WikiDoc): string {
    return `${doc.path}${doc.filename}`;
  }

  _match(docPath: string, path: string): boolean {
    if (MATCH_ALL.has(path)) return true;
    const pat = path.startsWith("/") ? path : "/" + path;
    return fnmatch(docPath, pat) || fnmatch(docPath, "*" + path);
  }
}

export function formatReport(
  issues: LintIssue[],
  checked: number,
  name: string,
  opts: { errorsOnly?: boolean } = {},
): string {
  if (issues.length === 0) {
    return `✅ Lint passed for ${name} (${checked} document(s) checked).`;
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warns = issues.filter((i) => i.severity === "warn");
  const lines: string[] = [
    `Lint found ${issues.length} issue(s) in ${name} ` +
      `(${errors.length} error, ${warns.length} warning; ${checked} doc(s) checked).`,
  ];
  // --errors-only: errors in full, warnings collapsed to per-code counts. Warnings are
  // advisory debt a close-out only needs the SHAPE of — dumping the full list into a warm
  // session's context every sync is a growing per-sync tax (measured: 146 lines). Nothing is
  // lost: the counts keep the debt visible and the plain run still prints every line.
  const groups: ReadonlyArray<readonly [string, LintIssue[]]> = opts.errorsOnly
    ? [["Errors", errors]]
    : [
        ["Errors", errors],
        ["Warnings", warns],
      ];
  for (const [label, group] of groups) {
    if (group.length === 0) continue;
    lines.push(`\n**${label}**`);
    for (const i of group.slice(0, MAX_PER_GROUP)) {
      lines.push(`- [${i.code}] \`${i.path}\` — ${i.message}`);
    }
    if (group.length > MAX_PER_GROUP) {
      lines.push(`- ... ${group.length - MAX_PER_GROUP} more`);
    }
  }
  if (opts.errorsOnly && warns.length > 0) {
    const byCode = new Map<string, number>();
    for (const w of warns) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
    const summary = [...byCode.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([code, n]) => `${code} ${n}`)
      .join(" · ");
    lines.push(`\nWarnings (advisory, collapsed): ${summary} — full list without --errors-only.`);
  }
  return lines.join("\n");
}
