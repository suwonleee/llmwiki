import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { getConfig } from "./config.ts";
import { WikiIndex } from "./db.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { classifyTier, type AmbiguousReason, type AutoReason, type ProtectionReason } from "./tiering.ts";

type TierAction = "hot" | "warm" | "cold";
type AutomaticCandidate = { readonly id: string; readonly path: string; readonly action: TierAction; readonly reason: AutoReason; readonly pageHash: string; readonly bytes: number };
type AmbiguousCandidate = { readonly id: string; readonly path: string; readonly action: "warm"; readonly reason: AmbiguousReason; readonly pageHash: string };
type ProtectedCandidate = { readonly path: string; readonly reasons: readonly ProtectionReason[] };
type Candidate = AutomaticCandidate | AmbiguousCandidate;

export type WikiCleanPlan = {
  readonly automatic: readonly AutomaticCandidate[];
  readonly ambiguous: readonly AmbiguousCandidate[];
  readonly protected: readonly ProtectedCandidate[];
  readonly projectedSavingsBytes: number;
};

export type WikiCleanCommitResult = WikiCleanPlan & { readonly reviewPath: string | null };
export type WikiCleanApplyResult = { readonly applied: readonly string[] };

export class WikiCleanReviewError extends Error {
  readonly name = "WikiCleanReviewError";
  constructor(readonly kind: "malformed" | "unanswered" | "stale", message: string) {
    super(message);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function wikiFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...wikiFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function isDirty(root: string, path: string): boolean {
  const result = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "--", relative(root, path)], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 && new TextDecoder().decode(result.stdout).trim().length > 0;
}

function candidateId(path: string, action: TierAction, reason: string): string {
  return sha256(`${path}|${action}|${reason}`).slice(0, 12);
}

function tieredContent(content: string, tier: TierAction): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  if (lines[0] !== "---") throw new WikiCleanReviewError("malformed", "page has no frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end < 0) throw new WikiCleanReviewError("malformed", "page frontmatter is not closed");
  const tierLine = lines.findIndex((line, index) => index > 0 && index < end && /^tier:\s*/.test(line));
  if (tierLine >= 0) lines[tierLine] = `tier: ${tier}`;
  else lines.splice(end, 0, `tier: ${tier}`);
  return lines.join(newline);
}

function writeAtomically(path: string, content: string): void {
  const temp = `${path}.llmwiki-tmp-${crypto.randomUUID()}`;
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

function candidateLine(candidate: AmbiguousCandidate): string {
  return `- candidate: ${candidate.id} | path: ${candidate.path} | hash: ${candidate.pageHash} | action: ${candidate.action} | reason: ${candidate.reason} | risk: reversible-tier-only`;
}

function reviewText(candidates: readonly AmbiguousCandidate[], date: string): string {
  return [
    "---",
    "title: Wiki cleanup review",
    "description: Human approval for ambiguous reversible lifecycle tier changes.",
    `date: ${date}`,
    "tags: [cleanup, review, maintenance]",
    "status: draft",
    "kind: cleanup",
    "owner: human",
    "source: wiki-clean",
    "---",
    "",
    "# Wiki cleanup review",
    "",
    "Accept only IDs whose proposed tier is appropriate. Rejected IDs stay unchanged.",
    "",
    "## Candidates",
    "",
    ...candidates.map(candidateLine),
    "",
    "## Decision",
    "",
    "A. accepted IDs: (none)",
    "",
  ].join("\n");
}

function ambiguousReason(value: string): AmbiguousReason | null {
  switch (value) {
    case "missing-or-invalid-status":
    case "stale-link-graph":
    case "unsupported-category":
    case "invalid-policy-date":
      return value;
    default:
      return null;
  }
}

function parseReview(content: string): readonly AmbiguousCandidate[] {
  const metadata = parseFrontmatter(content).fields;
  if (metadata["kind"] !== "cleanup" || metadata["owner"] === undefined || metadata["source"] !== "wiki-clean") {
    throw new WikiCleanReviewError("malformed", "cleanup review frontmatter is malformed");
  }
  const pattern = /^- candidate: ([0-9a-f]{12}) \| path: (docs\/wiki\/[^|\s]+) \| hash: ([0-9a-f]{64}) \| action: (warm) \| reason: ([a-z-]+) \| risk: reversible-tier-only$/gm;
  const candidates: AmbiguousCandidate[] = [];
  for (const match of content.matchAll(pattern)) {
    const id = match[1];
    const path = match[2];
    const pageHash = match[3];
    const reason = match[5] === undefined ? null : ambiguousReason(match[5]);
    if (
      id === undefined || path === undefined || pageHash === undefined || reason === null || path.split("/").includes("..")
    ) throw new WikiCleanReviewError("malformed", "cleanup review candidates are malformed");
    candidates.push({ id, path, pageHash, action: "warm", reason });
  }
  if (candidates.length === 0 || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new WikiCleanReviewError("malformed", "cleanup review candidates are malformed");
  }
  const answer = /^A\. accepted IDs: (.*)$/m.exec(content)?.[1]?.trim();
  if (answer === undefined) throw new WikiCleanReviewError("unanswered", "cleanup review is unanswered");
  if (answer === "(none)") throw new WikiCleanReviewError("unanswered", "cleanup review is unanswered");
  const accepted = answer.split(",").map((id) => id.trim()).filter(Boolean);
  if (accepted.length === 0) throw new WikiCleanReviewError("unanswered", "cleanup review is unanswered");
  const known = new Set(candidates.map((candidate) => candidate.id));
  if (accepted.some((id) => !known.has(id))) throw new WikiCleanReviewError("malformed", "cleanup review names an unknown candidate");
  return candidates.filter((candidate) => accepted.includes(candidate.id));
}

export function planWikiClean(root: string, options: { readonly today?: string } = {}): WikiCleanPlan {
  const cfg = getConfig(root);
  const wiki = join(root, "docs", "wiki");
  const ignored = new Set([cfg.queueDir, cfg.quizDir]);
  const automatic: AutomaticCandidate[] = [];
  const ambiguous: AmbiguousCandidate[] = [];
  const protectedPages: ProtectedCandidate[] = [];
  for (const path of wikiFiles(wiki)) {
    const pagePath = relative(root, path).replace(/\\/g, "/");
    const localPath = relative(wiki, path).replace(/\\/g, "/");
    if (localPath === "cold-index.md" || ignored.has(localPath.split("/")[0] ?? "")) continue;
    const content = readFileSync(path, "utf8");
    const metadata = parseFrontmatter(content);
    const result = classifyTier({
      page: {
        path: pagePath,
        status: metadata.status,
        tier: metadata.tier,
        date: metadata.date,
        domain: typeof metadata.fields["domain"] === "string" ? metadata.fields["domain"] : null,
        supersededBy: typeof metadata.fields["superseded_by"] === "string" ? metadata.fields["superseded_by"] : null,
        hasUnresolvedConflict: false,
        dirtyWorktree: isDirty(root, path),
        incomingLinks: { kind: "none" },
      },
      policy: { config: cfg, today: options.today ?? today() },
    });
    const pageHash = sha256(content);
    switch (result.outcome) {
      case "protected":
        protectedPages.push({ path: pagePath, reasons: result.reasons });
        break;
      case "auto":
        if (metadata.tier !== result.tier) automatic.push({ id: candidateId(pagePath, result.tier, result.reason), path: pagePath, action: result.tier, reason: result.reason, pageHash, bytes: Buffer.byteLength(content) });
        break;
      case "ambiguous":
        if (metadata.tier !== "warm") ambiguous.push({ id: candidateId(pagePath, "warm", result.reason), path: pagePath, action: "warm", reason: result.reason, pageHash });
        break;
      default:
        throw new Error("unreachable tier result");
    }
  }
  return {
    automatic: automatic.sort((left, right) => left.path.localeCompare(right.path)),
    ambiguous: ambiguous.sort((left, right) => left.path.localeCompare(right.path)),
    protected: protectedPages.sort((left, right) => left.path.localeCompare(right.path)),
    projectedSavingsBytes: automatic.filter((candidate) => candidate.action === "cold").reduce((total, candidate) => total + candidate.bytes, 0),
  };
}

export function commitWikiClean(root: string, options: { readonly today?: string } = {}): WikiCleanCommitResult {
  const plan = planWikiClean(root, options);
  for (const candidate of plan.automatic) {
    const path = join(root, ...candidate.path.split("/"));
    writeAtomically(path, tieredContent(readFileSync(path, "utf8"), candidate.action));
  }
  let reviewPath: string | null = null;
  if (plan.ambiguous.length > 0) {
    reviewPath = join(root, "docs", "wiki", getConfig(root).queueDir, `wiki-clean-${options.today ?? today()}.md`);
    mkdirSync(join(root, "docs", "wiki", getConfig(root).queueDir), { recursive: true });
    if (!existsSync(reviewPath)) writeAtomically(reviewPath, reviewText(plan.ambiguous, options.today ?? today()));
  }
  new WikiIndex(root).indexAll();
  return { ...plan, reviewPath };
}

// The review file is CONSUMED — read, applied, then unlinked — so it has to belong to the
// repository being cleaned. A path outside it (a mistyped `--review`, or a review handed over
// from elsewhere) is refused before anything is written or deleted. Candidate paths inside the
// review are separately confined to `docs/wiki/` with no `..` segment (see parseReview).
function reviewPathInside(root: string, reviewPath: string): string {
  const repoRoot = resolve(root);
  const resolved = resolve(reviewPath);
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
    throw new WikiCleanReviewError("malformed", `cleanup review must live inside the repository: ${reviewPath}`);
  }
  return resolved;
}

export function applyWikiCleanReview(root: string, options: { readonly reviewPath: string }): WikiCleanApplyResult {
  const reviewPath = reviewPathInside(root, options.reviewPath);
  const content = readFileSync(reviewPath, "utf8");
  const accepted = parseReview(content);
  for (const candidate of accepted) {
    const path = join(root, ...candidate.path.split("/"));
    if (!existsSync(path) || sha256(readFileSync(path, "utf8")) !== candidate.pageHash) {
      throw new WikiCleanReviewError("stale", `cleanup review is stale: ${candidate.path}`);
    }
  }
  for (const candidate of accepted) {
    const path = join(root, ...candidate.path.split("/"));
    writeAtomically(path, tieredContent(readFileSync(path, "utf8"), candidate.action));
  }
  new WikiIndex(root).indexAll();
  unlinkSync(reviewPath);
  return { applied: accepted.map((candidate) => candidate.id) };
}
