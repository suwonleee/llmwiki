// Team wiki conventions — single source of truth, declared in <clone>/llmwiki.config.toml.
//
// The schema layer (directory structure, schema conventions, page formats — all
// domain-dependent, co-evolved) made machine-readable so lint/migrate/prompts can be
// DRIVEN by it instead of hardcoding conventions in six modules. Design rules:
//   • zero-config: no file → built-in defaults = the current structure, byte-identical
//     behavior (sage-wiki Defaults() pattern). The config is override-only.
//   • single truth: prose (prompts, cold-start rules, WIKI_SCHEMA tables, skills) must be
//     RENDERED from this config, never duplicated (junbjnnn's toml+AGENTS.md dual-truth is
//     the measured anti-pattern).
//   • declaring any [[category]] REPLACES the default list entirely (most-specific-wins,
//     ilya-epifanov pattern) — partial merges of ordered lists are unpredictable.
//   • fail-safe: an unreadable/invalid file falls back to defaults and carries `error` so
//     CLI `config`/doctor can surface it — a broken config must never break a session hook.
// Engine-internal artifacts (gap-queue.md, semantic-review-*, .llmwiki/) are NOT
// configurable — they are implementation details, not team conventions.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CLONE_ROOT } from "./paths.ts";
import { resolveModels } from "./models.ts";
import { detectSessionLang } from "./session-lang.ts";

export interface CategoryDef {
  dir: string; // folder under docs/wiki (ordered = numbered = reading order)
  domain: string; // frontmatter `domain:` value routed to this folder
  review: "human" | "model"; // human → 0_review queue; model → strong-model adjudication
  guide: string; // one-line convention prose (rendered into prompts/conventions output)
  aliases?: string[]; // extra domain spellings that route here (default: insight ← lesson)
  prompt?: string; // long-form WRITE-prompt description; falls back to guide. Defaults carry the
  // exact historical prompt lines so the default render stays byte-identical (see render fns).
}

export interface WikiConfig {
  configVersion: number;
  lang: string; // "" = decide by LLMWIKI_LANG env / default en
  categories: CategoryDef[];
  topicDir: string; // per-concept living encyclopedia (consolidate target)
  queueDir: string; // human-judgment queue
  quizDir: string; // human memory loop (quiz ledger + session records) — never indexed/searched
  quizQuestions: number; // default questions per /wiki-quiz session (argument can raise it; engine caps at QUIZ_MAX_QUESTIONS)
  privateDirs: string[]; // additional LOCAL-ONLY wiki dirs — indexed/searched/quizzed like any page, auto-gitignored, never committed
  models: { light: string; heavy: string }; // LLM tier per pass — env LLMWIKI_MODEL_LIGHT/HEAVY overrides this
  files: { l0: string; overview: string; log: string };
  legacyDirs: string[]; // old flat category names still scanned for staleness/index
  bannedTerms: [string, string][]; // [banned, preferred]
  source: string; // "defaults" | absolute path of the loaded file
  error?: string; // set when a config file existed but failed to load/validate
  warning?: string; // non-fatal resolver notes (applies_to tie, shadowed root file, unreadable sibling)
  selection?: string; // how this config was chosen (named match / configs default / root file / defaults)
}

export function defaults(): WikiConfig {
  return {
    configVersion: 1,
    lang: "",
    categories: [
      {
        dir: "1_direction", domain: "direction", review: "human",
        guide: "big direction/strategy — only the human confirms",
        prompt: "the project's big direction/strategy, OR a shift in it this session (from what → to what, and why). Rare.",
      },
      {
        dir: "2_milestone", domain: "milestone", review: "model",
        guide: "work progress + what's next",
        prompt: "work progress + what's next: what was built / changed / measured this session, plus any remaining TODOs the human stated.",
      },
      {
        dir: "3_decision", domain: "decision", review: "model",
        guide: "ADR: problem → alternatives → choice → consequences",
        prompt: "an ADR: a problem the HUMAN faced this (or a past) session, the alternatives weighed, and the choice made (context / decision / alternatives / consequences).",
      },
      {
        dir: "4_insight", domain: "insight", review: "model",
        guide: "realizations · gotchas · lessons while working", aliases: ["lesson"],
        prompt: "a realization or lesson surfaced while working with the human (a gotcha, a non-obvious learning, what made the result better) that helps future work.",
      },
    ],
    topicDir: "5_topic",
    queueDir: "0_review",
    quizDir: "6_quiz",
    quizQuestions: 3,
    privateDirs: [],
    models: resolveModels(), // env-or-builtin when there is no toml [models]
    files: { l0: "current-state.md", overview: "overview.md", log: "log.md" },
    legacyDirs: ["milestones", "insights", "decisions", "directions"],
    bannedTerms: [
      ["진북", "방향성"],
      ["북극성", "방향성"],
      ["distill", "update / 업데이트"],
    ],
    source: "defaults",
  };
}

export const CONFIG_BASENAME = "llmwiki.config.toml";

// Every directory and file name in the config is joined onto `docs/wiki`, and the config file
// itself can arrive with a clone (`configs/*.toml` is tracked). So a name is only ever ONE path
// segment: no separator, no `.`/`..`, no NUL. Without this, `files.l0 = "../../../.ssh/config"`
// makes the cold start read — and the skeleton writer create — a path outside the wiki entirely.
// The repository boundary refuses such a path too; this check exists so the config is rejected
// with an explanation instead of failing later at the write.
function _unsafeSegment(value: unknown): boolean {
  return typeof value !== "string" || value === "" || value === "." || value === ".." || /[\\/\0]/.test(value);
}

function _validate(c: WikiConfig): string | null {
  if (!Array.isArray(c.categories) || c.categories.length === 0) return "at least one [[category]] required";
  const dirs = new Set<string>();
  const domains = new Set<string>();
  for (const cat of c.categories) {
    if (_unsafeSegment(cat.dir)) return `category dir invalid: ${JSON.stringify(cat.dir)}`;
    if (!cat.domain || !/^[a-z][a-z0-9_-]*$/.test(cat.domain)) return `category domain invalid: ${JSON.stringify(cat.domain)} (lowercase slug)`;
    if (cat.review !== "human" && cat.review !== "model") return `category review must be "human"|"model": ${cat.dir}`;
    if (dirs.has(cat.dir)) return `duplicate category dir: ${cat.dir}`;
    if (domains.has(cat.domain)) return `duplicate category domain: ${cat.domain}`;
    dirs.add(cat.dir);
    domains.add(cat.domain);
  }
  if (!c.categories.some((cat) => cat.review === "model")) return 'at least one category needs review = "model" (the routing fallback)';
  for (const k of ["topicDir", "queueDir", "quizDir"] as const) {
    if (_unsafeSegment(c[k])) return `${k} invalid`;
  }
  for (const k of ["l0", "overview", "log"] as const) {
    if (_unsafeSegment(c.files[k])) return `files.${k} invalid: ${JSON.stringify(c.files[k])} (one file name, no path)`;
  }
  for (const d of c.legacyDirs) {
    if (_unsafeSegment(d)) return `legacy dir invalid: ${JSON.stringify(d)}`;
  }
  // quizDir's subtree is hard-excluded from indexing (db.ts) — colliding with a content dir
  // would silently unindex that whole category (0 pages in search/lint/review/cold-start).
  if (c.quizDir === c.topicDir || c.quizDir === c.queueDir || c.categories.some((cat) => cat.dir === c.quizDir))
    return `quizDir collides with a content dir: ${JSON.stringify(c.quizDir)} (the quiz subtree is never indexed)`;
  if (!Number.isInteger(c.quizQuestions) || c.quizQuestions < 1)
    return `quiz questions must be an integer ≥ 1: ${JSON.stringify(c.quizQuestions)}`;
  // Private dirs are ADDITIONAL local-only folders. Colliding with a shared dir would silently
  // gitignore a whole team category — a surprise no config comment can repair; forbid it.
  const seen = new Set<string>();
  for (const d of c.privateDirs) {
    if (_unsafeSegment(d)) return `private dir invalid: ${JSON.stringify(d)}`;
    if (seen.has(d)) return `duplicate private dir: ${d}`;
    seen.add(d);
    if (d === c.topicDir || d === c.queueDir || d === c.quizDir || c.categories.some((cat) => cat.dir === d))
      return `private dir collides with a shared wiki dir: ${JSON.stringify(d)} (private dirs are additional, local-only folders)`;
  }
  return null;
}

// Parse a TOML config file over defaults. Exported for tests; production goes via getConfig().
export function loadFrom(path: string): WikiConfig {
  const cfg = defaults();
  if (!existsSync(path)) return cfg;
  cfg.source = path;
  try {
    const raw = (Bun as any).TOML.parse(readFileSync(path, "utf-8"));
    if (raw.config_version !== undefined) cfg.configVersion = Number(raw.config_version);
    if (raw.wiki?.lang !== undefined) cfg.lang = String(raw.wiki.lang);
    if (Array.isArray(raw.category) && raw.category.length) {
      cfg.categories = raw.category.map((c: any) => ({
        dir: String(c.dir ?? ""),
        domain: String(c.domain ?? ""),
        review: c.review === "human" ? "human" : c.review === "model" ? "model" : (c.review ?? "model"),
        guide: String(c.guide ?? ""),
        ...(Array.isArray(c.aliases) ? { aliases: c.aliases.map(String) } : {}),
        ...(c.prompt !== undefined ? { prompt: String(c.prompt) } : {}),
      }));
    }
    if (raw.topic?.dir !== undefined) cfg.topicDir = String(raw.topic.dir);
    if (raw.queue?.dir !== undefined) cfg.queueDir = String(raw.queue.dir);
    if (raw.quiz?.dir !== undefined) cfg.quizDir = String(raw.quiz.dir);
    if (raw.quiz?.questions !== undefined) cfg.quizQuestions = Number(raw.quiz.questions);
    if (Array.isArray(raw.private?.dirs)) cfg.privateDirs = raw.private.dirs.map(String);
    // Models: env > toml [models] > builtin default (resolveModels enforces the order).
    cfg.models = resolveModels({
      light: raw.models?.light !== undefined ? String(raw.models.light) : undefined,
      heavy: raw.models?.heavy !== undefined ? String(raw.models.heavy) : undefined,
    });
    for (const k of ["l0", "overview", "log"] as const) {
      if (raw.files?.[k] !== undefined) cfg.files[k] = String(raw.files[k]);
    }
    if (Array.isArray(raw.legacy_dirs)) cfg.legacyDirs = raw.legacy_dirs.map(String);
    if (raw.lint?.banned_terms && typeof raw.lint.banned_terms === "object") {
      cfg.bannedTerms = Object.entries(raw.lint.banned_terms).map(([k, v]) => [k, String(v)] as [string, string]);
    }
    const err = _validate(cfg);
    if (err) {
      const fallback = defaults();
      fallback.source = path;
      fallback.error = err;
      return fallback;
    }
    return cfg;
  } catch (e) {
    const fallback = defaults();
    fallback.source = path;
    fallback.error = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
    return fallback;
  }
}

// ---- per-repo resolution (configs/) -------------------------------------------------------
//
// A team can scope conventions per repo: <clone>/configs/*.toml, each optionally declaring
// `applies_to = ["<folder>", ...]` — that folder and everything under it (segment-safe prefix,
// most-specific/longest match wins). A file WITHOUT applies_to is the folder default
// (canonical name: default.toml). Precedence:
//   ① named config with the most specific matching applies_to prefix
//   ② configs/ default (file without applies_to)
//   ③ root llmwiki.config.toml (legacy global — lets teams adopt named configs incrementally)
//   ④ built-in defaults()
// applies_to is resolver metadata only — it never enters WikiConfig validation. An unreadable
// named config is excluded from matching and surfaced as `warning` (never fatal — a broken
// config must not break a session hook, same contract as loadFrom's fail-safe).

export const CONFIGS_DIR = "configs";

interface Candidate {
  path: string;
  appliesTo: string[] | null; // normalized prefixes; null = folder default
  parseError?: string; // unreadable file — excluded from matching, surfaced as a warning
}

let _configRoot = CLONE_ROOT; // test seam (_resetForTests)
let _candidates: Candidate[] | null = null; // configs/ scanned once per process
const _cache = new Map<string, WikiConfig>(); // key: normalized repo path; "" = global

// ~ expansion + resolve + forward slashes + no trailing slash.
function _norm(p: string): string {
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
}

// Segment-safe prefix cover: /a/foo never matches /a/foobar.
const _covers = (prefix: string, repo: string) => repo === prefix || repo.startsWith(prefix + "/");

function _scan(): Candidate[] {
  if (_candidates) return _candidates;
  const dir = join(_configRoot, CONFIGS_DIR);
  const out: Candidate[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".toml")).sort()) {
      const path = join(dir, f);
      try {
        const raw = (Bun as any).TOML.parse(readFileSync(path, "utf-8"));
        out.push({
          path,
          appliesTo: Array.isArray(raw.applies_to) ? raw.applies_to.map((x: any) => _norm(String(x))) : null,
        });
      } catch (e) {
        out.push({ path, appliesTo: null, parseError: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  _candidates = out;
  return out;
}

function _finish(cfg: WikiConfig, warnings: string[], selection: string): WikiConfig {
  cfg.selection = selection;
  if (warnings.length) cfg.warning = warnings.join(" · ");
  return cfg;
}

function _resolve(repoKey: string): WikiConfig {
  const cands = _scan();
  const warnings = cands
    .filter((c) => c.parseError)
    .map((c) => `unreadable config ${basename(c.path)}: ${c.parseError}`);
  // ① named match — most-specific (longest) prefix wins; tie → first in sorted scan order + warning
  if (repoKey) {
    let best: { c: Candidate; len: number } | null = null;
    let tied = false;
    for (const c of cands) {
      if (c.parseError || !c.appliesTo) continue;
      for (const pre of c.appliesTo) {
        if (!_covers(pre, repoKey)) continue;
        if (!best || pre.length > best.len) {
          best = { c, len: pre.length };
          tied = false;
        } else if (pre.length === best.len && c !== best.c) tied = true;
      }
    }
    if (best) {
      if (tied) warnings.push(`applies_to tie at equal specificity — picked ${basename(best.c.path)}`);
      return _finish(loadFrom(best.c.path), warnings, `named (applies_to match: ${basename(best.c.path)})`);
    }
  }
  // ② configs/ default (no applies_to); prefer default.toml, else first in sorted order
  const defs = cands
    .filter((c) => !c.parseError && c.appliesTo === null)
    .sort((a, b) =>
      basename(a.path) === "default.toml" ? -1 : basename(b.path) === "default.toml" ? 1 : a.path.localeCompare(b.path),
    );
  if (defs.length) {
    if (defs.length > 1) warnings.push(`multiple default configs — using ${basename(defs[0]!.path)}`);
    if (existsSync(join(_configRoot, CONFIG_BASENAME)))
      warnings.push(`root ${CONFIG_BASENAME} is shadowed by ${CONFIGS_DIR}/`);
    return _finish(loadFrom(defs[0]!.path), warnings, `${CONFIGS_DIR}/ default`);
  }
  // ③ root llmwiki.config.toml → ④ built-in defaults (loadFrom covers both)
  const cfg = loadFrom(join(_configRoot, CONFIG_BASENAME));
  return _finish(cfg, warnings, cfg.source === "defaults" ? "built-in defaults" : "root file");
}

// Resolve the config for a repo (no-arg = global resolution: configs/ default → root → defaults).
export function getConfig(repo?: string): WikiConfig {
  const key = repo ? _norm(repo) : "";
  const hit = _cache.get(key);
  if (hit) return hit;
  const cfg = _resolve(key);
  _cache.set(key, cfg);
  return cfg;
}
export function _resetForTests(configRoot?: string): void {
  _cache.clear();
  _langCache.clear();
  _candidates = null;
  _configRoot = configRoot ?? CLONE_ROOT;
}

// ---- derived views (each consumer takes the view it needs — never re-declares the list) ----

// Log-layer category folders, in reading order.
export function logDirs(cfg: WikiConfig = getConfig()): string[] {
  return cfg.categories.map((c) => c.dir);
}

// Every folder scanned for the page index / staleness: log layer + topic + legacy flat names.
export function scanDirs(cfg: WikiConfig = getConfig()): string[] {
  return [...logDirs(cfg), cfg.topicDir, ...cfg.legacyDirs];
}

// frontmatter domain → category folder. Substring match preserves the historical routing
// (e.g. "direction-shift" → 1_direction); aliases cover renamed spellings (lesson → insight).
// No match → the first review:"model" category (the "executed work" default — 2_milestone
// in the default config).
export function domainToDir(domain: string, cfg: WikiConfig = getConfig()): string {
  const d = (domain || "").toLowerCase();
  if (d) {
    for (const c of cfg.categories) {
      if (d.includes(c.domain)) return c.dir;
      if (c.aliases?.some((a) => d.includes(a))) return c.dir;
    }
  }
  return cfg.categories.find((c) => c.review === "model")!.dir;
}

// Does this category folder require the human-judgment queue?
export function isHumanReviewDir(dir: string, cfg: WikiConfig = getConfig()): boolean {
  return cfg.categories.find((c) => c.dir === dir)?.review === "human";
}

// ---- wiki language ------------------------------------------------------------------------
//
// `lang` never decides the language of a PAGE: page prose follows the session's own language (that
// rule lives in the WRITE prompt). What it decides is the text the ENGINE authors — the skeleton it
// seeds, the pointer `overview.md` collapses to, the ledger headers — plus its own UI where a
// catalog exists. Any BCP-47-ish code is accepted; a code with no catalog resolves to English, so a
// typo or an unsupported language degrades to consistent English instead of failing.
const WIKI_LANGS = ["en", "ko", "ja", "zh"] as const;
export type WikiLang = (typeof WIKI_LANGS)[number];

/** One catalog per language, English required — the fallback for every unsupported code. */
export type LangCatalog<T> = Partial<Record<WikiLang, T>> & { en: T };

function normalizeLang(raw: string): WikiLang | null {
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return (WIKI_LANGS as readonly string[]).includes(primary) ? (primary as WikiLang) : null;
}

/**
 * The wiki's language without looking at a repository: LLMWIKI_LANG → config → English.
 *
 * Prefer `resolveWikiLang(root)` wherever a repository is in hand — that one can see the session
 * language. This exists for the pure renderers, whose default argument must not touch the disk.
 */
export function resolveLang(cfg: { readonly lang?: string } = getConfig()): WikiLang {
  const env = normalizeLang(process.env.LLMWIKI_LANG ?? "");
  if (env) return env;
  if ((process.env.LLMWIKI_LANG ?? "").trim()) return "en"; // set but unsupported → English
  return normalizeLang(cfg.lang ?? "") ?? "en";
}

/** Is `lang` an explicit choice, or a request to follow the session ("", "auto")? */
function explicitLang(raw: string | undefined): WikiLang | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value === "auto") return null;
  return normalizeLang(value);
}

/**
 * The language of the wiki at `root`, defaulting to THE SESSION'S OWN LANGUAGE.
 *
 * Order: LLMWIKI_LANG → an explicit `[wiki] lang` → detected from this session → English.
 *
 * "Detected from this session" is deliberately two-tiered, because the engine is a CLI and cannot
 * read the conversation: first the wiki's own content pages (what previous sessions produced —
 * which also makes the answer sticky, so a wiki never flips language between runs), then the
 * human's own utterances in this repo's captured transcripts, which is all a brand-new wiki has.
 * Engine-authored files never vote: an English skeleton seeded on day one must not lock a Korean
 * team into English forever.
 */
export function resolveWikiLang(root: string, cfg: { readonly lang?: string } = getConfig(root)): WikiLang {
  const env = normalizeLang(process.env.LLMWIKI_LANG ?? "");
  if (env) return env;
  if ((process.env.LLMWIKI_LANG ?? "").trim()) return "en";
  const explicit = explicitLang(cfg.lang);
  if (explicit) return explicit;
  // Detection touches the disk, and one command can write several files (a close-out normalizes
  // the overview, refreshes the queue and appends the log). Resolve once per repo per process.
  const cached = _langCache.get(root);
  if (cached) return cached;
  const detected = detectSessionLang(root, getConfig(root)) ?? "en";
  _langCache.set(root, detected);
  return detected;
}

const _langCache = new Map<string, WikiLang>();


/** Pick from a catalog for an already-resolved language. */
export function pickLangValue<T>(catalog: LangCatalog<T>, lang: WikiLang): T {
  return catalog[lang] ?? catalog.en;
}

/**
 * Korean-or-not, for the surfaces whose catalogs are still en/ko only (cold-start operating rules,
 * CLI, lint messages). Those fall back to English for every other language — a half-translated
 * cold-start reads worse than a consistent English one.
 */
export function effectiveKo(cfg: WikiConfig = getConfig()): boolean {
  return resolveLang(cfg) === "ko";
}

/**
 * The language of the wiki AT A REPO PATH — the question every writer asks before it puts a
 * sentence on a page or on the terminal. Callers that already hold a resolved config keep using
 * `effectiveKo(cfg)`; this exists so "resolve that repo's config, then ask" is spelled once.
 */
export function isRepoKorean(root: string): boolean {
  return resolveWikiLang(root) === "ko";
}

// ---- prompt / rules rendering (P2) --------------------------------------------------------
//
// CANONICAL-DEFAULT CONTRACT: tests/config-render.test.ts pins the stock prompt/rules text so
// intentional writing-contract changes land everywhere together. Custom configs take the generic
// branch. When editing these strings, update the prompts' consumers' intent too.

// Are the conventions (categories + banned terms) unchanged from stock? Legacy artisanal text
// is only safe to emit when yes.
export function isStockConventions(cfg: WikiConfig = getConfig()): boolean {
  const d = defaults();
  return (
    JSON.stringify(cfg.categories) === JSON.stringify(d.categories) &&
    JSON.stringify(cfg.bannedTerms) === JSON.stringify(d.bannedTerms)
  );
}

// WRITE-prompt domain bullet list (one line per category).
export function renderDomainBullets(cfg: WikiConfig = getConfig()): string {
  return cfg.categories.map((c) => `  - ${c.domain} — ${c.prompt ?? c.guide}`).join("\n");
}

// "(direction, milestone, decision, or insight)" — the domain-pick phrase.
export function renderDomainList(cfg: WikiConfig = getConfig()): string {
  const ds = cfg.categories.map((c) => c.domain);
  return ds.length > 1 ? `${ds.slice(0, -1).join(", ")}, or ${ds[ds.length - 1]}` : (ds[0] ?? "");
}

// Grounding sentence: fact-recording domains vs judgment-bearing domains. The default render
// reproduces the historical sentence exactly ("For milestone, record stated facts. For
// insight / decision / direction, …") — hence the reversed order of the non-fallback domains.
export function renderGroundingRule(cfg: WikiConfig = getConfig()): string {
  const fallback = cfg.categories.find((c) => c.review === "model")!;
  const judgment = cfg.categories.filter((c) => c !== fallback).map((c) => c.domain).reverse();
  return (
    `- Grounding rule: write only what is grounded in the transcript. For ${fallback.domain}, record stated facts. ` +
    `For ${judgment.join(" / ")}, summarize what the HUMAN actually realized or decided — never invent judgments, ` +
    `opinions, or decisions the human did not make. When unsure, omit.`
  );
}

// Terminology guidance. The stock sentence is artisanal prose (groups two banned terms, adds
// "north-star") that cannot be derived from the data — emit it verbatim for stock conventions,
// and a mechanical banned-list render otherwise.
export function renderTerminologyLine(cfg: WikiConfig = getConfig()): string {
  if (isStockConventions(cfg)) {
    return "- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't naturally say — e.g. when writing Korean prefer `방향성` (NOT 진북/북극성/north-star) and `업데이트`/`update` (NOT distill).";
  }
  if (!cfg.bannedTerms.length) return "";
  const pairs = cfg.bannedTerms.map(([a, b]) => `\`${a}\` (prefer \`${b}\`)`).join(", ");
  return `- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't naturally say — banned: ${pairs}.`;
}

// Compact enough to repeat across every model-written surface. The exact indentation examples
// carry the structure without spending prompt tokens on a separate style essay.
export function renderBodyStyleRule(): string {
  return [
    "- Body style: numbered sections holding a bullet hierarchy a person can scan.",
    "    - Sections `## 1. <label>`, `## 2. <label>` … in reading order; split one as `### 1-1. <label>` only when it has parts. Sections start once a page holds 6+ top-level bullets; a shorter one stays a bare list under the TL;DR.",
    "    - Inside a section: one concrete claim, decision, result, or action per `-`; supporting detail at `    -`; deeper detail at `        -`. No fourth level.",
    "    - A bullet enumerating more than three items becomes a parent plus one child per item — never a `·`-joined line.",
    "    - Endings: noun phrases or telegraphic endings natural to the page language; keep verbs when actor, action, condition, or outcome would be unclear. No abstract framing, no child repeating its parent.",
  ].join("\n");
}

// Cold-start operating-rule fragments (rule 2's category listing + rule 3's human-queue line).
// Stock conventions get the historical artisanal glosses verbatim; custom configs get a
// mechanical `dir (guide)` render in the config's own words.
export function renderRuleCategories(lang: "ko" | "en", cfg: WikiConfig = getConfig()): string {
  if (isStockConventions(cfg)) {
    return lang === "ko"
      ? "2) 다음 작업에 도움될 것만 기록한다(잡내용 금지). 카테고리(읽기 순): 1_direction(큰 방향성) / 2_milestone(작업 진행+앞으로 할 것) / 3_decision(문제·대안·선택 ADR) / 4_insight(작업 중 깨달음·성과 개선)."
      : "2) Record only what helps future work (no noise). Categories (reading order): 1_direction (big direction) / 2_milestone (work done + what's next) / 3_decision (problem·alternatives·choice = ADR) / 4_insight (realizations·gotchas while working).";
  }
  const cats = cfg.categories.map((c) => `${c.dir} (${c.guide})`).join(" / ");
  return lang === "ko"
    ? `2) 다음 작업에 도움될 것만 기록한다(잡내용 금지). 카테고리(읽기 순): ${cats}.`
    : `2) Record only what helps future work (no noise). Categories (reading order): ${cats}.`;
}

export function renderRuleHumanQueue(lang: "ko" | "en", cfg: WikiConfig = getConfig()): string {
  if (isStockConventions(cfg)) {
    return lang === "ko"
      ? "   방향성 전환(1_direction)만 사람 판단: 본문을 단정하지 말고 docs/wiki/0_review/ 에 올려 사람이 확정하게 한다. 분류 애매·품질 실패는 0_review로 보내지 말 것(모델이 판단/기각). 사람이 방향성을 처리하면 그 파일은 삭제."
      : "   Only a direction shift (1_direction) needs human judgment: don't assert it in the body — queue it in docs/wiki/0_review/ for the human to confirm. Don't send ambiguous filing/quality failures to 0_review (the model decides/omits). Once the human resolves a direction, delete that file.";
  }
  const human = cfg.categories.filter((c) => c.review === "human").map((c) => c.dir);
  const q = cfg.queueDir;
  const humanList = human.join("·") || "(none)";
  return lang === "ko"
    ? `   사람 판단 카테고리(${humanList})만 사람 확정: 본문을 단정하지 말고 docs/wiki/${q}/ 에 올려 사람이 확정하게 한다. 분류 애매·품질 실패는 ${q}로 보내지 말 것(모델이 판단/기각). 사람이 처리하면 그 파일은 삭제.`
    : `   Only human-review categories (${humanList}) need human judgment: don't assert them in the body — queue them in docs/wiki/${q}/ for the human to confirm. Don't send ambiguous filing/quality failures to ${q} (the model decides/omits). Once the human resolves an item, delete that file.`;
}
