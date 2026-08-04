import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { inspectDatabaseHealth } from "../src/engine/db-maintenance.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { projectStatePath } from "../src/engine/project-state.ts";
import { runWikiDoctor } from "../src/engine/wiki-doctor.ts";
import { makeEnrolledRepo } from "./support/git-repo.ts";

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

  for (const planted of ["index leaf", ".llmwiki ancestor"] as const) {
    test(`fix refuses a symlinked legacy ${planted} without touching its external target or journals`, () => {
      const { root } = repoWithPage();
      const external = temp("llmwiki-wiki-doctor-external-");
      const target = join(external, "index.db");
      const wal = `${target}-wal`;
      const shm = `${target}-shm`;
      writeFileSync(target, "external database sentinel", "utf8");
      writeFileSync(wal, "external wal sentinel", "utf8");
      writeFileSync(shm, "external shm sentinel", "utf8");
      const before = [target, wal, shm].map(hash);

      if (planted === "index leaf") {
        mkdirSync(join(root, ".llmwiki"));
        symlinkSync(target, join(root, ".llmwiki", "index.db"));
      } else {
        symlinkSync(external, join(root, ".llmwiki"));
      }

      const report = runWikiDoctor(root, { fix: true, today: TODAY });

      expect(report.findings.map((finding) => finding.code)).toContain("repair-failed");
      expect(report.blockingErrors).toBeGreaterThan(0);
      expect([target, wal, shm].map(hash)).toEqual(before);
    });
  }

  test("check refuses a symlinked central index without touching its external target or journals", () => {
    const root = makeEnrolledRepo("llmwiki-wiki-doctor-central-");
    temporary.push(root);
    const dir = join(root, "docs", "wiki", "4_insight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fixture.md"), validPage(), "utf8");
    new WikiIndex(root).indexAll();

    const databasePath = projectStatePath(root, "index.db");
    rmSync(databasePath);
    const external = temp("llmwiki-wiki-doctor-central-external-");
    const target = join(external, "index.db");
    const wal = `${target}-wal`;
    const shm = `${target}-shm`;
    writeFileSync(target, "external database sentinel", "utf8");
    writeFileSync(wal, "external wal sentinel", "utf8");
    writeFileSync(shm, "external shm sentinel", "utf8");
    const before = [target, wal, shm].map(hash);
    symlinkSync(target, databasePath);

    const report = runWikiDoctor(root, { today: TODAY });

    expect(report.index.status).toBe("unreadable");
    expect(report.blockingErrors).toBeGreaterThan(0);
    expect([target, wal, shm].map(hash)).toEqual(before);
  });

  for (const fix of [false, true] as const) {
    test(`${fix ? "fix" : "check"} refuses a symlinked central project directory without touching its database or journals`, () => {
      const root = makeEnrolledRepo(`llmwiki-wiki-doctor-central-parent-${fix ? "fix" : "check"}-`);
      temporary.push(root);
      const dir = join(root, "docs", "wiki", "4_insight");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "fixture.md"), validPage(), "utf8");
      new WikiIndex(root).indexAll();

      const databasePath = projectStatePath(root, "index.db");
      const projectDir = dirname(databasePath);
      const external = temp("llmwiki-wiki-doctor-central-parent-external-");
      const externalProject = join(external, "project");
      renameSync(projectDir, externalProject);
      symlinkSync(externalProject, projectDir);

      // Keep a real WAL session open so the regression proves doctor leaves all three SQLite
      // files byte-identical. A readonly open is still allowed to update `-shm` unless the
      // ancestor no-follow boundary rejects the path first.
      const writer = new Database(join(externalProject, "index.db"));
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS doctor_journal_sentinel(value TEXT)");
      const files = ["index.db", "index.db-wal", "index.db-shm"].map((name) => join(externalProject, name));
      const before = files.map(hash);

      const report = runWikiDoctor(root, { fix, today: TODAY });

      expect(report.index.status).toBe("unreadable");
      expect(report.blockingErrors).toBeGreaterThan(0);
      expect(files.map(hash)).toEqual(before);
      writer.close();
    });
  }

  test("fix repairs same-cardinality pages_fts content drift that check mode cannot prove", () => {
    const { root, page } = repoWithPage(
      validPage().replace("Doctor fixture", "Alphawitness Doctor fixture"),
    );
    const second = join(root, "docs", "wiki", "4_insight", "second.md");
    writeFileSync(second, validPage().replace("Doctor fixture", "Betawitness Doctor fixture"), "utf8");
    expect(runWikiDoctor(root, { fix: true, today: TODAY }).blockingErrors).toBe(0);

    const databasePath = join(root, ".llmwiki", "index.db");
    const db = new Database(databasePath);
    const rows = db
      .query<
        { rowid: number; title: string; description: string; filename: string; relative_path: string },
        []
      >(
        "SELECT rowid, title, description, filename, relative_path FROM documents " +
          "WHERE relative_path IN ('docs/wiki/4_insight/fixture.md', 'docs/wiki/4_insight/second.md') " +
          "ORDER BY relative_path",
      )
      .all();
    expect(rows).toHaveLength(2);
    const [first, other] = rows;
    for (const row of rows) {
      db.run(
        "INSERT INTO pages_fts(pages_fts, rowid, title, description, filename) " +
          "VALUES('delete', ?, ?, ?, ?)",
        [row.rowid, row.title, row.description, row.filename],
      );
    }
    db.run("INSERT INTO pages_fts(rowid, title, description, filename) VALUES(?, ?, ?, ?)", [
      first.rowid,
      other.title,
      other.description,
      other.filename,
    ]);
    db.run("INSERT INTO pages_fts(rowid, title, description, filename) VALUES(?, ?, ?, ?)", [
      other.rowid,
      first.title,
      first.description,
      first.filename,
    ]);
    expect(inspectDatabaseHealth(db).integrity.ok).toBe(false);
    db.close();

    const databaseBeforeCheck = hash(databasePath);
    const firstBeforeCheck = hash(page);
    const secondBeforeCheck = hash(second);
    const checked = runWikiDoctor(root, { today: TODAY });
    expect(checked.mode).toBe("check");
    expect(checked.actions).toEqual([]);
    expect(hash(databasePath)).toBe(databaseBeforeCheck);
    expect(hash(page)).toBe(firstBeforeCheck);
    expect(hash(second)).toBe(secondBeforeCheck);

    const fixed = runWikiDoctor(root, { fix: true, today: TODAY });
    expect(fixed.index.status).toBe("current");
    expect(fixed.blockingErrors).toBe(0);
    expect(fixed.actions.some((action) => action.code === "index-recovered")).toBe(true);
    expect(hash(page)).toBe(firstBeforeCheck);
    expect(hash(second)).toBe(secondBeforeCheck);

    const repaired = new Database(databasePath);
    expect(inspectDatabaseHealth(repaired).integrity.ok).toBe(true);
    const index = new WikiIndex(root);
    expect(index.search(repaired, "alphawitness", 10, "wiki")[0]?.relative_path).toBe(
      "docs/wiki/4_insight/fixture.md",
    );
    expect(index.search(repaired, "betawitness", 10, "wiki")[0]?.relative_path).toBe(
      "docs/wiki/4_insight/second.md",
    );
    repaired.close();
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
