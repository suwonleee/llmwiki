import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, type Chunk } from "./chunker.ts";
import type { Frontmatter, KnowledgeTier } from "./frontmatter.ts";
import { stripCode, stripEvidence } from "./refs.ts";
import { writeRepoFile } from "./repo-write.ts";

export const COLD_INDEX_RELATIVE_PATH = "docs/wiki/cold-index.md";
const MAX_STRUCTURAL_LABELS = 24;

export type ColdIndexEntry = {
  readonly relativePath: string;
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly status: string | null;
};

export class ColdPageBodyMissingError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`cold wiki page body missing: ${relativePath}`);
    this.name = "ColdPageBodyMissingError";
    this.relativePath = relativePath;
  }
}

function clipped(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function coldIndexPath(root: string): string {
  return join(root, ...COLD_INDEX_RELATIVE_PATH.split("/"));
}

function boundedValues(values: readonly string[]): string {
  return clipped([...new Set(values.map((value) => value.trim()).filter(Boolean))].join(", "), 600);
}

function structuralLabels(content: string): { readonly headings: readonly string[]; readonly wikilinks: readonly string[] } {
  const headings: string[] = [];
  const wikilinks: string[] = [];
  const structured = stripCode(stripEvidence(content));
  for (const match of structured.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    if (headings.length >= MAX_STRUCTURAL_LABELS) break;
    headings.push(match[1]!);
  }
  for (const match of structured.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g)) {
    wikilinks.push(match[1]!);
    if (match[2] !== undefined && wikilinks.length < MAX_STRUCTURAL_LABELS) wikilinks.push(match[2]);
    if (wikilinks.length >= MAX_STRUCTURAL_LABELS) break;
  }
  return { headings, wikilinks };
}

export function isColdTier(tier: KnowledgeTier | null): boolean {
  return tier === "cold";
}

export type ColdDiscoveryInput = {
  readonly relativePath: string;
  readonly title: string;
  readonly metadata: Frontmatter;
  readonly sourceContent: string;
};

export function coldDiscoveryChunk(input: ColdDiscoveryInput): readonly Chunk[] {
  const labels = structuralLabels(input.sourceContent);
  const content = [
    `path: ${input.relativePath}`,
    `title: ${clipped(input.metadata.title ?? input.title, 240)}`,
    `description: ${clipped(input.metadata.description ?? "", 600)}`,
    `tags: ${clipped(input.metadata.tags.join(", "), 400)}`,
    `keywords: ${boundedValues(input.metadata.keywords)}`,
    `headings: ${boundedValues(labels.headings)}`,
    `wikilinks: ${boundedValues(labels.wikilinks)}`,
    `date: ${input.metadata.date ?? ""}`,
    `status: ${input.metadata.status ?? ""}`,
    "tier: cold",
  ].join("\n");
  return [{ index: 0, content, page: null, startChar: 0, tokenCount: estimateTokens(content), headerBreadcrumb: "Cold metadata" }];
}

export function readColdPageBody(root: string, relativePath: string): string {
  const path = join(root, ...relativePath.split("/"));
  if (!existsSync(path)) throw new ColdPageBodyMissingError(relativePath);
  return readFileSync(path, "utf-8");
}

export function writeColdIndex(root: string, entries: readonly ColdIndexEntry[]): void {
  const lines = [
    "---",
    "title: Cold Page Index",
    "description: Generated discovery metadata for cold wiki pages.",
    "tags: [generated, cold-index]",
    "tier: protected",
    "---",
    "",
    "# Cold Page Index",
    "",
    "Generated discovery metadata only. Read the original page on demand.",
    "",
  ];
  for (const entry of [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const path = entry.relativePath.replace(/^docs\/wiki\//, "");
    const tags = entry.tags.length ? ` · tags: ${entry.tags.join(", ")}` : "";
    const date = entry.date === null ? "" : ` · ${entry.date}`;
    const description = entry.description === null ? "" : ` — ${entry.description}`;
    lines.push(`- [${entry.title}](${path})${date}${tags}${description} · source: ${entry.relativePath}`);
  }
  lines.push("");
  writeRepoFile(coldIndexPath(root), lines.join("\n"));
}
