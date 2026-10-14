// Edit-time path rules — the decision that reaches the agent at the moment it touches the file.
//
// Measured before this existed (32 real Claude Code coding runs): agents never opened a wiki page
// and never ran `llmwiki search`; knowledge reached them only through hook injection. A decision
// kept as an L0 "Active rules" line was applied 8/8, the same decision living only in its page
// 0/8. L0 is size-bounded, so not every rule can live there. A rule whose scope is a set of code
// paths can instead ride on its own page and be delivered when an Edit/Write targets a matching
// file:
//
//   x-llmwiki: { applies_to: ["src/adapters/**"], rule: "외부 httpx 요청에 User-Agent: …" }
//
// The same delivery covers a file written through the Bash tool (`sed -i`, `python3 - <<EOF …
// open(p,'w')`, `cat > f`, …): bash-writes.ts decides from the command string alone whether it is
// a write and which paths it names, and only then does this module resolve and match them.
//
// `x-llmwiki` is an OKF producer-extension key (consumers must preserve it, okf.ts). `applies_to`
// globs are relative to the wiki root — the project directory that owns docs/wiki.
//
// Glob semantics (Bun.Glob, case-sensitive): a pattern containing `/` matches the whole
// repo-relative path (`src/adapters/**`, `packages/*/src/**/*.py`); a pattern without `/` matches
// the file NAME at any depth (`*.sql`, `Makefile`) — the .gitignore/.editorconfig convention a
// person writing one already expects. A trailing `/` means "everything under". `./` and a leading
// `/` are stripped (both mean the root here).
//
// Delivery (Claude Code PreToolUse, measured against code.claude.com/docs/en/hooks.md): only a
// `deny` decision's reason reaches the model BEFORE the tool runs; `additionalContext` arrives
// alongside the tool RESULT (after the edit), and an `allow` reason never reaches the model. So the
// default mode `gate` denies the first matching edit ONCE with the rules as the reason; the retry
// passes. `advise` never blocks (context after the fact); `off` is silence.
//
// The hook runs before every edit, so the hot path is: one walk + stat of docs/wiki, one small
// cache read, a handful of glob tests, and exclusive-create marker files for dedupe. Page bodies
// are parsed only when the wiki changed, and the config/YAML modules load only then (or when a
// rule is actually emitted) — measured: importing them costs more than the cached path itself.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LangCatalog } from "./config.ts";
import { readRepoDir, readRepoFile, repoDirExists } from "./repo-write.ts";

export const EDIT_RULE_KEY = "x-llmwiki";
/** One imperative line. Longer is a paragraph, which is a page's job, not an edit-time reminder's. */
export const RULE_MAX_CHARS = 300;
/** Per edit: the 1–3 rules that matter beat a wall the agent skims. */
export const MAX_RULES_PER_EDIT = 3;
/** Whole injected block, header included. */
export const MAX_EDIT_RULES_CHARS = 1200;

// 2: retirement widened to every okfStatus spelling and a bare `superseded_by` (okf.ts isRetired);
// the bump drops caches built under the narrower test.
const CACHE_VERSION = 2;
const CACHE_MAX_BYTES = 1024 * 1024;

// The file-editing tools whose `tool_input` names the target path, plus Bash (whose command is
// scanned for writes) — the PreToolUse matcher every installer writes. A tool-name regex, not an
// event-source list, so the SessionStart enumeration hazard (tests/hook-matcher-drift.test.ts)
// does not apply. One group, not two: install, uninstall and doctor keep handling exactly one entry.
export const EDIT_HOOK_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash";

export type EditRulesMode = "gate" | "advise" | "off";

export interface EditRule {
  readonly page: string; // repo-relative, docs/wiki/…
  readonly rule: string;
  readonly globs: readonly string[];
}

/** `LLMWIKI_EDIT_RULES=gate|advise|off`; anything else (including unset) is the default, gate. */
export function editRulesMode(): EditRulesMode {
  const v = (process.env.LLMWIKI_EDIT_RULES ?? "").trim().toLowerCase();
  return v === "advise" || v === "off" ? v : "gate";
}

// ---- shape ------------------------------------------------------------------------------

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Problems with a page's `x-llmwiki` value, for lint. Empty = valid or nothing to check: the
 * namespace may carry other producer keys later, so only the applies_to/rule pair is judged, and
 * only when one of the two is present.
 */
export function editRuleProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isMap(value)) return [`\`${EDIT_RULE_KEY}\` must be a mapping ({ applies_to, rule })`];
  if (value.applies_to === undefined && value.rule === undefined) return [];
  const out: string[] = [];
  const globs = value.applies_to;
  if (!Array.isArray(globs) || globs.length === 0 || !globs.every((g) => typeof g === "string" && g.trim() !== "")) {
    out.push("`applies_to` must be a non-empty list of repo-relative glob strings");
  }
  const rule = value.rule;
  if (typeof rule !== "string" || !rule.trim()) out.push("`rule` must be a non-empty string (one imperative line)");
  else if (rule.trim().length > RULE_MAX_CHARS) out.push(`\`rule\` is ${rule.trim().length} chars — keep it ≤ ${RULE_MAX_CHARS} (one line; detail stays in the page)`);
  return out;
}

/** The rule a page declares, or null when it declares none or an unusable one. */
function ruleOf(page: string, data: Record<string, unknown>): EditRule | null {
  const value = data[EDIT_RULE_KEY];
  if (!isMap(value) || editRuleProblems(value).some((p) => !p.startsWith("`rule` is "))) return null;
  // Over-long is a lint warning, not a reason to withhold the rule: deliver it, cut to the budget.
  let rule = String(value.rule).trim().replace(/\s+/g, " ");
  if (rule.length > RULE_MAX_CHARS) rule = `${rule.slice(0, RULE_MAX_CHARS - 1)}…`;
  return { page, rule, globs: (value.applies_to as string[]).map((g) => g.trim()) };
}

// ---- glob + path ------------------------------------------------------------------------

export function globMatches(glob: string, rel: string): boolean {
  let g = glob.trim().replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (g.endsWith("/")) g += "**";
  if (!g) return false;
  if (!g.includes("/")) g = `**/${g}`;
  try {
    return new Bun.Glob(g).match(rel);
  } catch {
    return false; // an unparseable pattern matches nothing — it never breaks the edit
  }
}

/** realpath of the deepest existing ancestor, with the rest re-appended (a Write target may not exist yet). */
function realDeep(path: string): string {
  let cur = path;
  const rest: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return path;
      rest.push(basename(cur));
      cur = parent;
    }
  }
  return path;
}

function inside(root: string, file: string): string | null {
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * `file` (absolute, or relative to `cwd`) as a `/`-separated path relative to `root`, or null when
 * it lies outside. Tried as given first, then canonicalized: macOS hands sessions `/var/…` and
 * `/tmp/…` while git answers `/private/…`, and the two spellings must not decide whether a rule
 * applies.
 */
export function repoRelativePath(root: string, file: string, cwd: string = root): string | null {
  if (!file) return null;
  const abs = resolve(cwd, file);
  return inside(resolve(root), abs) ?? inside(realDeep(resolve(root)), realDeep(abs));
}

/** Files one expansion may contribute — a fallback candidate must not turn into a repo walk. */
const EXPAND_CAP = 200;

/**
 * Shell-command targets (bash-writes.ts) as absolute paths: `~`/`$HOME` and `$PWD` expanded (an
 * agent writing `cd "$PWD"; python3 - <<EOF … open("$PWD/src/x.py","w")` was measured slipping
 * past every rule while the literal `$PWD/…` stayed unmatched), a glob
 * (`src/adapters/*.py`) and an existing directory (`find src/adapters | xargs sed -i …`) expanded
 * to the files under it, each capped. Runs only after the command was judged a write.
 */
export function expandBashTargets(targets: readonly string[], cwd: string): string[] {
  const home = process.env.HOME ?? "";
  const out = new Set<string>();
  const scan = (base: string, pattern: string): void => {
    let n = 0;
    try {
      for (const f of new Bun.Glob(pattern).scanSync({ cwd: base, onlyFiles: true, absolute: true })) {
        out.add(f);
        if (++n >= EXPAND_CAP) break;
      }
    } catch {
      /* missing base → nothing */
    }
  };
  for (const raw of targets) {
    const h = home ? raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home) : raw;
    const t = h.replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\))(?=\/|$)/, cwd);
    const parts = t.split("/");
    const g = parts.findIndex((p) => /[*?[{]/.test(p));
    if (g >= 0) {
      scan(resolve(cwd, parts.slice(0, g).join("/") || (t.startsWith("/") ? "/" : ".")), parts.slice(g).join("/"));
      continue;
    }
    const abs = resolve(cwd, t);
    out.add(abs);
    try {
      if (lstatSync(abs).isDirectory()) scan(abs, "**/*");
    } catch {
      /* a file not written yet */
    }
  }
  return [...out];
}

// ---- loading (cached) -------------------------------------------------------------------
//
// The cache is one private file per wiki root in the OS tmpdir, not the project state directory.
// Measured on a linked worktree (the author's daily layout): locating project state costs a `git`
// spawn (~16 ms) — more than parsing the whole 158-page wiki it would save (~4 ms warm). Because
// the cache's CONTENT is injected into the agent, a planted file must never be read: it is opened
// without following links and accepted only as a regular file owned by this user with no
// group/other bits. Anything else is ignored and the wiki is parsed again — still correct.

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

function cachePath(root: string): string {
  const h = createHash("sha1").update(resolve(root)).digest("hex").slice(0, 16);
  return join(tmpdir(), `llmwiki-editrules-cache-${h}.json`);
}

function readPrivate(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || st.size > CACHE_MAX_BYTES) return null;
    if (uid !== null && (st.uid !== uid || (st.mode & 0o077) !== 0)) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${randomUUID()}`;
  try {
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, content, "utf-8");
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path); // replaces a planted link itself, never writes through it
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing left behind */
    }
  }
}

interface WikiScan {
  readonly sig: string;
  readonly pages: readonly string[]; // relative to docs/wiki
}

/** docs/wiki pages, listed through the repository boundary (symlinked entries never followed). */
function listPages(root: string, rel = "docs/wiki", prefix = "", out: string[] = []): string[] {
  for (const e of readRepoDir(root, rel)) {
    if (e.name.startsWith(".")) continue;
    const child = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) listPages(root, `${rel}/${e.name}`, child, out);
    else if (e.isFile && e.name.endsWith(".md")) out.push(child);
  }
  return out;
}

/**
 * Every page with its mtime and size, hashed: renames, edits, adds and deletes all change it.
 * Metadata only, via lstat on entries the boundary already listed as real files — per-file
 * `repoFileMetadata` measured ~6 ms on 158 pages against ~0.5 ms here, on every edit.
 */
function scanWiki(root: string): WikiScan | null {
  if (!repoDirExists(root, "docs/wiki")) return null;
  const names = listPages(root).sort();
  const wiki = join(root, "docs", "wiki");
  const h = createHash("sha1").update(`v${CACHE_VERSION}\n${resolve(root)}\n`);
  const pages: string[] = [];
  for (const rel of names) {
    try {
      const st = lstatSync(join(wiki, rel));
      if (!st.isFile()) continue;
      pages.push(rel);
      h.update(`${rel}\0${st.mtimeMs}\0${st.size}\n`);
    } catch {
      /* vanished mid-scan */
    }
  }
  return { sig: h.digest("hex"), pages };
}

async function parseRules(root: string, pages: readonly string[]): Promise<EditRule[]> {
  const [{ getConfig }, { isRetired, parseYamlBlock, splitFrontmatter }] = await Promise.all([
    import("./config.ts"),
    import("./okf.ts"),
  ]);
  // The human-judgment queue holds unconfirmed items and the quiz layer is the person's own
  // memory; neither is a confirmed project rule.
  let skip: string[] = [];
  try {
    const cfg = getConfig(root);
    skip = [cfg.queueDir, cfg.quizDir].filter(Boolean).map((d) => `${d}/`);
  } catch {
    /* no config → nothing skipped */
  }
  const out: EditRule[] = [];
  for (const rel of pages) {
    if (skip.some((d) => rel.startsWith(d))) continue;
    // Content only through the repository boundary (containment + symlink refusal); YAML only for
    // a page that names the key.
    const text = readRepoFile(root, `docs/wiki/${rel}`);
    if (text === null || !text.includes(EDIT_RULE_KEY)) continue;
    const { block } = splitFrontmatter(text);
    if (block === null || !block.includes(EDIT_RULE_KEY)) continue;
    const { data } = parseYamlBlock(block);
    if (isRetired(data)) continue; // retired knowledge is never pushed
    const rule = ruleOf(`docs/wiki/${rel}`, data);
    if (rule) out.push(rule);
  }
  // Newest decision first: dated filenames sort by date, and a later rule is the likelier one.
  return out.sort((a, b) => (a.page < b.page ? 1 : a.page > b.page ? -1 : 0));
}

/** All rules the wiki at `root` declares, from the cache when the wiki has not changed. */
export async function loadEditRules(root: string): Promise<EditRule[]> {
  const scan = scanWiki(root);
  if (!scan) return [];
  const path = cachePath(root);
  try {
    const raw = readPrivate(path);
    if (raw) {
      const cached = JSON.parse(raw) as { v?: number; sig?: string; rules?: EditRule[] };
      if (cached.v === CACHE_VERSION && cached.sig === scan.sig && Array.isArray(cached.rules)) return cached.rules;
    }
  } catch {
    /* unreadable cache → rebuild */
  }
  const rules = await parseRules(root, scan.pages);
  writePrivate(path, JSON.stringify({ v: CACHE_VERSION, sig: scan.sig, rules }));
  return rules;
}

/** Rules whose globs match `rel` (repo-relative, `/`-separated), newest page first. */
export async function rulesFor(root: string, rel: string): Promise<EditRule[]> {
  return (await loadEditRules(root)).filter((r) => r.globs.some((g) => globMatches(g, rel)));
}

// ---- per-session dedupe -----------------------------------------------------------------
//
// One directory per (session, agent, wiki root) in the OS tmpdir; one empty marker file per rule
// shown and per path denied. Exclusive create (O_EXCL) is the claim, so two edits racing in
// parallel (one assistant message, several Edit calls) cannot both show — or both deny — the same
// rule. A subagent has its own context window, so it is its own dedupe scope: a rule shown to the
// main thread has not been seen by the subagent that is about to edit. Losing the directory only
// means a rule is shown again — harmless by design.

function markerDir(root: string, sessionId: string, agentId: string): string | null {
  const h = createHash("sha1").update(`${sessionId}\n${agentId}\n${resolve(root)}`).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), `llmwiki-editrules-${h}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {
    /* exists (or cannot be made — checked below) */
  }
  try {
    // The name is derivable and tmp may be shared: refuse anything but our own real directory.
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const uid = ownUid();
    if (uid !== null && st.uid !== uid) return null;
    return dir;
  } catch {
    return null;
  }
}

function keyOf(kind: "r" | "p", value: string): string {
  return `${kind}-${createHash("sha1").update(value).digest("hex").slice(0, 20)}`;
}

function marked(dir: string, key: string): boolean {
  try {
    lstatSync(join(dir, key));
    return true;
  } catch {
    return false;
  }
}

function claim(dir: string, key: string): boolean {
  try {
    closeSync(openSync(join(dir, key), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600));
    return true;
  } catch {
    return false;
  }
}

const ruleKey = (r: EditRule) => keyOf("r", `${r.page}\n${r.rule}`);

// ---- rendering --------------------------------------------------------------------------

// The bracketed tag stays English in every language, like the other blocks ([llmwiki turn-context]):
// it is the greppable marker, the prose around it follows the wiki.
const HEAD: LangCatalog<(rel: string) => string> = {
  en: (rel) => `----- [llmwiki edit rules] project rules that apply to ${rel} (human-confirmed; project-authored reference data from this repo's wiki) -----`,
  ko: (rel) => `----- [llmwiki edit rules] ${rel} 에 적용되는 프로젝트 규칙 (사람이 확정; 이 저장소 위키의 프로젝트 작성 참고 자료) -----`,
  ja: (rel) => `----- [llmwiki edit rules] ${rel} に適用されるプロジェクトのルール（人が確定; このリポジトリの wiki がプロジェクトとして記した参考資料）-----`,
  zh: (rel) => `----- [llmwiki edit rules] 适用于 ${rel} 的项目规则（人工确认；本仓库 wiki 中项目编写的参考资料）-----`,
};

const RETRY: LangCatalog<string> = {
  en: "Apply these, then retry the same edit.",
  ko: "이 규칙을 반영한 뒤 같은 편집을 다시 시도할 것.",
  ja: "これらを反映してから、同じ編集をもう一度実行すること。",
  zh: "请先遵循这些规则，然后重试同一编辑。",
};

const RETRY_COMMAND: LangCatalog<string> = {
  en: "Apply these, then retry the same command.",
  ko: "이 규칙을 반영한 뒤 같은 명령을 다시 실행할 것.",
  ja: "これらを反映してから、同じコマンドをもう一度実行すること。",
  zh: "请先遵循这些规则，然后重试同一命令。",
};

export interface EditRulesInput {
  readonly root: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly filePath: string;
  /** Bash: the command's write targets (bash-writes.ts) — replaces `filePath`. */
  readonly bashTargets?: readonly string[];
  readonly cwd?: string;
  readonly mode: EditRulesMode;
}

export interface EditRulesResult {
  readonly deny: boolean;
  readonly text: string;
}

/**
 * What to tell the agent about the edit it is about to make, or null for silence. Marks what it
 * returns as shown — the caller must deliver it. Fail-safe: any error is silence (the edit runs).
 */
export async function buildEditRules(input: EditRulesInput): Promise<EditRulesResult | null> {
  try {
    if (input.mode === "off" || !input.sessionId) return null; // no session → no dedupe → never gate
    const cwd = input.cwd ?? input.root;
    const targets = input.bashTargets ? expandBashTargets(input.bashTargets, cwd) : [input.filePath];
    const rels = [...new Set(targets.map((t) => repoRelativePath(input.root, t, cwd)).filter((r): r is string => !!r))];
    if (!rels.length) return null;
    const hit = new Set<string>(); // the targets some rule applies to — the header and the deny key
    const matched = (await loadEditRules(input.root)).filter((r) => {
      let any = false;
      for (const rel of rels) {
        if (r.globs.some((g) => globMatches(g, rel))) {
          hit.add(rel);
          any = true;
        }
      }
      return any;
    });
    if (!matched.length) return null;
    const dir = markerDir(input.root, input.sessionId, input.agentId ?? "");
    if (!dir) return null;
    const fresh = matched.filter((r) => !marked(dir, ruleKey(r)));
    if (!fresh.length) return null;

    const { pickLangValue, resolveWikiLang } = await import("./config.ts");
    const lang = resolveWikiLang(input.root);
    const shown = [...hit];
    const head = pickLangValue(HEAD, lang)(shown.length > 3 ? `${shown.slice(0, 3).join(", ")}, …` : shown.join(", "));
    const tail = pickLangValue(input.bashTargets ? RETRY_COMMAND : RETRY, lang);
    const lines: string[] = [];
    let size = head.length + 1 + tail.length;
    for (const r of fresh) {
      if (lines.length >= MAX_RULES_PER_EDIT) break;
      const line = `- ${r.rule} — ${r.page}`;
      // The first rule always fits (a 300-char rule under a long path is still one rule); the
      // rest stay unshown and surface on a later matching edit.
      if (lines.length && size + line.length + 1 > MAX_EDIT_RULES_CHARS) break;
      if (!claim(dir, ruleKey(r))) continue; // a parallel edit just showed it
      lines.push(line);
      size += line.length + 1;
    }
    if (!lines.length) return null;
    // Never deny the same path twice: rules left over after a gate (past the cap) ride along as
    // after-the-fact context on the retry instead of blocking it again. Every hit path is claimed
    // (map, not some — no short-circuit), so a command retried as-is is never denied again.
    const deny = input.mode === "gate" && shown.map((rel) => claim(dir, keyOf("p", rel))).some(Boolean);
    const text = [head, ...lines, ...(deny ? [tail] : [])].join("\n");
    return { deny, text };
  } catch {
    return null;
  }
}
