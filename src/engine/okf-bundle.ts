// The wiki as an OKF bundle on disk: generated `index.md` files, conformance checks over a whole
// bundle, and `llmwiki okf` — the one deterministic pass that brings a wiki to OKF v0.2 and keeps
// it there (types, lifecycle status, sources keyed to footnotes, `generated` stamps, standard
// markdown links, a dated newest-first log).
//
// Safety model, same as `llmwiki migrate`: a dry run is the default and `--commit` applies. A
// wiki that predates OKF is converted only when a person runs the command; the close-out skill
// calls it with `--if-okf`, which never converts a legacy wiki behind a teammate's back.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { posix, resolve } from "node:path";
import { getConfig, domainToDir, pickLangValue, resolveWikiLang, type CategoryDef, type WikiConfig } from "./config.ts";
import {
  checkConcept,
  checkIndex,
  checkLog,
  convertWikilinks,
  declaredOkfVersion,
  isIsoDateTime,
  isLegacyLog,
  isStale,
  isoFromDate,
  isoLocal,
  mergeSources,
  okfStatus,
  logContentLines,
  logIntro,
  parseLog,
  parseYamlBlock,
  renderDocument,
  renderIndex,
  renderLog,
  splitFrontmatter,
  trustTier,
  typeKey,
  typeNameFor,
  type IndexEntry,
  type IndexSection,
  type LinkTarget,
  type OkfIssue,
  type TrustEvent,
  type TrustTier,
  type YamlMap,
} from "./okf.ts";
import { lookupKey } from "./refs.ts";
import { readRepoDir, readRepoFile, removeRepoFile, renameRepoPath, repoFileExists, repoFileMtime, setRepoFileMtime, writeRepoFile } from "./repo-write.ts";
import packageJson from "../../package.json" with { type: "json" };

export const WIKI_REL = "docs/wiki";
export const LEGACY_COLD_INDEX = "cold-index.md";
const RESERVED = new Set(["index.md", "log.md"]);
export const LEGACY_ACTOR = "llmwiki/legacy";

export function engineActor(): string {
  return `llmwiki/${packageJson.version}`;
}

// ---- types --------------------------------------------------------------------------------

export function categoryType(cat: CategoryDef): string {
  return typeNameFor(cat.domain);
}

/** The llmwiki domain a type stands for (`Decision` → `decision`), or null for other types. */
export function domainForType(type: string | null | undefined, cfg: WikiConfig = getConfig()): string | null {
  if (!type) return null;
  const k = typeKey(type);
  for (const c of cfg.categories) {
    if (typeKey(categoryType(c)) === k || typeKey(c.domain) === k) return c.domain;
    if (c.aliases?.some((a) => typeKey(a) === k)) return c.domain;
  }
  return k === "topic" ? "topic" : null;
}

/** The OKF `type` for a page that declares none: by where it lives, else by its legacy `domain`. */
export function typeForPage(rel: string, data: YamlMap, cfg: WikiConfig): string {
  const name = posix.basename(rel);
  const top = rel.includes("/") ? rel.split("/")[0]! : "";
  const l0Detail = cfg.files.l0.replace(/\.md$/i, "-detail.md");
  if (rel === cfg.files.l0 || rel === l0Detail) return "Current State";
  if (rel === cfg.files.overview) return "Overview";
  if (top === cfg.topicDir) return "Topic";
  if (top === cfg.queueDir) {
    if (name === "gap-queue.md") return "Gap Queue";
    if (name.startsWith("semantic-review")) return "Review Report";
    return "Review Item";
  }
  if (top === cfg.quizDir) return name.startsWith("quiz-ledger") ? "Quiz Ledger" : "Quiz Record";
  const cat = cfg.categories.find((c) => c.dir === top);
  if (cat) return categoryType(cat);
  const domain = typeof data.domain === "string" ? data.domain.trim() : "";
  if (domain === "topic") return "Topic";
  if (domain) {
    const dir = domainToDir(domain, cfg);
    const mapped = cfg.categories.find((c) => c.dir === dir);
    if (mapped && (domain.includes(mapped.domain) || mapped.aliases?.some((a) => domain.includes(a)))) return categoryType(mapped);
    return typeNameFor(domain);
  }
  return "Note";
}

// ---- bundle walk --------------------------------------------------------------------------

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/** Every `.md` under the bundle, bundle-relative POSIX paths; dot-directories are not content. */
export function bundleFiles(root: string, rel = WIKI_REL, prefix = "", out: string[] = []): string[] {
  for (const e of readRepoDir(root, rel)) {
    if (e.name.startsWith(".")) continue;
    const child = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) bundleFiles(root, `${rel}/${e.name}`, child, out);
    else if (e.isFile && isMarkdown(e.name)) out.push(child);
  }
  return out.sort();
}

export function isOkfBundle(root: string): boolean {
  return declaredOkfVersion(readRepoFile(resolve(root), `${WIKI_REL}/index.md`)) !== null;
}

type PageMeta = { rel: string; data: YamlMap; type: string; title: string; description: string; date: string };

function readMeta(root: string, rel: string, cfg: WikiConfig): PageMeta | null {
  const content = readRepoFile(root, `${WIKI_REL}/${rel}`);
  if (content === null) return null;
  const { block, body } = splitFrontmatter(content);
  const data = block === null ? {} : parseYamlBlock(block).data;
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : h1 || posix.basename(rel, ".md");
  const type = typeof data.type === "string" && data.type.trim() ? data.type.trim() : typeForPage(rel, data, cfg);
  const date = String(data.date ?? data.updated ?? "").slice(0, 10);
  return { rel, data, type, title, description: typeof data.description === "string" ? data.description : "", date };
}

// ---- index.md generation ------------------------------------------------------------------

/** Folders that never appear in a committed listing: the quiz layer and the personal overlay. */
function unlisted(cfg: WikiConfig): Set<string> {
  return new Set([cfg.quizDir, ...cfg.privateDirs]);
}

function dirDescription(dir: string, cfg: WikiConfig): string {
  const cat = cfg.categories.find((c) => c.dir === dir);
  if (cat) return cat.guide;
  if (dir === cfg.topicDir) return "topic encyclopedia — one living page per concept";
  if (dir === cfg.queueDir) return "human-judgment queue — direction shifts and unresolved contradictions";
  return "";
}

/**
 * The `index.md` of every listed directory, keyed by bundle-relative path. Concepts are grouped
 * under their `type`, newest first; subdirectories come last. Deterministic: the same pages always
 * render the same bytes, so an unchanged wiki never shows an index diff.
 */
export function buildIndexes(root: string, cfg: WikiConfig = getConfig(root)): Map<string, string> {
  const hidden = unlisted(cfg);
  const files = bundleFiles(root).filter((rel) => !hidden.has(rel.split("/")[0]!));
  const byDir = new Map<string, PageMeta[]>();
  const dirs = new Set<string>([""]);
  for (const rel of files) {
    const name = posix.basename(rel);
    const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    for (let d = dir; d; d = posix.dirname(d) === "." ? "" : posix.dirname(d)) dirs.add(d);
    if (RESERVED.has(name) || (dir === "" && (name === LEGACY_COLD_INDEX || name === cfg.files.log))) continue;
    const meta = readMeta(root, rel, cfg);
    if (!meta) continue;
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(meta);
  }
  const out = new Map<string, string>();
  // A folder is listed when it, or anything below it, holds a page.
  const filled = new Set<string>();
  for (const d of byDir.keys()) {
    for (let x = d; x; x = posix.dirname(x) === "." ? "" : posix.dirname(x)) filled.add(x);
  }
  const hasContent = (d: string): boolean => filled.has(d);
  for (const dir of [...dirs].sort()) {
    const pages = byDir.get(dir) ?? [];
    const groups = new Map<string, PageMeta[]>();
    for (const p of pages) {
      if (!groups.has(p.type)) groups.set(p.type, []);
      groups.get(p.type)!.push(p);
    }
    const sections: IndexSection[] = [...groups.keys()].sort().map((type) => ({
      heading: type,
      entries: groups
        .get(type)!
        .sort((a, b) => (a.date === b.date ? (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) : a.date < b.date ? 1 : -1))
        .map((p): IndexEntry => ({ title: p.title, href: posix.basename(p.rel).replace(/ /g, "%20"), description: p.description })),
    }));
    const subdirs = [...dirs]
      .filter((d) => d && (posix.dirname(d) === "." ? "" : posix.dirname(d)) === dir && hasContent(d))
      .sort();
    sections.push({
      heading: "Subdirectories",
      entries: subdirs.map((d) => ({ title: posix.basename(d), href: `${posix.basename(d)}/index.md`, description: dirDescription(d, cfg) })),
    });
    if (dir !== "" && !sections.some((s) => s.entries.length)) continue;
    out.set(dir ? `${dir}/index.md` : "index.md", renderIndex(sections, dir === ""));
  }
  return out;
}

/** Write changed `index.md` files (OKF bundles only). Returns how many were (re)written. */
export function writeIndexes(root: string, cfg: WikiConfig = getConfig(root)): number {
  let written = 0;
  for (const [rel, content] of buildIndexes(root, cfg)) {
    const path = `${WIKI_REL}/${rel}`;
    if (readRepoFile(root, path) === content) continue;
    writeRepoFile(root, path, content);
    written += 1;
  }
  return written;
}

// ---- links --------------------------------------------------------------------------------

/** Resolve a `[[target]]` the way the indexer does: bundle path, then path + .md, then filename. */
export function linkResolver(root: string, files: string[], cfg: WikiConfig): (target: string) => LinkTarget | null {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const rel of files) {
    const k = lookupKey(rel);
    byPath.set(k, rel);
    const name = lookupKey(posix.basename(rel));
    if (!byName.has(name)) byName.set(name, rel);
    const stem = name.replace(/\.md$/, "");
    if (!byName.has(stem)) byName.set(stem, rel);
  }
  const titles = new Map<string, string>();
  return (target) => {
    let t = lookupKey(target.trim()).replace(/^\.\//, "");
    t = t.replace(/^docs\/wiki\//, "").replace(/^\//, "");
    const rel = byPath.get(t) ?? byPath.get(`${t}.md`) ?? byName.get(t.split("/").pop()!);
    if (!rel) return null;
    if (!titles.has(rel)) titles.set(rel, readMeta(root, rel, cfg)?.title ?? posix.basename(rel, ".md"));
    return { rel, title: titles.get(rel)! };
  };
}

// ---- page normalization -------------------------------------------------------------------

export type NormalizeContext = {
  cfg: WikiConfig;
  resolve: (target: string) => LinkTarget | null;
  /** Set when the file changed in the working tree: its mtime as an ISO instant. */
  changedAt: string | null;
  actor: string;
  verifiedHint: TrustEvent | null;
  /** `generated.by` of the committed (HEAD) version, when there is one. */
  headBy?: string;
};

export type PageChange =
  | "frontmatter-added"
  | "yaml-repaired"
  | "type"
  | "status"
  | "domain-dropped"
  | "sources"
  | "generated"
  | "verified"
  | "links";

function isMap(v: unknown): v is YamlMap {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const STAMP_SLACK_MS = 120_000;

/**
 * One page brought to OKF form. Pure apart from link resolution: the same input yields the same
 * output, and a conformant page comes back byte-identical (no change, no diff).
 */
export function normalizePage(
  rel: string,
  content: string,
  ctx: NormalizeContext,
): { content: string; changes: PageChange[]; unresolvedLinks: string[] } {
  const changes: PageChange[] = [];
  const { block, body: rawBody } = splitFrontmatter(content);
  let data: YamlMap;
  if (block === null) {
    data = {};
    changes.push("frontmatter-added");
    const h1 = /^#\s+(.+)$/m.exec(rawBody)?.[1]?.trim();
    data.title = h1 || posix.basename(rel, ".md");
  } else {
    const parsed = parseYamlBlock(block);
    data = { ...parsed.data };
    if (parsed.error) changes.push("yaml-repaired");
  }

  if (typeof data.type !== "string" || !data.type.trim()) {
    data.type = typeForPage(rel, data, ctx.cfg);
    changes.push("type");
  }
  if (data.status !== undefined) {
    const s = okfStatus(data.status);
    if (s && s !== data.status) {
      data.status = s;
      changes.push("status");
    }
  }
  if (data.domain !== undefined) {
    delete data.domain;
    changes.push("domain-dropped");
  }

  // Links first: sources and stamps are computed on the body that will be written.
  const links = convertWikilinks(rawBody, rel, ctx.resolve);
  const body = links.body;
  if (links.converted) changes.push("links");

  const before = JSON.stringify(data.sources ?? null);
  const legacySource = data.source;
  const sources = mergeSources(data.sources, body, typeof legacySource === "string" ? legacySource : undefined);
  // A `source:` that is not one string (a list, a map) has no faithful `sources` form: keep it.
  if (typeof legacySource === "string") delete data.source;
  if (sources.length) data.sources = sources;
  else if (Array.isArray(data.sources) || isMap(data.sources)) delete data.sources;
  if (JSON.stringify(data.sources ?? null) !== before) changes.push("sources");

  const updated = data.updated;
  const updatedAt = isoFromDate(updated);
  // `updated` folds into `generated.at` only when it is a date we can read; otherwise it stays.
  if (updated !== undefined && (updatedAt !== null || updated === "" || updated === null)) delete data.updated;
  const g: YamlMap | null = isMap(data.generated) ? { ...data.generated } : null;
  const fromDates = updatedAt ?? isoFromDate(data.date);
  const stamp = JSON.stringify(data.generated ?? null);
  const nowMs = Date.now();
  if (g === null) {
    const at = ctx.changedAt ?? fromDates;
    data.generated = at ? { by: ctx.changedAt ? ctx.actor : LEGACY_ACTOR, at } : { by: ctx.changedAt ? ctx.actor : LEGACY_ACTOR };
  } else {
    if (typeof g.by !== "string" || !g.by.trim()) g.by = ctx.changedAt ? ctx.actor : LEGACY_ACTOR;
    if (!isIsoDateTime(g.at)) g.at = isoFromDate(g.at) ?? ctx.changedAt ?? fromDates ?? undefined;
    const atMs = typeof g.at === "string" ? Date.parse(g.at) : NaN;
    // A stamp in the future (a local wall time written with `Z`, a guess) is never kept.
    const future = !Number.isNaN(atMs) && atMs - nowMs > STAMP_SLACK_MS;
    if (ctx.changedAt && (Number.isNaN(atMs) || future || Date.parse(ctx.changedAt) - atMs > STAMP_SLACK_MS)) {
      g.at = ctx.changedAt;
      // The body changed since the last commit: whoever stamped the committed version did not
      // write this one. A writer that stamped itself in this edit keeps its name.
      if (g.by === LEGACY_ACTOR || (ctx.headBy !== undefined && g.by === ctx.headBy)) g.by = ctx.actor;
    } else if (future) {
      g.at = isoLocal(new Date(nowMs));
    }
    if (updatedAt && typeof g.at === "string" && Date.parse(updatedAt) > Date.parse(g.at)) g.at = updatedAt;
    if (g.at === undefined) delete g.at;
    data.generated = g;
  }
  if (JSON.stringify(data.generated) !== stamp || (updated !== undefined && data.updated === undefined)) changes.push("generated");

  if (ctx.verifiedHint && data.verified === undefined) {
    data.verified = { ...ctx.verifiedHint };
    changes.push("verified");
  }

  if (!changes.length) return { content, changes, unresolvedLinks: links.unresolved };
  return { content: renderDocument(data, body), changes, unresolvedLinks: links.unresolved };
}

// ---- log ----------------------------------------------------------------------------------

export const LOG_HEADING = "Log";
export const LOG_BODY = {
  en: "Update history of this wiki (ingest·update·lint·decide), newest first.\n",
  ko: "이 위키의 갱신 기록 (ingest·update·lint·decide), 최신순.\n",
  ja: "このウィキの更新記録（ingest·update·lint·decide）、新しい順。\n",
  zh: "本 wiki 的更新记录（ingest·update·lint·decide），最新在前。\n",
};

// The intros the pre-OKF skeleton wrote; they described an append-only log, which is no longer true.
const LEGACY_INTRO = /append-only|追記のみ|仅追加|시간순 기록/;

/**
 * A log in §9 form. A hand-written intro survives; the stock pre-OKF intro is replaced by the
 * current one. `lost` is set when the render would hold fewer content lines than the original —
 * the caller then keeps the original rather than write a shorter log.
 */
export function convertLog(text: string, intro: string): { content: string; entries: number; lost: boolean } {
  const entries = parseLog(text);
  const preamble = logIntro(text);
  const keep = preamble && !LEGACY_INTRO.test(preamble) ? preamble : intro;
  const content = renderLog(entries, LOG_HEADING, keep);
  // An entry with no date has no §9 group to live in; inventing one would fabricate history.
  const undated = entries.some((e) => !e.date);
  return { content, entries: entries.length, lost: undated || logContentLines(content) < logContentLines(text) };
}

// ---- git signals --------------------------------------------------------------------------

/**
 * The workspace's path inside its git repository (`""` at the top level, `sub/dir/` below it).
 * `git status` and `HEAD:<path>` speak repository-root paths, so a wiki in a monorepo subfolder
 * must be addressed with this prefix or every change goes unseen.
 */
function gitPrefix(root: string): string {
  return git(root, ["rev-parse", "--show-prefix"])?.trim() ?? "";
}

function git(root: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Bundle-relative pages modified or untracked in the working tree; null outside git. */
export function changedPages(root: string): Set<string> | null {
  const out = git(root, ["status", "--porcelain", "-z", "--untracked-files=all", "--", WIKI_REL]);
  if (out === null) return null;
  const prefix = `${gitPrefix(root)}${WIKI_REL}/`;
  const set = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i]!;
    if (rec.length < 4) continue;
    const x = rec[0];
    const path = rec.slice(3);
    if (x === "R" || x === "C") i += 1; // the source path follows a rename/copy record
    if (path.startsWith(prefix)) set.add(path.slice(prefix.length));
  }
  return set;
}

/**
 * HEAD's copy of each page, read in one `git cat-file --batch`. A page counts as edited only when
 * its BODY differs from HEAD — a frontmatter-only rewrite (this pass's own output, a status
 * change) must not re-stamp `generated.at`, or every run would bump every uncommitted page.
 */
export function headContents(root: string, rels: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!rels.length) return out;
  try {
    const r = spawnSync("git", ["-C", root, "cat-file", "--batch"], {
      // `HEAD:./path` resolves against the working directory, so a monorepo subfolder works too.
      input: rels.map((rel) => `HEAD:./${WIKI_REL}/${rel}`).join("\n") + "\n",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return out;
    const buf = r.stdout as Buffer;
    let pos = 0;
    for (const rel of rels) {
      const nl = buf.indexOf(10, pos);
      if (nl === -1) break;
      const header = buf.subarray(pos, nl).toString("utf-8");
      pos = nl + 1;
      const m = /^\S+ blob (\d+)$/.exec(header);
      if (!m) continue; // "<object> missing": untracked or new
      const size = Number(m[1]);
      out.set(rel, buf.subarray(pos, pos + size).toString("utf-8"));
      pos += size + 1;
    }
  } catch {
    /* not a repository: every changed page counts as edited */
  }
  return out;
}

function loginOf(email: string): string {
  return email.split("@")[0]!.trim();
}

/** The person who added a file (mailmap-aware), as an OKF `human:` actor; null outside git. */
function addedBy(root: string, rel: string): string | null {
  const out = git(root, ["log", "--diff-filter=A", "--follow", "--format=%aE", "--", `${WIKI_REL}/${rel}`]);
  const email = out?.trim().split("\n").pop()?.trim();
  return email ? `human:${loginOf(email)}` : null;
}

function localHuman(root: string): string | null {
  const email = git(root, ["config", "user.email"])?.trim();
  return email ? `human:${loginOf(email)}` : null;
}

/** Pages the unattended pass already had confirmed by its strong-model VERIFY step. */
function machineVerified(logText: string | null): Map<string, TrustEvent> {
  const out = new Map<string, TrustEvent>();
  if (!logText) return out;
  for (const e of parseLog(logText)) {
    for (const line of e.detail) {
      // The autoupdate log line, in both languages it is written in.
      const m = /([\w가-힣./-]+\.md)\s*\((?:strong-model confirmed|Opus 확정)/.exec(line);
      if (m) out.set(m[1]!.replace(/^docs\/wiki\//, ""), { by: "process:llmwiki-autoupdate-verify", at: isoFromDate(e.date) });
    }
  }
  return out;
}

// ---- the pass -----------------------------------------------------------------------------

export type OkfApplyResult = {
  verdict: "skip" | "legacy-skip" | "conforms" | "planned" | "applied";
  wasOkf: boolean;
  pages: number;
  pagesChanged: number;
  changes: Partial<Record<PageChange, number>>;
  linksConverted: number;
  linksUnresolved: number;
  logEntries: number;
  logConverted: boolean;
  /** The log needed re-rendering but the render would have dropped lines; it was left as is. */
  logKept?: boolean;
  /** Hand-written index.md files moved to index-original.md before the listings were generated. */
  indexesPreserved: string[];
  indexesWritten: number;
  coldIndexRemoved: boolean;
  reason?: string;
};

/**
 * Bring `docs/wiki` to OKF v0.2. Dry-run unless `commit`; `ifOkf` makes it a no-op on a wiki
 * that has not been converted yet (the close-out path), so only an explicit run migrates.
 */
export function okfApply(ws: string, opts: { commit?: boolean; ifOkf?: boolean; actor?: string } = {}): OkfApplyResult {
  const root = resolve(ws);
  const cfg = getConfig(root);
  const empty: OkfApplyResult = {
    verdict: "skip",
    wasOkf: false,
    pages: 0,
    pagesChanged: 0,
    changes: {},
    linksConverted: 0,
    linksUnresolved: 0,
    logEntries: 0,
    logConverted: false,
    indexesPreserved: [],
    indexesWritten: 0,
    coldIndexRemoved: false,
  };
  if (!readRepoDir(root, WIKI_REL).length) return { ...empty, reason: "no docs/wiki" };
  const wasOkf = isOkfBundle(root);
  if (opts.ifOkf && !wasOkf) return { ...empty, verdict: "legacy-skip", reason: "wiki is not OKF yet — run `llmwiki okf <repo>` then `--commit`" };

  let files = bundleFiles(root);
  // A pre-OKF wiki may hold a hand-written index.md; OKF reserves the name for the generated
  // listing, so the page moves beside it (index-original.md) instead of being overwritten.
  const handIndexes = wasOkf ? [] : files.filter((rel) => posix.basename(rel) === "index.md");
  const result: OkfApplyResult = { ...empty, wasOkf };
  result.indexesPreserved = handIndexes.map((rel) => rel.replace(/index\.md$/, "index-original.md"));
  if (opts.commit && handIndexes.length) {
    for (const rel of handIndexes) {
      const to = rel.replace(/index\.md$/, "index-original.md");
      if (repoFileExists(root, `${WIKI_REL}/${to}`)) throw new Error(`okf: ${to} already exists — move ${rel} aside by hand first`);
      renameRepoPath(root, `${WIKI_REL}/${rel}`, `${WIKI_REL}/${to}`);
    }
    files = bundleFiles(root);
  }
  const resolveLink = linkResolver(root, files, cfg);
  const changed = changedPages(root);
  const head = headContents(root, [...(changed ?? [])]);
  const logRel = cfg.files.log;
  const logText = readRepoFile(root, `${WIKI_REL}/${logRel}`);
  const logIntro = pickLangValue(LOG_BODY, resolveWikiLang(root, cfg));
  const verifiedByLog = wasOkf ? new Map<string, TrustEvent>() : machineVerified(logText);
  const humanDirs = new Set(cfg.categories.filter((c) => c.review === "human").map((c) => c.dir));
  const actor = opts.actor || process.env.LLMWIKI_ACTOR || engineActor();
  const fallbackHuman = wasOkf ? null : localHuman(root);

  const writes: { rel: string; content: string; mtime: number | null }[] = [];
  for (const rel of files) {
    const name = posix.basename(rel);
    if (RESERVED.has(name) || rel === LEGACY_COLD_INDEX || rel === logRel) continue;
    const content = readRepoFile(root, `${WIKI_REL}/${rel}`);
    if (content === null) continue;
    result.pages += 1;
    let changedAt: string | null = null;
    const before = head.get(rel);
    const sameBody =
      before !== undefined &&
      convertWikilinks(splitFrontmatter(before).body, rel, resolveLink).body.replace(/^\s+/, "") ===
        splitFrontmatter(content).body.replace(/^\s+/, "");
    if (changed?.has(rel) && !sameBody) {
      const mtime = repoFileMtime(root, `${WIKI_REL}/${rel}`);
      if (mtime !== null) changedAt = isoLocal(new Date(mtime));
    }
    let hint: TrustEvent | null = verifiedByLog.get(rel) ?? null;
    const top = rel.split("/")[0]!;
    if (!wasOkf && !hint && humanDirs.has(top)) {
      // A human-review category only ever receives a page after the person confirmed it.
      const { block } = splitFrontmatter(content);
      const data = block === null ? {} : parseYamlBlock(block).data;
      if (okfStatus(data.status) === "stable") {
        const by = addedBy(root, rel) ?? fallbackHuman;
        if (by) hint = { by, at: isoFromDate(data.date) ?? isoFromDate(data.updated) };
      }
    }
    if (hint && hint.at === null) hint = { by: hint.by, at: changedAt ?? isoLocal() };
    const headData = before === undefined ? null : parseYamlBlock(splitFrontmatter(before).block ?? "").data;
    const headBy = headData && isMap(headData.generated) && typeof headData.generated.by === "string" ? headData.generated.by : undefined;
    const r = normalizePage(rel, content, { cfg, resolve: resolveLink, changedAt, actor, verifiedHint: hint, headBy });
    result.linksUnresolved += r.unresolvedLinks.length;
    if (!r.changes.length) continue;
    result.pagesChanged += 1;
    for (const c of r.changes) result.changes[c] = (result.changes[c] ?? 0) + 1;
    if (r.changes.includes("links")) {
      result.linksConverted += (content.match(/\[\[/g)?.length ?? 0) - (r.content.match(/\[\[/g)?.length ?? 0);
    }
    writes.push({ rel, content: r.content, mtime: repoFileMtime(root, `${WIKI_REL}/${rel}`) });
  }

  let logOut: string | null = null;
  if (logText !== null) {
    const converted = convertLog(logText, logIntro);
    result.logEntries = converted.entries;
    // A log without frontmatter predates the `type: Log` header; render it once to add one.
    const hasFrontmatter = splitFrontmatter(logText).block !== null;
    const wanted = isLegacyLog(logText) || !hasFrontmatter || checkLog(logRel, logText).length > 0;
    if (wanted && converted.lost) result.logKept = true; // never write a shorter log
    let next = wanted && !converted.lost ? converted.content : logText;
    // Log entries name the pages they touched; those names are links too (§9 entries are prose
    // with links), so they convert like any page's.
    const linked = convertWikilinks(next, logRel, resolveLink);
    next = linked.body;
    result.linksConverted += linked.converted;
    if (next !== logText) {
      logOut = next;
      result.logConverted = true;
    }
  } else {
    logOut = convertLog("", logIntro).content;
    result.logConverted = true;
  }
  result.coldIndexRemoved = repoFileExists(root, `${WIKI_REL}/${LEGACY_COLD_INDEX}`);

  if (!opts.commit) {
    // Index entries read frontmatter from disk, so a dry run counts listings against today's pages.
    const pendingIndexes = [...buildIndexes(root, cfg)].filter(([rel, c]) => readRepoFile(root, `${WIKI_REL}/${rel}`) !== c).length;
    result.indexesWritten = pendingIndexes;
    const nothing = !writes.length && !result.logConverted && !result.coldIndexRemoved && pendingIndexes === 0;
    return { ...result, verdict: nothing ? "conforms" : "planned" };
  }

  for (const w of writes) {
    writeRepoFile(root, `${WIKI_REL}/${w.rel}`, w.content);
    // Same knowledge, new form: keep the page's own mtime so "recent pages" still means recent.
    if (w.mtime !== null) setRepoFileMtime(root, `${WIKI_REL}/${w.rel}`, w.mtime);
  }
  if (logOut !== null) writeRepoFile(root, `${WIKI_REL}/${logRel}`, logOut);
  if (result.coldIndexRemoved) removeRepoFile(root, `${WIKI_REL}/${LEGACY_COLD_INDEX}`);
  result.indexesWritten = writeIndexes(root, cfg);
  ensureGitattributes(root);
  const nothing = !writes.length && !logOut && !result.coldIndexRemoved && result.indexesWritten === 0;
  return { ...result, verdict: nothing ? "conforms" : "applied" };
}

function ensureGitattributes(root: string): void {
  // Generated listings regenerate deterministically; a union merge is always repairable by the
  // next `llmwiki index`, a conflict marker in a listing is not.
  const line = "docs/wiki/**/index.md merge=union";
  const cur = readRepoFile(root, ".gitattributes");
  if (cur !== null && cur.split("\n").some((l) => l.trim() === line)) return;
  try {
    writeRepoFile(root, ".gitattributes", (cur ? (cur.endsWith("\n") ? cur : `${cur}\n`) : "") + `${line}\n`);
  } catch {
    /* bookkeeping only */
  }
}

// ---- conformance over a whole bundle ------------------------------------------------------

export type BundleReport = {
  okfVersion: string | null;
  concepts: number;
  conformant: number;
  edges: number;
  brokenEdges: number;
  tiers: Record<TrustTier, number>;
  stale: number;
  deprecated: number;
  types: Record<string, number>;
  issues: OkfIssue[];
};

const LINK = /\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g;

/**
 * Check any directory as an OKF bundle (§11) — a llmwiki wiki or a foreign bundle alike. Edge
 * counting mirrors Google's reference visualizer: relative `.md` links that resolve inside the
 * bundle are edges.
 */
export function checkBundle(bundleDir: string, opts: { exclude?: string[]; logName?: string } = {}): BundleReport {
  const dir = resolve(bundleDir);
  const exclude = new Set(opts.exclude ?? []);
  // A foreign bundle is read, never written, so plain filesystem reads (no repository boundary).
  const walk = (d: string, prefix: string, out: string[]): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${d}/${e.name}`, rel, out);
      else if (e.isFile() && isMarkdown(e.name)) out.push(rel);
    }
    return out;
  };
  const read = (rel: string): string | null => {
    try {
      return readFileSync(`${dir}/${rel}`, "utf-8");
    } catch {
      return null;
    }
  };
  const files = walk(dir, "", []).sort().filter((rel) => !exclude.has(rel.split("/")[0]!));
  const report: BundleReport = {
    okfVersion: declaredOkfVersion(read("index.md")),
    concepts: 0,
    conformant: 0,
    edges: 0,
    brokenEdges: 0,
    tiers: { unverified: 0, "machine-confirmed": 0, "human-reviewed": 0 },
    stale: 0,
    deprecated: 0,
    types: {},
    issues: [],
  };
  const present = new Set(files.map((f) => lookupKey(f)));
  for (const rel of files) {
    const content = read(rel);
    if (content === null) continue;
    const name = posix.basename(rel);
    if (name === "index.md") {
      report.issues.push(...checkIndex(rel, content, rel === "index.md"));
      continue;
    }
    if (name === "log.md" || (opts.logName && rel === opts.logName)) {
      report.issues.push(...checkLog(rel, content));
      continue;
    }
    report.concepts += 1;
    const issues = checkConcept(rel, content);
    report.issues.push(...issues);
    if (!issues.some((i) => i.severity === "error")) report.conformant += 1;
    const { block, body } = splitFrontmatter(content);
    const data = block === null ? {} : parseYamlBlock(block).data;
    report.tiers[trustTier(data)] += 1;
    if (isStale(data)) report.stale += 1;
    if (okfStatus(data.status) === "deprecated") report.deprecated += 1;
    const type = typeof data.type === "string" && data.type ? data.type : "(none)";
    report.types[type] = (report.types[type] ?? 0) + 1;
    const pageDir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
    for (const m of body.matchAll(LINK)) {
      const href = m[1]!;
      if (href.includes("://") || href.startsWith("/")) continue;
      report.edges += 1;
      let target: string;
      try {
        target = posix.normalize(posix.join(pageDir, decodeURIComponent(href)));
      } catch {
        target = posix.normalize(posix.join(pageDir, href));
      }
      if (!present.has(lookupKey(target))) report.brokenEdges += 1;
    }
  }
  return report;
}

