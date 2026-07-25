import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const repos: string[] = [];

function mkRepo(): { readonly root: string; readonly page: string } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-maintenance-cli-"));
  repos.push(root);
  const dir = join(root, "docs", "wiki", "4_insight");
  mkdirSync(dir, { recursive: true });
  const page = join(dir, "archive.md");
  writeFileSync(page, "---\ntitle: Archive\ndescription: fixture\ndate: 2025-01-01\ntags: [archive, fixture]\nstatus: ready\n---\n\nbody stays\n", "utf8");
  return { root, page };
}

function cli(...args: readonly string[]): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("maintenance CLI", () => {
  test("reports database health read-only and makes compact dry-run first", () => {
    // Given: a minimal wiki workspace.
    const { root } = mkRepo();
    cli("index", root);
    const database = join(root, ".llmwiki", "index.db");
    const noticeState = join(root, ".llmwiki", "maintenance-state.json");
    const databaseBefore = fileHash(database);

    // When: health and default compact are invoked.
    const health = cli("db-health", root);
    const compact = cli("compact", root);

    // Then: both succeed without a destructive compaction command.
    expect(health.exitCode).toBe(0);
    expect(health.stdout).toContain("db-health");
    expect(fileHash(database)).toBe(databaseBefore);
    expect(existsSync(noticeState)).toBe(false);
    expect(compact.exitCode).toBe(0);
    expect(compact.stdout).toContain("dry-run");
    expect(cli("db-health", root, "--notice").exitCode).toBe(0);
    expect(existsSync(noticeState)).toBe(true);
  });

  test("keeps wiki bytes identical by default and writes reversible cleanup only with commit", () => {
    // Given: an old eligible page.
    const { root, page } = mkRepo();
    const before = readFileSync(page, "utf8");

    // When: cleanup is planned, then explicitly committed.
    const planned = cli("wiki-clean", root, "--date", "2026-07-23");
    const afterPlan = readFileSync(page, "utf8");
    const committed = cli("wiki-clean", root, "--date", "2026-07-23", "--commit");

    // Then: planning is byte-identical and commit changes only the lifecycle tier.
    expect(planned.exitCode).toBe(0);
    expect(afterPlan).toBe(before);
    expect(committed.exitCode).toBe(0);
    expect(readFileSync(page, "utf8")).toContain("tier: cold");
    expect(readFileSync(page, "utf8")).toContain("body stays");
  });

  test("refuses unanswered and stale review applies, then applies a valid accepted ID", () => {
    // Given: an ambiguous cleanup candidate and its generated review batch.
    const first = mkRepo();
    writeFileSync(first.page, readFileSync(first.page, "utf8").replace("status: ready", "status: pending"), "utf8");
    const review = join(first.root, "docs", "wiki", "0_review", "wiki-clean-2026-07-23.md");
    cli("wiki-clean", first.root, "--date", "2026-07-23", "--commit");
    const before = readFileSync(first.page, "utf8");

    // When / Then: incomplete and stale review batches both fail without applying a tier.
    expect(cli("wiki-clean-apply", first.root, "--review", review, "--commit").exitCode).not.toBe(0);
    expect(readFileSync(first.page, "utf8")).toBe(before);
    const id = /candidate: ([0-9a-f]{12})/.exec(readFileSync(review, "utf8"))?.[1];
    if (id === undefined) throw new Error("cleanup review candidate is missing");
    writeFileSync(review, readFileSync(review, "utf8").replace("A. accepted IDs: (none)", `A. accepted IDs: ${id}`), "utf8");
    writeFileSync(first.page, `${readFileSync(first.page, "utf8")}stale\n`, "utf8");
    expect(cli("wiki-clean-apply", first.root, "--review", review, "--commit").exitCode).not.toBe(0);
    expect(readFileSync(first.page, "utf8")).toContain("stale");

    // Given: a fresh answered review batch for the same user-facing action.
    const second = mkRepo();
    writeFileSync(second.page, readFileSync(second.page, "utf8").replace("status: ready", "status: pending"), "utf8");
    const validReview = join(second.root, "docs", "wiki", "0_review", "wiki-clean-2026-07-23.md");
    cli("wiki-clean", second.root, "--date", "2026-07-23", "--commit");
    const validId = /candidate: ([0-9a-f]{12})/.exec(readFileSync(validReview, "utf8"))?.[1];
    if (validId === undefined) throw new Error("cleanup review candidate is missing");
    writeFileSync(validReview, readFileSync(validReview, "utf8").replace("A. accepted IDs: (none)", `A. accepted IDs: ${validId}`), "utf8");

    // When / Then: the explicit valid apply closes its review and preserves body content.
    expect(cli("wiki-clean-apply", second.root, "--review", validReview, "--commit").exitCode).toBe(0);
    expect(readFileSync(second.page, "utf8")).toContain("tier: warm");
    expect(readFileSync(second.page, "utf8")).toContain("body stays");
    expect(existsSync(validReview)).toBe(false);
  });
});
