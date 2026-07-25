import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import * as capture from "./capture.ts";
import { COLD_INDEX_RELATIVE_PATH } from "./cold-index.ts";
import { getConfig, type WikiConfig } from "./config.ts";
import { inspectDatabaseHealth, compactDatabase, type DatabaseHealthReport } from "./db-maintenance.ts";
import { WikiIndex } from "./db.ts";
import { parseQueue } from "./gaps.ts";
import { Linter, type LintIssue } from "./lint.ts";
import { today as todayLocal } from "./today.ts";
import { normalizeOverview } from "./overview.ts";
import { rebuildReferenceGraph } from "./refs.ts";
import { citedTranscripts, reconcileReflected } from "./reconcile.ts";
import { inspectReviewHealth, type ReviewHealth } from "./review.ts";
import { ensureSkeleton } from "./update.ts";

export type WikiDoctorSeverity = "error" | "warn" | "info";
export type WikiDoctorRepairOwner = "automatic" | "agent" | "human";

export interface WikiDoctorFinding {
  readonly code: string;
  readonly severity: WikiDoctorSeverity;
  readonly message: string;
  readonly repairOwner: WikiDoctorRepairOwner;
  readonly command?: string;
}

export interface WikiDoctorIndexHealth {
  readonly status: "missing" | "unreadable" | "current" | "stale";
  readonly missingFromIndex: readonly string[];
  readonly changedOnDisk: readonly string[];
  readonly deletedFromDisk: readonly string[];
}

export interface WikiDoctorGapHealth {
  readonly exists: boolean;
  readonly wellFormed: boolean;
  readonly open: number;
  readonly resolved: number;
}

export interface WikiDoctorContinuityHealth {
  readonly capture: "absent" | "current" | "unreadable";
  readonly captureError: string | null;
  readonly backlog: number;
  readonly citedTails: number;
  readonly reconcilable: number;
}

export interface WikiDoctorAction {
  readonly code: string;
  readonly message: string;
}

export interface WikiDoctorReport {
  readonly workspace: string;
  readonly mode: "check" | "fix";
  readonly configSource: string;
  readonly structureMissing: readonly string[];
  readonly index: WikiDoctorIndexHealth;
  readonly database: DatabaseHealthReport | null;
  readonly lint: {
    readonly checked: number;
    readonly issues: readonly LintIssue[];
  };
  readonly continuity: WikiDoctorContinuityHealth;
  readonly gaps: WikiDoctorGapHealth;
  readonly review: ReviewHealth;
  readonly findings: readonly WikiDoctorFinding[];
  readonly actions: readonly WikiDoctorAction[];
  readonly blockingErrors: number;
}

interface IndexInspection {
  readonly health: WikiDoctorIndexHealth;
  readonly database: DatabaseHealthReport | null;
  readonly lintIssues: readonly LintIssue[];
  readonly lintChecked: number;
}

const WIKI_RELATIVE = join("docs", "wiki");
const THIRTY_MIB = 30 * 1024 * 1024;

function hashFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function walkKnowledgeFiles(root: string, cfg: WikiConfig): Map<string, string | null> {
  const wikiRoot = join(root, WIKI_RELATIVE);
  const quizRoot = join(wikiRoot, cfg.quizDir) + sep;
  const files = new Map<string, string | null>();

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (full + sep === quizRoot || full.startsWith(quizRoot)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const relativePath = relative(root, full).replaceAll("\\", "/");
        if (relativePath === COLD_INDEX_RELATIVE_PATH) continue;
        files.set(relativePath, hashFile(full));
      }
    }
  }

  walk(wikiRoot);
  return files;
}

function inspectIndex(root: string, cfg: WikiConfig): IndexInspection {
  const index = new WikiIndex(root);
  if (!existsSync(index.dbPath)) {
    return {
      health: { status: "missing", missingFromIndex: [], changedOnDisk: [], deletedFromDisk: [] },
      database: null,
      lintIssues: [],
      lintChecked: 0,
    };
  }

  let db: Database | null = null;
  try {
    db = new Database(index.dbPath, { readonly: true });
    const rows = db
      .query<{ readonly relative_path: string; readonly content_hash: string | null }, []>(
        "SELECT relative_path, content_hash FROM documents WHERE source_kind='wiki'",
      )
      .all();
    const indexed = new Map(rows.map((row) => [row.relative_path, row.content_hash]));
    const disk = walkKnowledgeFiles(root, cfg);
    const missingFromIndex: string[] = [];
    const changedOnDisk: string[] = [];
    const deletedFromDisk: string[] = [];
    for (const [path, hash] of disk) {
      if (!indexed.has(path)) missingFromIndex.push(path);
      else if (hash === null || indexed.get(path) !== hash) changedOnDisk.push(path);
    }
    for (const path of indexed.keys()) if (!disk.has(path)) deletedFromDisk.push(path);

    const [lintIssues, lintChecked] = new Linter(index as any, db, cfg).run("*", "all");
    const database = inspectDatabaseHealth(db);
    const stale = missingFromIndex.length + changedOnDisk.length + deletedFromDisk.length > 0;
    return {
      health: {
        status: stale ? "stale" : "current",
        missingFromIndex: missingFromIndex.sort(),
        changedOnDisk: changedOnDisk.sort(),
        deletedFromDisk: deletedFromDisk.sort(),
      },
      database,
      lintIssues,
      lintChecked,
    };
  } catch {
    return {
      health: { status: "unreadable", missingFromIndex: [], changedOnDisk: [], deletedFromDisk: [] },
      database: null,
      lintIssues: [],
      lintChecked: 0,
    };
  } finally {
    db?.close();
  }
}

function requiredStructure(root: string, cfg: WikiConfig): string[] {
  const directories = [
    ...cfg.categories.map((category) => join(WIKI_RELATIVE, category.dir)),
    join(WIKI_RELATIVE, cfg.queueDir),
    join(WIKI_RELATIVE, cfg.topicDir),
    join(WIKI_RELATIVE, cfg.quizDir),
  ];
  const files = [
    join(WIKI_RELATIVE, cfg.files.l0),
    join(WIKI_RELATIVE, cfg.files.overview),
    join(WIKI_RELATIVE, cfg.files.log),
  ];
  const valid = (path: string, kind: "directory" | "file"): boolean => {
    try {
      const status = lstatSync(join(root, path));
      return !status.isSymbolicLink() && (kind === "directory" ? status.isDirectory() : status.isFile());
    } catch {
      return false;
    }
  };
  return [
    ...directories.filter((path) => !valid(path, "directory")),
    ...files.filter((path) => !valid(path, "file")),
  ].map((path) => path.replaceAll("\\", "/"));
}

function inspectGapHealth(root: string, cfg: WikiConfig): WikiDoctorGapHealth {
  const path = join(root, WIKI_RELATIVE, cfg.queueDir, "gap-queue.md");
  if (!existsSync(path)) return { exists: false, wellFormed: true, open: 0, resolved: 0 };
  try {
    const body = readFileSync(path, "utf8");
    const gaps = parseQueue(body);
    const itemLines = body.split("\n").filter((line) => /^\s*-\s*\[/.test(line)).length;
    const headings =
      /^## Open \(\d+\)\s*$/m.test(body) &&
      /^## Resolved \(\d+(?: total; showing \d+ most recent)?\)\s*$/m.test(body);
    return {
      exists: true,
      wellFormed: headings && gaps.length === itemLines,
      open: gaps.filter((gap) => gap.status === "open").length,
      resolved: gaps.filter((gap) => gap.status === "resolved").length,
    };
  } catch {
    return { exists: true, wellFormed: false, open: 0, resolved: 0 };
  }
}

function inspectContinuity(root: string): WikiDoctorContinuityHealth {
  const cited = citedTranscripts(root);
  const pending = capture.inspectPendingReadOnly(root);
  let reconcilable = 0;
  let citedTails = 0;
  let backlog = 0;
  for (const row of pending.rows) {
    const represented = cited.has(basename(row.transcript_path).toLowerCase());
    if (!represented) backlog += 1;
    else if (row.byte_offset === 0) reconcilable += 1;
    else citedTails += 1;
  }
  return {
    capture: pending.status,
    captureError: pending.error,
    backlog,
    citedTails,
    reconcilable,
  };
}

function quarantineDerivedIndex(root: string): string[] {
  const indexDir = join(root, ".llmwiki");
  const recovery = join(indexDir, "recovery");
  mkdirSync(recovery, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const moved: string[] = [];
  for (const name of ["index.db", "index.db-wal", "index.db-shm"]) {
    const source = join(indexDir, name);
    if (!existsSync(source)) continue;
    const target = join(recovery, `${name}.${stamp}.bak`);
    renameSync(source, target);
    moved.push(target);
  }
  return moved;
}

function derivedIndexNeedsRebuild(path: string): boolean {
  if (!existsSync(path)) return false;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    return !inspectDatabaseHealth(db).integrity.ok;
  } catch {
    return true;
  } finally {
    db?.close();
  }
}

function rebuildQuarantinedIndex(root: string, index: WikiIndex, actions: WikiDoctorAction[]): void {
  const moved = quarantineDerivedIndex(root);
  const [created] = index.reindex();
  const refs = rebuildReferenceGraph(index);
  actions.push({
    code: "index-recovered",
    message:
      `unreadable derived index moved to recovery (${moved.length} file(s)); rebuilt ${created} file(s), ` +
      `refs ${refs.citations}/${refs.links}`,
  });
}

function repairDerivedState(root: string, cfg: WikiConfig, actions: WikiDoctorAction[]): void {
  if (!cfg.error) {
    const before = requiredStructure(root, cfg);
    ensureSkeleton(root, cfg);
    if (before.length) {
      actions.push({ code: "structure-restored", message: `restored ${before.length} missing skeleton item(s)` });
    }
  }

  const overview = normalizeOverview(root);
  if (overview.verdict === "normalized") {
    actions.push({
      code: "overview-normalized",
      message: `normalized overview Recent Updates (${overview.before}B → ${overview.after}B)`,
    });
  }

  // Generated Markdown must settle before the final index pass. Indexing first would leave the
  // command's own overview edit immediately stale and force a second doctor run. The gap queue is
  // deliberately not refreshed here: repeated application of one semantic report must not count
  // as multiple absence observations. The agent workflow refreshes gaps only after a real review.
  const index = new WikiIndex(root);
  if (derivedIndexNeedsRebuild(index.dbPath)) {
    rebuildQuarantinedIndex(root, index, actions);
  } else {
    try {
      const [created, updated] = index.indexAll();
      const refs = rebuildReferenceGraph(index);
      actions.push({
        code: "index-refreshed",
        message:
          `index refreshed (${created} new, ${updated} updated); refs ${refs.citations} citation / ` +
          `${refs.links} link across ${refs.pages} page(s)`,
      });
    } catch (error) {
      // A healthy index plus an unreadable source file is not database corruption. Preserve the
      // existing index and surface the real repair failure instead of quarantining good state.
      if (!derivedIndexNeedsRebuild(index.dbPath)) throw error;
      rebuildQuarantinedIndex(root, index, actions);
    }
  }

  if (capture.pendingReadOnly(root).length) {
    const continuity = reconcileReflected(root, true);
    if (continuity.reconciled.length) {
      actions.push({
        code: "capture-reconciled",
        message: `advanced ${continuity.reconciled.length} fully cited capture watermark(s)`,
      });
    }
  }

  const db = index.connect();
  const health = inspectDatabaseHealth(db);
  if (health.compactionEligible) {
    const compacted = compactDatabase(db, { commit: true });
    if (compacted.kind === "compacted") {
      actions.push({
        code: "database-compacted",
        message:
          `compacted derived index ${compacted.before.storage.databaseBytes}B → ` +
          `${compacted.after.storage.databaseBytes}B`,
      });
    }
  }
  db.close();
}

function pushFinding(
  findings: WikiDoctorFinding[],
  finding: WikiDoctorFinding,
): void {
  findings.push(finding);
}

export function runWikiDoctor(
  workspace: string,
  options: { readonly fix?: boolean; readonly today?: string } = {},
): WikiDoctorReport {
  const root = resolve(workspace);
  const fix = options.fix === true;
  const actions: WikiDoctorAction[] = [];
  const cfg = getConfig(root);
  const today = options.today ?? todayLocal();
  let workspaceDirectory = false;
  try {
    workspaceDirectory = statSync(root).isDirectory();
  } catch {
    workspaceDirectory = false;
  }
  let repairFailure: string | null = null;

  if (fix && workspaceDirectory && (existsSync(join(root, WIKI_RELATIVE)) || !cfg.error)) {
    try {
      repairDerivedState(root, cfg, actions);
    } catch (error) {
      repairFailure = error instanceof Error ? error.message : String(error);
    }
  }

  const structureMissing = workspaceDirectory ? requiredStructure(root, cfg) : [WIKI_RELATIVE.replaceAll("\\", "/")];
  const indexInspection = inspectIndex(root, cfg);
  const continuity = workspaceDirectory
    ? inspectContinuity(root)
    : { capture: "absent" as const, captureError: null, backlog: 0, citedTails: 0, reconcilable: 0 };
  const gaps = workspaceDirectory ? inspectGapHealth(root, cfg) : { exists: false, wellFormed: true, open: 0, resolved: 0 };
  const review = inspectReviewHealth(root, today);
  const findings: WikiDoctorFinding[] = [];

  if (!workspaceDirectory) {
    pushFinding(findings, {
      code: "workspace-missing",
      severity: "error",
      message: `workspace directory is missing or is not a directory: ${root}`,
      repairOwner: "human",
    });
  }
  if (repairFailure !== null) {
    pushFinding(findings, {
      code: "repair-failed",
      severity: "error",
      message: `safe repair stopped: ${repairFailure}`,
      repairOwner: "agent",
    });
  }
  if (cfg.error) {
    pushFinding(findings, {
      code: "config-invalid",
      severity: "error",
      message: `config is invalid; defaults are active: ${cfg.error}`,
      repairOwner: "agent",
      command: `llmwiki config ${root}`,
    });
  } else if (cfg.warning) {
    pushFinding(findings, {
      code: "config-warning",
      severity: "warn",
      message: cfg.warning,
      repairOwner: "agent",
      command: `llmwiki config ${root}`,
    });
  }
  if (structureMissing.length) {
    pushFinding(findings, {
      code: "structure-missing",
      severity: "error",
      message: `${structureMissing.length} required wiki item(s) missing: ${structureMissing.slice(0, 6).join(", ")}`,
      repairOwner: "automatic",
      command: `llmwiki wiki-doctor ${root} --fix`,
    });
  }
  if (indexInspection.health.status !== "current") {
    const count =
      indexInspection.health.missingFromIndex.length +
      indexInspection.health.changedOnDisk.length +
      indexInspection.health.deletedFromDisk.length;
    pushFinding(findings, {
      code: `index-${indexInspection.health.status}`,
      severity: "error",
      message:
        indexInspection.health.status === "stale"
          ? `derived index is stale across ${count} path(s)`
          : `derived index is ${indexInspection.health.status}`,
      repairOwner: "automatic",
      command: `llmwiki wiki-doctor ${root} --fix`,
    });
  }
  if (indexInspection.database && !indexInspection.database.integrity.ok) {
    pushFinding(findings, {
      code: "database-integrity",
      severity: "error",
      message: `derived database integrity failed: ${indexInspection.database.integrity.messages.join("; ")}`,
      repairOwner: "automatic",
      command: `llmwiki wiki-doctor ${root} --fix`,
    });
  } else if (indexInspection.database?.compactionEligible) {
    pushFinding(findings, {
      code: "database-compaction",
      severity: "warn",
      message:
        `derived database has ${indexInspection.database.storage.freeBytes}B free ` +
        `(${(indexInspection.database.storage.freeRatio * 100).toFixed(1)}%)`,
      repairOwner: "automatic",
      command: `llmwiki wiki-doctor ${root} --fix`,
    });
  }
  if (indexInspection.database && indexInspection.database.liveIndexedBytes > THIRTY_MIB) {
    pushFinding(findings, {
      code: "live-index-large",
      severity: "warn",
      message: `live indexed content is ${indexInspection.database.liveIndexedBytes}B after storage checks`,
      repairOwner: "agent",
      command: `llmwiki wiki-clean ${root}`,
    });
  }

  const lintErrors = indexInspection.lintIssues.filter((issue) => issue.severity === "error");
  const lintWarnings = indexInspection.lintIssues.filter((issue) => issue.severity === "warn");
  if (lintErrors.length) {
    pushFinding(findings, {
      code: "lint-errors",
      severity: "error",
      message: `${lintErrors.length} content/structure lint error(s) require evidence-aware repair`,
      repairOwner: "agent",
      command: `llmwiki lint ${root} --errors-only`,
    });
  }
  if (lintWarnings.length) {
    const counts = new Map<string, number>();
    for (const issue of lintWarnings) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code} ${count}`).join(" · ");
    pushFinding(findings, {
      code: "lint-warnings",
      severity: "warn",
      message: `${lintWarnings.length} advisory lint warning(s): ${summary}`,
      repairOwner: "agent",
      command: `llmwiki lint ${root}`,
    });
  }
  if (continuity.capture === "unreadable") {
    pushFinding(findings, {
      code: "capture-database-unreadable",
      severity: "error",
      message: `central capture queue is unreadable: ${continuity.captureError ?? "unknown database error"}`,
      repairOwner: "agent",
      command: "llmwiki doctor",
    });
  }
  if (continuity.reconcilable) {
    pushFinding(findings, {
      code: "capture-reconcilable",
      severity: "warn",
      message: `${continuity.reconcilable} fully cited session watermark(s) can be reconciled`,
      repairOwner: "automatic",
      command: `llmwiki wiki-doctor ${root} --fix`,
    });
  }
  if (continuity.backlog) {
    pushFinding(findings, {
      code: "capture-backlog",
      severity: "warn",
      message: `${continuity.backlog} uncited session(s) remain in the real backlog`,
      repairOwner: "agent",
      command: "$wiki-deep",
    });
  }
  if (continuity.citedTails) {
    pushFinding(findings, {
      code: "capture-cited-tail",
      severity: "info",
      message: `${continuity.citedTails} cited session(s) have an unread tail deferred to the next deep pass`,
      repairOwner: "agent",
      command: "$wiki-deep",
    });
  }
  if (!gaps.wellFormed) {
    pushFinding(findings, {
      code: "gap-queue-malformed",
      severity: "error",
      message: "generated gap queue is malformed; it was preserved instead of overwritten",
      repairOwner: "agent",
    });
  } else if (gaps.open) {
    pushFinding(findings, {
      code: "open-gaps",
      severity: "warn",
      message: `${gaps.open} fact gap(s) remain open`,
      repairOwner: "agent",
      command: "$wiki-deep",
    });
  }
  if (review.incompleteLaunch) {
    pushFinding(findings, {
      code: "review-incomplete",
      severity: "error",
      message: `semantic review launched ${review.launchedDate ?? "unknown"} but never committed`,
      repairOwner: "agent",
      command: `llmwiki review ${root} --commit --force`,
    });
  } else if (review.due) {
    pushFinding(findings, {
      code: "review-due",
      severity: "warn",
      message: `semantic review is due (last completed: ${review.lastCompletedDate ?? "never"})`,
      repairOwner: "agent",
      command: `llmwiki review ${root} --commit --if-due`,
    });
  }

  const blockingErrors = findings.filter((finding) => finding.severity === "error").length;
  return {
    workspace: root,
    mode: fix ? "fix" : "check",
    configSource: cfg.source,
    structureMissing,
    index: indexInspection.health,
    database: indexInspection.database,
    lint: { checked: indexInspection.lintChecked, issues: indexInspection.lintIssues },
    continuity,
    gaps,
    review,
    findings,
    actions,
    blockingErrors,
  };
}

function groupedLint(issues: readonly LintIssue[]): string[] {
  const groups = new Map<string, { count: number; paths: string[] }>();
  for (const issue of issues) {
    const group = groups.get(issue.code) ?? { count: 0, paths: [] };
    group.count += 1;
    if (group.paths.length < 3 && !group.paths.includes(issue.path)) group.paths.push(issue.path);
    groups.set(issue.code, group);
  }
  return [...groups]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([code, group]) => `${code} ${group.count}${group.paths.length ? ` (${group.paths.join(", ")})` : ""}`);
}

export function formatWikiDoctorReport(report: WikiDoctorReport): string {
  const errors = report.lint.issues.filter((issue) => issue.severity === "error");
  const warnings = report.lint.issues.filter((issue) => issue.severity === "warn");
  const lines = [
    `=== llmwiki wiki-doctor [${report.mode.toUpperCase()}] ${report.workspace} ===`,
    `  config    : ${report.configSource}`,
    `  structure : ${report.structureMissing.length ? `${report.structureMissing.length} missing` : "ok"}`,
    `  index     : ${report.index.status}`,
    `  lint      : ${errors.length} error · ${warnings.length} warn · ${report.lint.checked} checked`,
    `  continuity: capture ${report.continuity.capture} · backlog ${report.continuity.backlog} · ` +
      `cited-tail ${report.continuity.citedTails} · reconcilable ${report.continuity.reconcilable}`,
    `  gaps      : ${report.gaps.wellFormed ? `${report.gaps.open} open · ${report.gaps.resolved} resolved` : "malformed"}`,
    `  review    : ${report.review.incompleteLaunch ? "incomplete launch" : report.review.due ? "due" : `current (${report.review.lastCompletedDate})`}`,
  ];
  if (report.database) {
    lines.push(
      `  database  : integrity ${report.database.integrity.ok ? "ok" : "failed"} · ` +
        `${report.database.storage.databaseBytes}B db · ${report.database.storage.freeBytes}B free · ` +
        `${report.database.liveIndexedBytes}B live`,
    );
  } else {
    lines.push("  database  : unavailable");
  }
  if (report.actions.length) {
    lines.push("", "repairs applied:");
    for (const action of report.actions) lines.push(`  ✓ [${action.code}] ${action.message}`);
  }
  if (report.findings.length) {
    lines.push("", "findings:");
    for (const finding of report.findings) {
      const marker = finding.severity === "error" ? "ERROR" : finding.severity === "warn" ? "WARN" : "INFO";
      lines.push(`  ${marker} [${finding.code}] ${finding.message} · owner=${finding.repairOwner}`);
      if (finding.command) lines.push(`       next: ${finding.command}`);
    }
  }
  if (errors.length) {
    lines.push("", "blocking lint errors:");
    for (const issue of errors) lines.push(`  - [${issue.code}] ${issue.path} — ${issue.message}`);
  }
  if (warnings.length) {
    lines.push("", "warning groups:");
    for (const line of groupedLint(warnings)) lines.push(`  - ${line}`);
  }
  lines.push(
    "",
    "=== verdict ===",
    report.blockingErrors
      ? `  ⚠ ${report.blockingErrors} blocking problem group(s); automatic repairs never rewrite evidence-bearing page claims.`
      : report.findings.some((finding) => finding.severity === "warn")
        ? "  ✅ operational; advisory maintenance remains."
        : "  ✅ healthy.",
  );
  return lines.join("\n");
}
