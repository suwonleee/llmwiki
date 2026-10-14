import { parseYamlBlock, splitFrontmatter, isoFromDate, isStale, trustTier, type TrustTier, type YamlMap } from "./okf.ts";

export const KNOWLEDGE_STATUSES = ["draft", "ready", "superseded"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_TIERS = ["hot", "warm", "cold", "protected"] as const;
export type KnowledgeTier = (typeof KNOWLEDGE_TIERS)[number];

export type FrontmatterValue = string | readonly string[];

export type Frontmatter = {
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
  /** The YAML mapping as parsed (nested values intact) — OKF `generated`, `verified`, `sources`. */
  readonly data: Readonly<YamlMap>;
  /** Set when the block is not valid YAML; the fields then come from the tolerant line reader. */
  readonly yamlError: string | null;
  /** OKF `type` as declared, or null. */
  readonly type: string | null;
  /** Legacy `domain:` as declared, or null (an OKF page carries `type` instead). */
  readonly domain: string | null;
  readonly trust: TrustTier;
  /** OKF `stale_after` has passed. */
  readonly stale: boolean;
  readonly title: string | null;
  readonly description: string | null;
  readonly date: string | null;
  readonly tags: readonly string[];
  readonly keywords: readonly string[];
  readonly status: KnowledgeStatus | null;
  readonly tier: KnowledgeTier | null;
};

// Python str.title(): capitalize the first letter of each alphabetic run, lower the rest.
// Non-alpha (digits, Hangul, spaces) are word boundaries; Hangul has no case → unchanged.
function titleCase(value: string): string {
  return value.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * The title a document claims for itself, with its filename as the fallback.
 *
 * One rule for every consumer: a page's own `title:` is the label the human wrote and the one
 * every surface should show; the filename-derived form is what remains for pages (and source
 * files) that declare nothing. The filename derivation is byte-stable with the pre-frontmatter
 * behavior, so an index only changes where a page actually declares a title.
 */
export function resolveDocumentTitle(
  frontmatter: { readonly title?: string | null } | null,
  relativePath: string,
): string {
  const declared = frontmatter?.title;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  const name = relativePath.split("/").pop() ?? relativePath;
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return titleCase(stem.replace(/-/g, " ").replace(/_/g, " ").trim());
}

function scalarField(fields: Readonly<Record<string, FrontmatterValue>>, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function parseDate(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? value
    : null;
}

// The engine's three lifecycle states. OKF spells two of them differently on disk (`stable`,
// `deprecated`); both spellings read the same so a migrated wiki and a legacy one index alike.
function parseKnowledgeStatus(value: string | null): KnowledgeStatus | null {
  switch (value) {
    case "draft":
    case "ready":
    case "superseded":
      return value;
    case "stable":
      return "ready";
    case "deprecated":
      return "superseded";
    default:
      return null; // migration maps other spellings (okfStatus); reading never guesses
  }
}

function parseKnowledgeTier(value: string | null): KnowledgeTier | null {
  switch (value) {
    case "hot":
    case "warm":
    case "cold":
    case "protected":
      return value;
    default:
      return null;
  }
}

function frontmatterBlock(content: string): string | null {
  const start = content.startsWith("---\r\n") ? 5 : content.startsWith("---\n") ? 4 : -1;
  if (start === -1) return null;
  const end = content.indexOf("\n---", start);
  if (end === -1) return null;
  const next = content[end + 4];
  if (next !== undefined && next !== "\n" && next !== "\r") return null;
  return content.slice(start, end).replace(/^\r?\n+|\r?\n+$/g, "");
}

/**
 * Insert `marker` immediately AFTER a page's YAML frontmatter — or at the very top when the page
 * declares none.
 *
 * The harness wirings stamp an ownership marker into every page they generate, and that marker
 * must land BELOW the frontmatter: a file that no longer opens with `---` is not a skill, it is a
 * markdown file the harness refuses. Both wirings used to locate the boundary with
 * `indexOf("\n---\n")`, which silently misses a CRLF source — and Git for Windows checks out CRLF
 * by default. The fallback branch then prepended the marker, so on native Windows Codex rejected
 * all five skills ("missing YAML frontmatter delimited by ---") while doctor still called them
 * present. Accepting `\r\n` is the whole fix; output on LF input is byte-identical.
 */
export function insertAfterFrontmatter(body: string, marker: string): string {
  const open = body.startsWith("---\r\n") ? 5 : body.startsWith("---\n") ? 4 : -1;
  if (open === -1) return marker + body;
  // A `---` only closes the block when it ends its own line, so keep looking past `----`, a
  // horizontal rule inside a value, and anything else that merely starts with three dashes.
  for (let at = body.indexOf("\n---", open - 1); at !== -1; at = body.indexOf("\n---", at + 1)) {
    const after = at + 4;
    if (body.startsWith("\r\n", after)) return body.slice(0, after + 2) + marker + body.slice(after + 2);
    if (body.startsWith("\n", after)) return body.slice(0, after + 1) + marker + body.slice(after + 1);
    if (after === body.length) return body + marker;
  }
  return marker + body;
}

function flatValue(value: unknown): FrontmatterValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.filter((v) => v !== null && v !== undefined && typeof v !== "object").map((v) => String(v)).filter((v) => v.length > 0));
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Every key as a string or string list — the shape the engine's readers were written against.
// Nested OKF values (`generated`, `verified`, `sources`) stay available, intact, on `data`.
function flatFields(data: YamlMap): Readonly<Record<string, FrontmatterValue>> {
  const fields: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(data)) fields[key] = flatValue(value);
  return Object.freeze(fields);
}

function generatedDate(data: YamlMap): string | null {
  const g = data.generated;
  if (typeof g !== "object" || g === null || Array.isArray(g)) return null;
  const at = (g as YamlMap).at;
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}/.test(at) && isoFromDate(at) !== null ? at.slice(0, 10) : null;
}

function listField(fields: Readonly<Record<string, FrontmatterValue>>, key: string): readonly string[] {
  const value = fields[key];
  if (value === undefined) return Object.freeze([]);
  return typeof value === "string" ? Object.freeze([value]) : value;
}

export function parseFrontmatter(content: string): Frontmatter {
  const block = frontmatterBlock(content) ?? (content.startsWith("---") ? splitFrontmatter(content).block : null);
  const parsed = block === null ? { data: {} as YamlMap, error: null } : parseYamlBlock(block);
  const fields = flatFields(parsed.data);
  return Object.freeze({
    fields,
    data: Object.freeze({ ...parsed.data }),
    yamlError: parsed.error,
    type: scalarField(fields, "type"),
    domain: scalarField(fields, "domain"),
    trust: trustTier(parsed.data),
    stale: isStale(parsed.data),
    title: scalarField(fields, "title"),
    description: scalarField(fields, "description"),
    date:
      parseDate(scalarField(fields, "date")) ??
      parseDate(scalarField(fields, "updated")) ??
      parseDate(generatedDate(parsed.data)),
    tags: listField(fields, "tags"),
    keywords: listField(fields, "keywords"),
    status: parseKnowledgeStatus(scalarField(fields, "status")),
    tier: parseKnowledgeTier(scalarField(fields, "tier")),
  });
}
