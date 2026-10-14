// Open Knowledge Format (OKF v0.2) — the on-disk contract of a llmwiki wiki.
//
// `docs/wiki/` is an OKF bundle: a directory of markdown concepts with YAML frontmatter, a
// `type` on every concept, reserved `index.md` (progressive-disclosure listing) and `log.md`
// (dated history, newest first), standard markdown links between concepts, and per-claim
// footnotes keyed to a `sources[].id`. Any OKF consumer — Google's reference visualizer, a
// search index, another agent — can read the wiki without llmwiki; llmwiki in turn reads any
// conformant bundle. Spec: github.com/GoogleCloudPlatform/open-knowledge-format (SPEC.md).
//
// llmwiki's own conventions (categories, review gate, `date`, `tier`, `superseded_by`, the
// excerpt line under a footnote) ride on top as producer extensions, which OKF explicitly
// allows and consumers must preserve.
//
// This module is pure: text in, text out. File walking and writing live in okf-bundle.ts.

import { dirname, posix } from "node:path";

export const OKF_VERSION = "0.2";
export const OKF_STATUSES = ["draft", "stable", "deprecated"] as const;
export type OkfStatus = (typeof OKF_STATUSES)[number];

export type YamlMap = Record<string, unknown>;

// ---- YAML frontmatter ---------------------------------------------------------------------

type BunYaml = { parse(text: string): unknown };

function bunYaml(): BunYaml | null {
  const y = (globalThis as { Bun?: { YAML?: BunYaml } }).Bun?.YAML;
  return y && typeof y.parse === "function" ? y : null;
}

/** The text between the opening `---` and the closing `---`, plus where the body starts. */
export function splitFrontmatter(content: string): { block: string | null; body: string } {
  const start = content.startsWith("---\r\n") ? 5 : content.startsWith("---\n") ? 4 : -1;
  if (start === -1) return { block: null, body: content };
  // The closing fence may directly follow the opening one (an empty block).
  if (content.startsWith("---", start) && /^---[ \t]*(\r?\n|$)/.test(content.slice(start))) {
    const after = content.slice(start).replace(/^---[ \t]*(\r?\n)?/, "");
    return { block: "", body: after };
  }
  const re = /\r?\n---[ \t]*(\r?\n|$)/g;
  re.lastIndex = start - 1;
  const m = re.exec(content);
  if (!m) return { block: null, body: content };
  return { block: content.slice(start, m.index), body: content.slice(m.index + m[0].length) };
}

/**
 * Parse a frontmatter block as YAML (YAML 1.2 core: timestamps stay strings).
 *
 * `error` is set when the block is not valid YAML — such a page is not OKF-conformant (§11.1),
 * but the engine still needs its title and tags, so `data` then falls back to the historical
 * line-oriented reading. Without a YAML parser in the runtime (Bun < 1.2.21) the line reader is
 * the only reader and `error` stays null.
 */
export function parseYamlBlock(block: string): { data: YamlMap; error: string | null } {
  const yaml = bunYaml();
  if (yaml === null) return { data: parseLegacyBlock(block), error: null };
  try {
    const parsed = block.trim() === "" ? {} : yaml.parse(block);
    if (parsed === null || parsed === undefined) return { data: {}, error: null };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: parseLegacyBlock(block), error: "frontmatter is not a YAML mapping" };
    }
    return { data: restoreHashes(parsed as YamlMap, block), error: null };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 160);
    return { data: parseLegacyBlock(block), error: message || "invalid YAML" };
  }
}

// Keys whose values are vocabulary, where a trailing ` # note` really is a comment.
const ENUM_KEYS = new Set(["type", "status", "tier", "date", "updated", "okf_version"]);

/**
 * Undo YAML's ` #` comment rule for free-text values. In YAML, `title: PR #15 merged` is the
 * title `PR` plus a comment — but every pre-OKF page was written for a reader that kept the whole
 * line, and a conversion that re-emits the parsed value would cut the title on disk. Where the
 * line reader saw `<parsed value> #…`, the line reader's value is the author's.
 */
function restoreHashes(data: YamlMap, block: string): YamlMap {
  if (!/\s#/.test(block)) return data;
  const legacy = parseLegacyBlock(block);
  const out: YamlMap = { ...data };
  for (const [key, value] of Object.entries(data)) {
    const full = legacy[key];
    if (ENUM_KEYS.has(key) || typeof full !== "string") continue;
    const head = value === null || value === undefined ? "" : typeof value === "string" ? value : null;
    if (head === null || full === head || !full.startsWith(head)) continue;
    const rest = full.slice(head.length);
    // `title: #2 …` parses as an empty value plus a comment; `title: PR #15` as `PR` plus one.
    if (/^\s+#/.test(rest) || (head === "" && rest.startsWith("#"))) out[key] = full;
  }
  return out;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Split a flow collection body on top-level commas, respecting quotes and nesting. */
function splitFlow(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i]!;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function legacyValue(raw: string): unknown {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map(legacyValue);
  if (v.startsWith("{") && v.endsWith("}")) {
    const map: YamlMap = {};
    for (const part of splitFlow(v.slice(1, -1))) {
      const colon = part.indexOf(":");
      if (colon === -1) continue;
      map[part.slice(0, colon).trim()] = legacyValue(part.slice(colon + 1));
    }
    return map;
  }
  return unquote(v);
}

/**
 * The tolerant reader: one `key: value` per top-level line (the value is everything after the
 * FIRST colon), inline `[a, b]` lists and `{ k: v }` maps, and indented `- item` / `k: v`
 * continuation lines. It reads the frontmatter llmwiki pages were written with before OKF — some
 * of which a strict YAML parser rejects (`title: "PASS"는 착각`, `title: 결론: 이렇다`) — without
 * losing a character of the value, so a migration can re-emit it as valid YAML.
 */
export function parseLegacyBlock(block: string): YamlMap {
  const data: YamlMap = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const raw = line.slice(colon + 1).trim();
    if (raw !== "") {
      data[key] = legacyValue(raw);
      continue;
    }
    // Indented continuation: a block list or a nested map.
    const child: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === "")) {
      i += 1;
      if (lines[i]!.trim()) child.push(lines[i]!);
    }
    if (!child.length) {
      data[key] = "";
      continue;
    }
    if (child[0]!.trim().startsWith("- ") || child[0]!.trim() === "-") {
      const items: unknown[] = [];
      let current: YamlMap | null = null;
      for (const c of child) {
        const t = c.trim();
        if (t.startsWith("-")) {
          const rest = t.slice(1).trim();
          const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rest);
          if (kv && !rest.startsWith("{")) {
            current = { [kv[1]!]: legacyValue(kv[2]!) };
            items.push(current);
          } else {
            current = null;
            items.push(legacyValue(rest));
          }
        } else if (current) {
          const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(t);
          if (kv) current[kv[1]!] = legacyValue(kv[2]!);
        }
      }
      data[key] = items;
    } else {
      const map: YamlMap = {};
      for (const c of child) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(c.trim());
        if (kv) map[kv[1]!] = legacyValue(kv[2]!);
      }
      data[key] = map;
    }
  }
  return data;
}

// Emission order: the OKF core fields first, as the spec's examples list them, then producer
// extensions in the order the page already had them, provenance last (it is the longest).
const KEY_ORDER = [
  "okf_version",
  "type",
  "title",
  "description",
  "resource",
  "date",
  "tags",
  "status",
  "stale_after",
  "generated",
  "verified",
];
const TAIL_KEYS = ["sources", "usage_window"];

const RESERVED_WORD = /^(true|false|yes|no|on|off|y|n|null|~)$/i;
const NUMBER_LIKE = /^[-+]?(\d[\d_]*\.?\d*|\.\d+)([eE][-+]?\d+)?$|^0x[0-9a-f]+$|^[-+]?\.(inf|nan)$/i;

function needsQuote(s: string, inFlow: boolean): boolean {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/[\n\r\t]/.test(s)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:\s|:$|\s#/.test(s)) return true;
  if (inFlow && /[,[\]{}]/.test(s)) return true;
  if (RESERVED_WORD.test(s) || NUMBER_LIKE.test(s)) return true;
  // YAML 1.1 readers (PyYAML — Google's reference parser) resolve these as numbers or reject them:
  // `9:30` → 570, `0b11` → 3, a bare `=` → ConstructorError. Quoting keeps them strings everywhere.
  if (/^[-+]?\d+(:[0-5]?\d)+(\.\d*)?$/.test(s) || /^[-+]?0[box]/i.test(s) || s === "=") return true;
  return false;
}

function emitScalar(v: unknown, inFlow: boolean): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  // A double-quoted JSON string is also a valid YAML double-quoted scalar.
  return needsQuote(s, inFlow) ? JSON.stringify(s) : s;
}

function isPlainObject(v: unknown): v is YamlMap {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function isFlat(v: unknown): boolean {
  if (Array.isArray(v)) return v.every((x) => !isPlainObject(x) && !Array.isArray(x));
  if (isPlainObject(v)) return Object.values(v).every((x) => !isPlainObject(x) && !Array.isArray(x));
  return true;
}

function emitFlow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => emitFlow(x)).join(", ")}]`;
  if (isPlainObject(v)) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${emitScalar(k, true)}: ${emitFlow(x)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return emitScalar(v, true);
}

function emitValue(key: string, v: unknown, indent: string): string[] {
  const k = `${indent}${emitScalar(key, false)}:`;
  if (Array.isArray(v)) {
    if (isFlat(v)) return [`${k} ${emitFlow(v)}`];
    const lines = [k];
    for (const item of v) {
      if (isPlainObject(item) && !isFlat(item)) {
        const entries = Object.entries(item).filter(([, x]) => x !== undefined);
        entries.forEach(([ik, iv], idx) => {
          const sub = emitValue(ik, iv, `${indent}    `);
          sub[0] = idx === 0 ? `${indent}  - ${sub[0]!.trimStart()}` : sub[0]!;
          lines.push(...sub);
        });
      } else {
        lines.push(`${indent}  - ${emitFlow(item)}`);
      }
    }
    return lines;
  }
  if (isPlainObject(v)) {
    if (isFlat(v)) return [`${k} ${emitFlow(v)}`];
    const lines = [k];
    for (const [ik, iv] of Object.entries(v)) {
      if (iv !== undefined) lines.push(...emitValue(ik, iv, `${indent}  `));
    }
    return lines;
  }
  return [`${k} ${emitScalar(v, false)}`];
}

/** Render a frontmatter mapping as YAML (no fences): OKF core keys first, valid by construction. */
export function renderYaml(data: YamlMap): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const head = KEY_ORDER.filter((k) => keys.includes(k));
  const tail = TAIL_KEYS.filter((k) => keys.includes(k));
  const middle = keys.filter((k) => !KEY_ORDER.includes(k) && !TAIL_KEYS.includes(k));
  return [...head, ...middle, ...tail].flatMap((k) => emitValue(k, data[k], "")).join("\n");
}

export function renderDocument(data: YamlMap, body: string): string {
  return `---\n${renderYaml(data)}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

// ---- type, status, time, actors -----------------------------------------------------------

/** `direction` → `Direction`, `current-state` → `Current State`. */
export function typeNameFor(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Comparison key for a type name: case, spaces, hyphens and underscores do not matter. */
export function typeKey(type: string): string {
  return type.toLowerCase().replace(/[\s_-]+/g, "");
}

/** An llmwiki or foreign status value as an OKF lifecycle status; unknown values → null. */
export function okfStatus(raw: unknown): OkfStatus | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (["stable", "ready", "done", "active", "accepted", "final"].includes(v)) return "stable";
  if (["draft", "proposed", "pending", "wip"].includes(v)) return "draft";
  if (["deprecated", "superseded", "historical", "archived", "obsolete", "retired"].includes(v)) return "deprecated";
  return null;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoDateTime(value: unknown): boolean {
  return typeof value === "string" && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value));
}

function offsetOf(d: Date): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** A local wall-clock instant as ISO 8601 with its explicit offset, to the second. */
export function isoLocal(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${offsetOf(d)}`
  );
}

/** A calendar date (`YYYY-MM-DD`) as the ISO instant of its local midnight; anything else → null. */
export function isoFromDate(value: unknown): string | null {
  const v = String(value ?? "").trim();
  if (isIsoDateTime(v)) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return null;
  return isoLocal(d);
}

export type TrustEvent = { by: string; at: string | null };

/** `verified` as a list — a bare `{ by, at }` mapping is a one-element list (§5.2). */
export function normalizeVerified(value: unknown): TrustEvent[] {
  const list = Array.isArray(value) ? value : isPlainObject(value) ? [value] : [];
  return list
    .filter(isPlainObject)
    .map((e) => ({ by: String(e.by ?? ""), at: e.at === undefined || e.at === null ? null : String(e.at) }));
}

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export function trustTier(data: YamlMap): TrustTier {
  const events = normalizeVerified(data.verified);
  if (!events.length) return "unverified";
  return events.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

/** `now >= stale_after`; a missing or offset-less value is never stale (§5.5). */
export function isStale(data: YamlMap, now: Date = new Date()): boolean {
  const raw = data.stale_after;
  if (!isIsoDateTime(raw)) return false;
  return now.getTime() >= Date.parse(String(raw));
}

// ---- footnotes and sources ----------------------------------------------------------------

const FENCE = /^(```|~~~)[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;

/** Blank out fenced and inline code, keeping offsets — example syntax is not structure. */
export function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text.replace(FENCE, blank).replace(INLINE_CODE, blank);
}

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*(.+)$/gm;

/** `[^label]: <file>` definitions: the label and the cited file (locators and link heads dropped). */
export function footnoteDefinitions(body: string): { id: string; resource: string }[] {
  const out: { id: string; resource: string }[] = [];
  const seen = new Set<string>();
  const masked = maskCode(body);
  for (const m of masked.matchAll(FOOTNOTE_DEF)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, resource: citationResource(m[2]!) });
  }
  return out;
}

function citationResource(text: string): string {
  let raw = text.trim().replace(/^\*+|\*+$/g, "");
  const link = /^\[([^\]]+)\]\(([^)]*)\)/.exec(raw);
  if (link) raw = link[2] || link[1]!;
  raw = raw.split(/\s+[-–—]\s+/, 1)[0]!.trim();
  raw = raw.replace(/,\s*p\.?\s*\d+\b.*$/, "").trim();
  return raw;
}

export type SourceEntry = YamlMap & { resource: string; id?: string };

/**
 * `sources` = what the page already declares + one entry per footnote label not yet declared.
 *
 * The footnote label IS the `id` (§5.1: the label is the join key, so attribution survives a
 * reordered list). A legacy page-level `source:` is folded in as an id-less entry when no footnote
 * already names it — `source: semantic-lint` is a scope descriptor, which OKF permits.
 */
export function mergeSources(existing: unknown, body: string, legacySource?: unknown): SourceEntry[] {
  const list: SourceEntry[] = [];
  const raw = Array.isArray(existing) ? existing : isPlainObject(existing) ? [existing] : [];
  for (const e of raw) {
    if (isPlainObject(e) && typeof e.resource === "string" && e.resource.trim()) list.push(e as SourceEntry);
    else if (typeof e === "string" && e.trim()) list.push({ resource: e.trim() });
  }
  const ids = new Set(list.map((e) => (e.id === undefined ? "" : String(e.id))));
  for (const def of footnoteDefinitions(body)) {
    if (ids.has(def.id) || !def.resource) continue;
    ids.add(def.id);
    list.push({ id: def.id, resource: def.resource });
  }
  const legacy = typeof legacySource === "string" ? legacySource.trim() : "";
  if (legacy && !list.some((e) => e.resource === legacy)) list.push({ resource: legacy });
  return list;
}

// ---- links --------------------------------------------------------------------------------

const WIKILINK = /(?<!!)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;

export type LinkTarget = { rel: string; title: string };

/** GitHub's heading anchor: lower-case, punctuation dropped, spaces → hyphens. */
export function headingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function escapeLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function hrefPath(path: string): string {
  return path.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** The relative href from the page at `fromRel` to `toRel` (both bundle-relative). */
export function relativeHref(fromRel: string, toRel: string): string {
  const fromDir = dirname(fromRel) === "." ? "" : dirname(fromRel);
  const rel = posix.relative(fromDir || ".", toRel);
  return hrefPath(rel || posix.basename(toRel));
}

/**
 * Link text for a page: its title up to the first ` — ` subtitle. Titles here run "subject —
 * finding"; the subject alone names the target, and the full title would double every link's
 * length in the always-injected L0 (measured: +24% on a 2 KB current-state).
 */
export function linkLabel(title: string): string {
  return title.split(/\s+[—–]\s+/)[0]!.trim();
}

/**
 * Rewrite Obsidian `[[target]]` / `[[target#heading|alias]]` links as standard relative markdown
 * links (§6.1) — the only link form an OKF consumer turns into a graph edge. Link text is the
 * alias, else the target's title. Code spans are left alone; a target that resolves to no page
 * stays a wikilink (a guessed path would be a broken link that lint calls an error).
 */
export function convertWikilinks(
  body: string,
  fromRel: string,
  resolve: (target: string) => LinkTarget | null,
): { body: string; converted: number; unresolved: string[] } {
  const masked = maskCode(body);
  let converted = 0;
  const unresolved: string[] = [];
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(WIKILINK)) {
    const at = m.index!;
    const target = m[1]!.trim();
    const anchor = m[2] ? m[2].slice(1).trim() : "";
    const alias = m[3]?.trim();
    const hit = target ? resolve(target) : null;
    if (!hit) {
      unresolved.push(target);
      continue;
    }
    const text = escapeLinkText(alias || linkLabel(hit.title) || posix.basename(hit.rel, ".md"));
    const href = relativeHref(fromRel, hit.rel) + (anchor ? `#${headingAnchor(anchor)}` : "");
    out += body.slice(last, at) + `[${text}](${href})`;
    last = at + m[0].length;
    converted += 1;
  }
  return { body: out + body.slice(last), converted, unresolved };
}

/**
 * Prose as a reader sees it: a markdown link counts as its text, not its href. Length budgets
 * measure reading load; counting `(../5_topic/a-long-file-name.md)` would make an OKF page — whose
 * links carry a relative path — trip a size warning its `[[wikilink]]` predecessor did not.
 */
export function linkTextOnly(text: string): string {
  return text.replace(/(?<!!)\[((?:[^\]\\]|\\.)*)\]\([^)\s]+\)/g, "$1");
}

export function countWikilinks(body: string): number {
  return [...maskCode(body).matchAll(WIKILINK)].length;
}

// ---- index.md -----------------------------------------------------------------------------

export type IndexEntry = { title: string; href: string; description: string };
export type IndexSection = { heading: string; entries: IndexEntry[] };

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** An `index.md` body (§8): `# Heading` sections of `* [Title](href) - description` lines. */
export function renderIndex(sections: IndexSection[], rootVersion = false): string {
  const parts: string[] = [];
  if (rootVersion) parts.push(`---\nokf_version: "${OKF_VERSION}"\n---\n`);
  for (const s of sections) {
    if (!s.entries.length) continue;
    const lines = [`# ${s.heading}`, ""];
    for (const e of s.entries) {
      const d = oneLine(e.description);
      lines.push(`* [${escapeLinkText(oneLine(e.title))}](${e.href})${d ? ` - ${d}` : ""}`);
    }
    parts.push(lines.join("\n") + "\n");
  }
  return parts.join("\n");
}

/** `okf_version` declared by a bundle-root `index.md`, or null. */
export function declaredOkfVersion(indexContent: string | null): string | null {
  if (indexContent === null) return null;
  const { block } = splitFrontmatter(indexContent);
  if (block === null) return null;
  const v = parseYamlBlock(block).data.okf_version;
  return v === undefined || v === null || v === "" ? null : String(v);
}

// ---- log.md -------------------------------------------------------------------------------

export type LogEntry = { date: string; kind: string; title: string; detail: string[] };

const LEGACY_HEADING = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*([^|\n]*?)\s*(?:\|\s*(.*))?$/;
const DATE_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
const OKF_ITEM = /^[*-]\s+\*\*([^*]+)\*\*:?\s*(.*)$/;

const legacyEntries = new WeakSet<LogEntry>();

/** Does this log use the pre-OKF `## [date] kind | title` headings? */
export function isLegacyLog(text: string): boolean {
  return text.split(/\r?\n/).some((l) => LEGACY_HEADING.test(l));
}

/** Entries of a log in either form, in file order. */
export function parseLog(text: string): LogEntry[] {
  const { body } = splitFrontmatter(text);
  const entries: LogEntry[] = [];
  const undated: LogEntry[] = []; // content seen before any date: dated by the next date found
  let date = "";
  let cur: LogEntry | null = null;
  const setDate = (d: string) => {
    date = d;
    for (const e of undated.splice(0)) e.date = d;
  };
  for (const line of body.split(/\r?\n/)) {
    const legacy = LEGACY_HEADING.exec(line);
    if (legacy) {
      setDate(legacy[1]!);
      cur = { date, kind: legacy[2]!.trim() || "update", title: (legacy[3] ?? "").trim(), detail: [] };
      legacyEntries.add(cur);
      entries.push(cur);
      continue;
    }
    const dated = DATE_HEADING.exec(line);
    if (dated) {
      setDate(dated[1]!);
      cur = null;
      continue;
    }
    if (/^#\s/.test(line)) {
      cur = null; // the log's own title
      continue;
    }
    if (/^##\s/.test(line)) {
      // A heading in neither form (`## Notes`, `## [2026-10-13 PM] …`) still owns the lines under
      // it: keep them as a note entry rather than let a re-render drop them.
      const d = /(\d{4}-\d{2}-\d{2})/.exec(line);
      if (d) setDate(d[1]!);
      cur = { date, kind: "note", title: line.replace(/^##\s+/, "").trim(), detail: [] };
      legacyEntries.add(cur);
      entries.push(cur);
      if (!date) undated.push(cur);
      continue;
    }
    const item = OKF_ITEM.exec(line);
    if (item && date && (cur === null || !isLegacyEntry(cur))) {
      cur = { date, kind: item[1]!.trim(), title: item[2]!.trim(), detail: [] };
      entries.push(cur);
      continue;
    }
    if (cur && line.trim()) cur.detail.push(line.replace(/^ {0,2}/, ""));
  }
  return entries;
}

/** The free text between a log's title and its first `##` group (its intro), frontmatter excluded. */
export function logPreamble(text: string): string {
  const lines: string[] = [];
  for (const line of splitFrontmatter(text).body.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break;
    if (/^#\s/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/** Non-blank content lines of a log (its title, intro and date headings excluded). */
export function logContentLines(text: string): number {
  const body = splitFrontmatter(text).body.split(/\r?\n/);
  const start = body.findIndex((l) => /^##\s/.test(l));
  if (start === -1) return 0;
  return body.slice(start).filter((l) => l.trim() && !DATE_HEADING.test(l)).length;
}

function isLegacyEntry(e: LogEntry): boolean {
  return legacyEntries.has(e);
}

function kindLabel(kind: string): string {
  const k = kind.trim() || "update";
  return k[0]!.toUpperCase() + k.slice(1);
}

function renderEntry(e: LogEntry): string[] {
  const lines = [`* **${kindLabel(e.kind)}**: ${e.title}`.trimEnd()];
  for (const d of e.detail) lines.push(`  ${d.trimEnd()}`);
  return lines;
}

/**
 * A log rendered per §9: one `## YYYY-MM-DD` group per date, newest date and entry first. The
 * intro rides in frontmatter (`type: Log`, as Google's sample bundle does): §9 allows only the
 * title and dated groups in the body, and a frontmatter-less log reads as an `Unknown` concept in
 * the reference viewer.
 */
export function renderLog(entries: LogEntry[], heading: string, intro: string): string {
  const order = entries.map((e, i) => ({ e, i, legacy: isLegacyEntry(e) }));
  // Newest date first. Within a day: a legacy log was appended oldest-first, so its entries
  // reverse; an OKF log is already newest-first, so its entries keep their order; a legacy entry
  // merged into an OKF log is newer than the conversion, so it leads.
  order.sort((a, b) => {
    if (a.e.date !== b.e.date) return a.e.date < b.e.date ? 1 : -1;
    if (a.legacy && b.legacy) return b.i - a.i;
    if (a.legacy !== b.legacy) return a.legacy ? -1 : 1;
    return a.i - b.i;
  });
  const parts = [`# ${heading}`, ""];
  order.forEach(({ e }, i) => {
    if (i === 0 || order[i - 1]!.e.date !== e.date) parts.push(`## ${e.date}`, "");
    parts.push(...renderEntry(e));
    if (i === order.length - 1 || order[i + 1]!.e.date !== e.date) parts.push("");
  });
  const meta: YamlMap = { type: LOG_TYPE, title: heading };
  if (intro.trim()) meta.description = intro.trim();
  return renderDocument(meta, parts.join("\n").replace(/\n+$/, "\n"));
}

/** The `type` a rendered log declares. */
export const LOG_TYPE = "Log";

/** A log's intro: its frontmatter `description`, else the free text above its first group. */
export function logIntro(text: string): string {
  const { block } = splitFrontmatter(text);
  const d = block === null ? undefined : parseYamlBlock(block).data.description;
  return typeof d === "string" && d.trim() ? d.trim() : logPreamble(text);
}

/**
 * Add one entry to an OKF log with a minimal diff: under today's heading when it is already the
 * newest group, else as a new group above the newest one. Concurrent branches then insert at the
 * same spot, which `merge=union` resolves by keeping both.
 */
export function insertLogEntry(text: string, entry: LogEntry, heading: string, intro: string): string {
  if (!text.trim()) return renderLog([entry], heading, intro);
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^##\s/.test(l));
  const block = renderEntry(entry);
  if (first === -1) {
    const body = text.replace(/\n*$/, "\n");
    return `${body}\n## ${entry.date}\n\n${block.join("\n")}\n`;
  }
  const dated = DATE_HEADING.exec(lines[first]!);
  if (dated && dated[1] === entry.date) {
    let at = first + 1;
    while (at < lines.length && lines[at]!.trim() === "") at += 1;
    lines.splice(at, 0, ...block);
    return lines.join("\n");
  }
  lines.splice(first, 0, `## ${entry.date}`, "", ...block, "");
  return lines.join("\n");
}

// ---- conformance (§11) --------------------------------------------------------------------

export type OkfIssue = { path: string; rule: string; severity: "error" | "warn"; message: string };

/** Per-concept conformance and soft-guidance checks for one non-reserved `.md` file. */
export function checkConcept(path: string, content: string): OkfIssue[] {
  const out: OkfIssue[] = [];
  const { block, body } = splitFrontmatter(content);
  const issue = (rule: string, severity: "error" | "warn", message: string) => out.push({ path, rule, severity, message });
  if (block === null) {
    issue("okf-frontmatter-missing", "error", "no YAML frontmatter block (OKF §11.1)");
    return out;
  }
  const { data, error } = parseYamlBlock(block);
  if (error) issue("okf-frontmatter-invalid", "error", `frontmatter is not valid YAML: ${error}`);
  if (typeof data.type !== "string" || !data.type.trim()) issue("okf-type-missing", "error", "frontmatter has no `type` (OKF §11.2)");
  if (data.status !== undefined && !OKF_STATUSES.includes(String(data.status) as OkfStatus)) {
    issue("okf-status", "warn", `status \`${String(data.status)}\` is not draft|stable|deprecated`);
  }
  const g = data.generated;
  if (g !== undefined) {
    if (!isPlainObject(g) || typeof g.by !== "string" || !g.by) issue("okf-actor", "warn", "`generated` needs a `by` actor");
    if (isPlainObject(g) && g.at !== undefined && !isIsoDateTime(g.at)) {
      issue("okf-timestamp", "warn", "`generated.at` is not an ISO 8601 datetime with an offset");
    }
  }
  for (const e of normalizeVerified(data.verified)) {
    if (!e.by) issue("okf-actor", "warn", "a `verified` event has no `by` actor");
    if (e.at !== null && !isIsoDateTime(e.at)) issue("okf-timestamp", "warn", "a `verified.at` is not an ISO 8601 datetime with an offset");
  }
  if (data.stale_after !== undefined && !isIsoDateTime(data.stale_after)) {
    issue("okf-timestamp", "warn", "`stale_after` is not an ISO 8601 datetime with an offset");
  }
  const ids = new Set(
    (Array.isArray(data.sources) ? data.sources : isPlainObject(data.sources) ? [data.sources] : [])
      .filter(isPlainObject)
      .map((s) => String(s.id ?? "")),
  );
  const missing = footnoteDefinitions(body).filter((d) => !ids.has(d.id)).map((d) => d.id);
  if (missing.length) {
    issue("okf-footnote-source", "warn", `footnote label(s) with no matching sources[].id: ${missing.slice(0, 5).join(", ")}`);
  }
  const wl = countWikilinks(body);
  if (wl) issue("okf-wikilink", "warn", `${wl} [[wikilink]](s) — OKF consumers only see standard markdown links`);
  return out;
}

/** Structure checks for a reserved `index.md` (§8). `root` permits the `okf_version` key. */
export function checkIndex(path: string, content: string, root: boolean): OkfIssue[] {
  const out: OkfIssue[] = [];
  const { block, body } = splitFrontmatter(content);
  if (block !== null) {
    const keys = Object.keys(parseYamlBlock(block).data);
    const extra = keys.filter((k) => !(root && k === "okf_version"));
    if (extra.length) {
      out.push({ path, rule: "okf-index-frontmatter", severity: "error", message: `index.md frontmatter may only carry okf_version (root): ${extra.join(", ")}` });
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!/^[*-]\s+\[[^\]]*(?:\\\][^\]]*)*\]\([^)]+\)/.test(t)) {
      out.push({ path, rule: "okf-index-entry", severity: "warn", message: `index line is not \`* [Title](href) - description\`: ${t.slice(0, 60)}` });
      break;
    }
  }
  return out;
}

/** Structure checks for a reserved `log.md` (§9): ISO date headings, newest first. */
export function checkLog(path: string, content: string): OkfIssue[] {
  const out: OkfIssue[] = [];
  const dates: string[] = [];
  let seenGroup = false;
  for (const line of splitFrontmatter(content).body.split(/\r?\n/)) {
    if (!seenGroup && line.trim() && !/^#{1,2}\s/.test(line)) {
      // §9: a log is the title and dated groups. An intro belongs in frontmatter `description`.
      out.push({ path, rule: "okf-log-content", severity: "error", message: `log has text outside a dated group: ${line.slice(0, 60)}` });
      return out;
    }
    if (!/^##\s/.test(line)) continue;
    seenGroup = true;
    const m = DATE_HEADING.exec(line);
    if (!m) {
      out.push({ path, rule: "okf-log-heading", severity: "error", message: `log heading is not \`## YYYY-MM-DD\`: ${line.slice(0, 60)}` });
      return out;
    }
    dates.push(m[1]!);
  }
  const dup = dates.find((d, i) => dates.indexOf(d) !== i);
  if (dup) {
    // Two branches that each opened today's group meet in a union merge as two equal headings.
    out.push({ path, rule: "okf-log-duplicate-date", severity: "warn", message: `log has more than one \`## ${dup}\` group` });
  }
  if (dates.some((d, i) => i > 0 && d > dates[i - 1]!)) {
    out.push({ path, rule: "okf-log-order", severity: "warn", message: "log date groups are not newest-first" });
  }
  return out;
}
