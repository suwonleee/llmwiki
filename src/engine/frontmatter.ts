export const KNOWLEDGE_STATUSES = ["draft", "ready", "superseded"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_TIERS = ["hot", "warm", "cold", "protected"] as const;
export type KnowledgeTier = (typeof KNOWLEDGE_TIERS)[number];

export type FrontmatterValue = string | readonly string[];

export type Frontmatter = {
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
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

function stripQuotes(value: string): string {
  return value.replace(/^['"]+|['"]+$/g, "");
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

function parseKnowledgeStatus(value: string | null): KnowledgeStatus | null {
  switch (value) {
    case "draft":
    case "ready":
    case "superseded":
      return value;
    default:
      return null;
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

function parseFields(block: string | null): Readonly<Record<string, FrontmatterValue>> {
  const fields: Record<string, FrontmatterValue> = {};
  if (block === null) return Object.freeze(fields);
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    if (!key || key.startsWith("#")) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const items = raw
        .slice(1, -1)
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter((item) => item.length > 0);
      fields[key] = Object.freeze(items);
    } else {
      fields[key] = stripQuotes(raw);
    }
  }
  return Object.freeze(fields);
}

function listField(fields: Readonly<Record<string, FrontmatterValue>>, key: string): readonly string[] {
  const value = fields[key];
  if (value === undefined) return Object.freeze([]);
  return typeof value === "string" ? Object.freeze([value]) : value;
}

export function parseFrontmatter(content: string): Frontmatter {
  const fields = parseFields(frontmatterBlock(content));
  return Object.freeze({
    fields,
    title: scalarField(fields, "title"),
    description: scalarField(fields, "description"),
    date: parseDate(scalarField(fields, "date")) ?? parseDate(scalarField(fields, "updated")),
    tags: listField(fields, "tags"),
    keywords: listField(fields, "keywords"),
    status: parseKnowledgeStatus(scalarField(fields, "status")),
    tier: parseKnowledgeTier(scalarField(fields, "tier")),
  });
}
