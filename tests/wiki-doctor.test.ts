import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { runWikiDoctor } from "../src/engine/wiki-doctor.ts";

const ROOT = join(import.meta.dir, "..");
const TODAY = "2026-07-24";
const temporary: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

function validPage(body = "A durable observation for the next session."): string {
  return [
    "---",
    "title: Doctor fixture",
    "description: Evidence-preserving doctor test page.",
    `date: ${TODAY}`,
    "tags: [doctor, fixture]",
    "status: ready",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function repoWithPage(content = validPage()): { readonly root: string; readonly page: string } {
  const root = temp("llmwiki-wiki-doctor-");
  const dir = join(root, "docs", "wiki", "4_insight");
  mkdirSync(dir, { recursive: true });
  const page = join(dir, "fixture.md");
  writeFileSync(page, content, "utf8");
  return { root, page };
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function cli(...args: readonly string[]): { readonly exitCode: number; readonly stdout: string } {
  const result = Bun.spawnSync([process.execPath, "src/cli.ts", ...args], {
    cwd: ROOT,
    env: { ...process.env, LLMWIKI_STATE_DIR: temp("llmwiki-wiki-doctor-cli-state-") },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
  };
}

beforeEach(() => {
  capture.setStateDir(temp("llmwiki-wiki-doctor-state-"));
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("wiki doctor engine", () => {
  test("diagnoses a missing index without writing any repository state", () => {
    const { root, page } = repoWithPage();
    const before = hash(page);

    const report = runWikiDoctor(root, { today: TODAY });

    expect(report.mode).toBe("check");
    expect(report.index.status).toBe("missing");
    expect(report.blockingErrors).toBeGreaterThan(0);
    expect(report.actions).toEqual([]);
    expect(hash(page)).toBe(before);
    expect(existsSync(join(root, ".llmwiki"))).toBe(false);
  });

  test("repairs only generated state and leaves an existing page byte-identical", () => {
    const { root, page } = repoWithPage();
    const before = readFileSync(page, "utf8");

    const report = runWikiDoctor(root, { fix: true, today: TODAY });
    expect(report.mode).toBe("fix");
    expect(report.index.status).toBe("current");
    expect(report.blockingErrors).toBe(0);
    expect(report.actions.some((action) => action.code === "structure-restored")).toBe(true);
    expect(report.actions.some((action) => action.code === "index-refreshed")).toBe(true);
    expect(existsSync(join(root, ".llmwiki", "index.db"))).toBe(true);
    expect(existsSync(join(root, "docs", "wiki", "current-state.md"))).toBe(true);
    expect(readFileSync(page, "utf8")).toBe(before);
  });

  test("keeps a healthy index and all wiki bytes unchanged in check mode", () => {
    const { root, page } = repoWithPage();
    expect(runWikiDoctor(root, { fix: true, today: TODAY }).blockingErrors).toBe(0);
    const database = join(root, ".llmwiki", "index.db");
    const databaseBefore = hash(database);
    const pageBefore = hash(page);

    const report = runWikiDoctor(root, { today: TODAY });

    expect(report.mode).toBe("check");
    expect(report.index.status).toBe("current");
    expect(report.actions).toEqual([]);
    expect(hash(database)).toBe(databaseBefore);
    expect(hash(page)).toBe(pageBefore);
  });

  test("detects a stale index read-only and refreshes it on fix", () => {
    const { root, page } = repoWithPage();
    expect(runWikiDoctor(root, { fix: true, today: TODAY }).index.status).toBe("current");
    writeFileSync(page, validPage("Changed on disk after the prior index."), "utf8");
    const changed = readFileSync(page, "utf8");

    const checked = runWikiDoctor(root, { today: TODAY });
    expect(checked.index.status).toBe("stale");
    expect(checked.index.changedOnDisk).toContain("docs/wiki/4_insight/fixture.md");
    expect(readFileSync(page, "utf8")).toBe(changed);

    const fixed = runWikiDoctor(root, { fix: true, today: TODAY });
    expect(fixed.index.status).toBe("current");
    expect(fixed.blockingErrors).toBe(0);
    expect(readFileSync(page, "utf8")).toBe(changed);
  });

  test("does not rewrite an evidence-bearing page merely to clear lint", () => {
    const body = "# Missing frontmatter\n\nThis claim uses a footnote without a definition.[^missing]\n";
    const { root, page } = repoWithPage(body);

    const report = runWikiDoctor(root, { fix: true, today: TODAY });

    expect(report.index.status).toBe("current");
    expect(report.blockingErrors).toBeGreaterThan(0);
    expect(report.lint.issues.map((issue) => issue.code)).toContain("missing-frontmatter");
    expect(report.lint.issues.map((issue) => issue.code)).toContain("footnote-without-definition");
    expect(readFileSync(page, "utf8")).toBe(body);
  });

  test("quarantines an unreadable derived index and rebuilds it", () => {
    const { root, page } = repoWithPage();
    mkdirSync(join(root, ".llmwiki"), { recursive: true });
    writeFileSync(join(root, ".llmwiki", "index.db"), "not a sqlite database", "utf8");
    const before = hash(page);

    const report = runWikiDoctor(root, { fix: true, today: TODAY });

    expect(report.index.status).toBe("current");
    expect(report.actions.some((action) => action.code === "index-recovered")).toBe(true);
    const recovery = join(root, ".llmwiki", "recovery");
    expect(readdirSync(recovery).some((name) => name.startsWith("index.db.") && name.endsWith(".bak"))).toBe(true);
    expect(hash(page)).toBe(before);
  });

  test("preserves a malformed generated gap queue for evidence-aware recovery", () => {
    const { root } = repoWithPage();
    runWikiDoctor(root, { fix: true, today: TODAY });
    const queue = join(root, "docs", "wiki", "0_review", "gap-queue.md");
    const malformed = "# hand-edited queue\n\n- [ ] missing stable markers\n";
    writeFileSync(queue, malformed, "utf8");

    const report = runWikiDoctor(root, { fix: true, today: TODAY });

    expect(report.findings.map((finding) => finding.code)).toContain("gap-queue-malformed");
    expect(report.blockingErrors).toBeGreaterThan(0);
    expect(readFileSync(queue, "utf8")).toBe(malformed);
  });

  test("reports invalid workspace paths instead of creating or crashing", () => {
    const parent = temp("llmwiki-wiki-doctor-missing-");
    const missing = join(parent, "does-not-exist");
    const file = join(parent, "not-a-directory");
    writeFileSync(file, "plain file", "utf8");

    const absentReport = runWikiDoctor(missing, { fix: true, today: TODAY });
    const fileReport = runWikiDoctor(file, { fix: true, today: TODAY });

    expect(absentReport.findings.map((finding) => finding.code)).toContain("workspace-missing");
    expect(fileReport.findings.map((finding) => finding.code)).toContain("workspace-missing");
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("plain file");
  });

  test("surfaces a corrupt central capture queue instead of hiding the backlog check", () => {
    const state = temp("llmwiki-wiki-doctor-corrupt-capture-");
    capture.setStateDir(state);
    writeFileSync(join(state, "capture.db"), "not sqlite", "utf8");
    const { root } = repoWithPage();

    const report = runWikiDoctor(root, { today: TODAY });

    expect(report.continuity.capture).toBe("unreadable");
    expect(report.findings.map((finding) => finding.code)).toContain("capture-database-unreadable");
    expect(report.blockingErrors).toBeGreaterThan(0);
  });
});

describe("wiki doctor CLI", () => {
  test("defaults to check mode and exposes an explicit fix mode", () => {
    const { root } = repoWithPage();

    const checked = cli("wiki-doctor", root, "--date", TODAY);
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout).toContain("llmwiki wiki-doctor [CHECK]");
    expect(checked.stdout).toContain("[index-missing]");

    const fixed = cli("wiki-doctor", root, "--date", TODAY, "--fix");
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toContain("llmwiki wiki-doctor [FIX]");
    expect(fixed.stdout).toContain("[index-refreshed]");
    expect(fixed.stdout).toContain("operational");
  });
});
