import * as capture from "../engine/capture.ts";
import { isSubagentTranscript } from "../engine/source.ts";
import { today } from "../engine/today.ts";
import { runDoctor, type DoctorHarness } from "../engine/doctor.ts";
import { refreshGapQueue } from "../engine/gaps.ts";
import { migrate } from "../engine/migrate.ts";
import { checkBundle, okfApply, WIKI_REL } from "../engine/okf-bundle.ts";
import { appendLog } from "../engine/update.ts";
import { normalizeOverview } from "../engine/overview.ts";
import { compactDatabase, inspectDatabaseHealth } from "../engine/db-maintenance.ts";
import { WikiIndex } from "../engine/db.ts";
import { maintenanceNotice } from "../engine/maintenance-state.ts";
import { applyWikiCleanReview, commitWikiClean, planWikiClean } from "../engine/wiki-clean.ts";
import { formatWikiDoctorReport, runWikiDoctor } from "../engine/wiki-doctor.ts";
import type { ParsedCliArgs } from "../cli-args.ts";

type CommandHandler = (args: ParsedCliArgs) => void;

type MaintenanceDependencies = {
  readonly die: (message: string) => never;
  readonly isKorean: () => boolean;
};

export type MaintenanceHandlers = {
  readonly "capture-prune": CommandHandler;
  readonly doctor: CommandHandler;
  readonly gaps: CommandHandler;
  readonly migrate: CommandHandler;
  readonly okf: CommandHandler;
  readonly "log-append": CommandHandler;
  readonly overview: CommandHandler;
  readonly "db-health": CommandHandler;
  readonly compact: CommandHandler;
  readonly "wiki-clean": CommandHandler;
  readonly "wiki-clean-apply": CommandHandler;
  readonly "wiki-doctor": CommandHandler;
};

function getFlagValue(args: ParsedCliArgs, flag: string): string | undefined {
  const value = args.flags[flag];
  return typeof value === "string" ? value : undefined;
}

function isDoctorHarness(value: string): value is DoctorHarness {
  return value === "all" || value === "codex" || value === "claude" || value === "opencode";
}

export function createMaintenanceHandlers(dependencies: MaintenanceDependencies): MaintenanceHandlers {
  const { die, isKorean } = dependencies;

  return {
    "db-health": (args) => {
      const workspace = args.positionals[0] ?? die("db-health <workspace> required");
      const index = new WikiIndex(workspace);
      const db = index.connect();
      const report = inspectDatabaseHealth(db);
      db.close();
      console.log(`db-health: integrity ${report.integrity.ok ? "ok" : "failed"} · ${report.storage.databaseBytes}B database · ${report.storage.freeBytes}B free · ${report.liveIndexedBytes}B live`);
      if (args.flags["--notice"]) {
        const full = maintenanceNotice(workspace, report);
        if (full) console.log(`  compaction ${report.compactionEligible ? "eligible — run compact --commit" : "not eligible — compact remains dry-run by default"}`);
      }
    },
    compact: (args) => {
      const workspace = args.positionals[0] ?? die("compact <workspace> [--commit]");
      const index = new WikiIndex(workspace);
      const db = index.connect();
      const result = compactDatabase(db, { commit: Boolean(args.flags["--commit"]) });
      db.close();
      switch (result.kind) {
        case "refused":
          die("compact refused: database integrity failed");
        case "not_needed":
          console.log("compact: no-action — not needed (below the compaction thresholds)");
          return;
        case "dry-run":
          console.log("compact: dry-run — eligible; rerun with --commit to optimize FTS and VACUUM");
          return;
        case "compacted":
          console.log(`compact: committed ${result.before.storage.databaseBytes}B → ${result.after.storage.databaseBytes}B`);
          return;
        default:
          throw new Error("unreachable compaction result");
      }
    },
    "wiki-clean": (args) => {
      const workspace = args.positionals[0] ?? die("wiki-clean <workspace> [--date YYYY-MM-DD] [--commit]");
      const date = getFlagValue(args, "--date");
      const result = args.flags["--commit"] ? commitWikiClean(workspace, { today: date }) : planWikiClean(workspace, { today: date });
      console.log(`wiki-clean [${args.flags["--commit"] ? "COMMIT" : "DRY-RUN"}]: protected ${result.protected.length} · auto ${result.automatic.length} · ambiguous ${result.ambiguous.length} · projected savings ${result.projectedSavingsBytes}B`);
      if ("reviewPath" in result && result.reviewPath !== null) console.log(`  review: ${result.reviewPath}`);
    },
    "wiki-clean-apply": (args) => {
      const workspace = args.positionals[0] ?? die("wiki-clean-apply <workspace> --review <file> --commit");
      const reviewPath = getFlagValue(args, "--review") ?? die("wiki-clean-apply --review <file> required");
      if (!args.flags["--commit"]) die("wiki-clean-apply requires --commit");
      const result = applyWikiCleanReview(workspace, { reviewPath });
      console.log(`wiki-clean-apply: applied ${result.applied.length} accepted candidate(s)`);
    },
    "wiki-doctor": (args) => {
      const report = runWikiDoctor(args.positionals[0] ?? process.cwd(), {
        fix: Boolean(args.flags["--fix"]),
        today: getFlagValue(args, "--date"),
      });
      console.log(formatWikiDoctorReport(report));
      if (report.blockingErrors) process.exit(1);
    },
    "capture-prune": (args) => {
      const raw = getFlagValue(args, "--older-than");
      const days = raw === undefined ? 30 : Number.parseInt(raw, 10);
      if (Number.isNaN(days) || days < 0) {
        die("capture-prune [--older-than <days>] — days must be a non-negative number");
      }
      const result = capture.prune(days);
      const subagents = capture.skipPendingSubagents((r) => isSubagentTranscript(r.source_kind, r.transcript_path));
      console.log(
        `✓ capture queue pruned: ${result.removed} expired row(s) recorded as lost (kept as an audit ledger, never deleted), ` +
          `${result.skippedEphemeral} deleted temp-repo row(s) marked skipped, ${subagents} sub-agent thread(s) marked skipped, ` +
          `${result.kept - subagents} pending kept (age guard ${days}d)`,
      );
      // The queue is metadata; the OpenCode exports are conversation TEXT and expire on their own
      // clock (30 days by the newest member of an export/meta pair). The daemon does this daily —
      // doing it here too means the explicit maintenance path is not weaker than the automatic one.
      const exports_ = capture.pruneExports();
      console.log(
        `✓ transcript exports pruned: ${exports_.pairs} expired pair(s) removed (${exports_.rows} pending row(s) cleared)\n` +
          `  capture.db metadata and daemon.log have no automatic expiry — remove them with \`setup.sh --uninstall --purge-data\``,
      );
    },
    doctor: (args) => {
      const harness = getFlagValue(args, "--harness") ?? "all";
      if (isDoctorHarness(harness)) {
        process.exit(
          runDoctor(Boolean(args.flags["--fix"]), harness, {
            installationOnly: Boolean(args.flags["--installation-only"]),
          }),
        );
      }
      die("doctor --harness must be one of: all, codex, claude, opencode");
    },
    gaps: (args) => {
      const date = getFlagValue(args, "--date") || today();
      const result = refreshGapQueue(args.positionals[0] ?? die("gaps <workspace> required"), date, {
        check: Boolean(args.flags["--check"]),
      });
      if (result.verdict === "skip") {
        console.log(`  ⏭  ${result.reason}`);
        return;
      }
      const ko = isKorean();
      console.log(
        ko
          ? `  ✅ 갭 큐 갱신: open ${result.open} (신규 ${result.added}) · resolved ${result.resolved} → ${result.path}`
          : `  ✅ gap queue: open ${result.open} (new ${result.added}) · resolved ${result.resolved} → ${result.path}`,
      );
      if (result.open) {
        console.log(
          ko
            ? `  ※ 사실 갭(개념 페이지·교차링크)은 LLM의 북키핑 — 다음 /wiki-deep 가 직접 채움 (사람 판단은 모순·방향성만; 채워지면 자동 close)`
            : `  ※ fact gaps (concept pages·cross-links) are the LLM's bookkeeping — the next /wiki-deep fills them (humans judge only contradictions·direction; auto-closes once filled)`,
        );
      }
    },
    migrate: (args) => {
      const workspace = args.positionals[0] ?? die("migrate <workspace> [--commit] [--map old=new,old=new]");
      const mappings = getFlagValue(args, "--map") ?? "";
      const map: Record<string, string> = {};
      for (const pair of mappings.split(",").map((value) => value.trim()).filter(Boolean)) {
        const equalsIndex = pair.indexOf("=");
        if (equalsIndex > 0) map[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1);
      }
      const result = migrate(workspace, { commit: Boolean(args.flags["--commit"]), map });
      if (result.verdict === "skip") return console.log(`skip: ${result.reason}`);
      if (result.verdict === "conforms") {
        console.log(`✓ structure already conforms to the config${args.flags["--commit"] ? " (schema-version stamped)" : ""}`);
        if (result.strays?.length) console.log(`  ⚠ unmapped numbered dir(s) left untouched: ${result.strays.join(", ")} (use --map old=new)`);
        if (result.straysRemoved?.length) console.log(`  removed empty unmapped dir(s): ${result.straysRemoved.join(", ")}`);
        return;
      }
      console.log(`=== migrate [${result.verdict === "migrated" ? "COMMIT" : "DRY-RUN"}] ===`);
      for (const pair of result.pairs ?? []) console.log(`  ${pair.from} → ${pair.to}${pair.domain ? `  (domain → ${pair.domain})` : ""}`);
      if (result.strays?.length) console.log(`  ⚠ unmapped: ${result.strays.join(", ")} (use --map old=new)`);
      if (result.straysRemoved?.length) console.log(`  removed empty unmapped dir(s): ${result.straysRemoved.join(", ")}`);
      console.log(`  links rewritten: ${result.linksRewritten}   frontmatter domains: ${result.domainsRewritten}`);
      if (result.quizLedgerRemapped) console.log(`  quiz ledger identities remapped: ${result.quizLedgerRemapped}`);
      if (result.verdict === "migrated") console.log(`  reindexed · lint errors: ${result.lintErrors}`);
      else console.log("  (dry-run — apply with --commit)");
    },
    okf: (args) => {
      const bundle = getFlagValue(args, "--bundle");
      const ws = args.positionals[0];
      if (!bundle && !ws) die("okf <workspace> [--commit] [--if-okf] | okf --bundle DIR [--json]");
      const ko = isKorean();
      if (bundle) {
        // Any directory, any producer: report conformance (§11) without touching a byte.
        const r = checkBundle(bundle);
        if (args.flags["--json"]) return console.log(JSON.stringify(r, null, 2));
        const errors = r.issues.filter((i) => i.severity === "error");
        const warns = r.issues.length - errors.length;
        console.log(
          `okf: ${r.conformant}/${r.concepts} ${ko ? "개념 적합" : "concepts conformant"} · okf_version ${r.okfVersion ?? "-"} · ` +
            `${ko ? "링크" : "edges"} ${r.edges} (${ko ? "깨짐" : "broken"} ${r.brokenEdges}) · ` +
            `trust ${r.tiers["human-reviewed"]}h/${r.tiers["machine-confirmed"]}m/${r.tiers.unverified}u · stale ${r.stale} · deprecated ${r.deprecated}`,
        );
        const byRule = new Map<string, number>();
        for (const i of r.issues) byRule.set(`${i.severity} ${i.rule}`, (byRule.get(`${i.severity} ${i.rule}`) ?? 0) + 1);
        for (const [rule, n] of [...byRule].sort()) console.log(`  ${rule}: ${n}`);
        for (const i of errors.slice(0, 10)) console.log(`  ✗ ${i.path}: ${i.message}`);
        if (errors.length || warns) process.exitCode = errors.length ? 1 : 0;
        return;
      }
      const commit = Boolean(args.flags["--commit"]);
      const r = okfApply(ws!, { commit, ifOkf: Boolean(args.flags["--if-okf"]), actor: getFlagValue(args, "--actor") });
      if (args.flags["--json"]) return console.log(JSON.stringify(r, null, 2));
      if (r.verdict === "skip") return console.log(`okf: skip — ${r.reason}`);
      if (r.verdict === "legacy-skip") {
        return console.log(
          ko
            ? "okf: 아직 OKF로 전환되지 않은 위키 — 건너뜀. 전환: `llmwiki okf <repo>`(dry-run) → `--commit`"
            : "okf: wiki not converted to OKF yet — skipped. Convert: `llmwiki okf <repo>` (dry-run) → `--commit`",
        );
      }
      if (r.verdict === "conforms") return console.log(ko ? `okf: ✓ OKF v0.2 적합 (${r.pages}페이지, 변경 없음)` : `okf: ✓ OKF v0.2 conformant (${r.pages} pages, nothing to change)`);
      const mode = r.verdict === "applied" ? "COMMIT" : "DRY-RUN";
      console.log(`=== okf [${mode}] ${r.wasOkf ? (ko ? "정규화" : "normalize") : ko ? "OKF v0.2 전환" : "convert to OKF v0.2"} ===`);
      const c = r.changes;
      console.log(`  ${ko ? "페이지" : "pages"} ${r.pagesChanged}/${r.pages}: type ${c.type ?? 0} · status ${c.status ?? 0} · domain→type ${c["domain-dropped"] ?? 0} · sources ${c.sources ?? 0} · generated ${c.generated ?? 0} · verified ${c.verified ?? 0} · YAML ${ko ? "복구" : "repaired"} ${c["yaml-repaired"] ?? 0} · frontmatter ${ko ? "추가" : "added"} ${c["frontmatter-added"] ?? 0}`);
      console.log(`  [[wikilink]] → markdown: ${r.linksConverted}${r.linksUnresolved ? ` (${ko ? "대상 없음 유지" : "unresolved, kept"} ${r.linksUnresolved})` : ""}`);
      console.log(`  log.md: ${r.logConverted ? (ko ? `${r.logEntries}건 → 날짜별·최신순` : `${r.logEntries} entries → dated, newest first`) : ko ? "변경 없음" : "unchanged"} · index.md: ${r.indexesWritten}${r.coldIndexRemoved ? ` · cold-index.md ${ko ? "제거(index.md가 대체)" : "removed (index.md supersedes)"}` : ""}`);
      for (const to of r.indexesPreserved) {
        console.log(ko ? `  ⚠ 직접 쓴 index.md 보존 → ${to} (OKF가 index.md를 생성 목록으로 예약)` : `  ⚠ hand-written index.md kept as ${to} (OKF reserves index.md for the generated listing)`);
      }
      if (r.logKept) {
        console.log(ko ? "  ⚠ log.md는 재작성 시 줄이 줄어들어 그대로 둠 — 손으로 확인 필요" : "  ⚠ log.md left as is: a re-render would have dropped lines — check it by hand");
      }
      if (r.verdict === "planned") console.log(ko ? "  (dry-run — 적용: --commit)" : "  (dry-run — apply with --commit)");
      else console.log(ko ? `  ✓ 적용 완료 — 확인: llmwiki okf --bundle ${ws}/${WIKI_REL}` : `  ✓ applied — verify: llmwiki okf --bundle ${ws}/${WIKI_REL}`);
    },
    "log-append": (args) => {
      const [workspace, kind, title, ...detail] = args.positionals;
      if (!workspace || !kind || !title) die("log-append <workspace> <kind> <title> [detail...] [--date YYYY-MM-DD]");
      const date = getFlagValue(args, "--date") ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die("--date must be YYYY-MM-DD");
      appendLog(workspace!, kind!, title!, detail, date);
      console.log(`log: ${date} ${kind} | ${title}`);
    },
    overview: (args) => {
      const workspace = args.positionals[0] ?? die("overview <workspace> required");
      const check = Boolean(args.flags["--check"]);
      const result = normalizeOverview(workspace, { check });
      if (result.verdict === "skip") {
        console.log(`  ⏭  ${result.reason}`);
        return;
      }
      const ko = isKorean();
      if (result.verdict === "unchanged") {
        console.log(ko ? "  ✓ overview 정상 (정규화 불필요)" : "  ✓ overview already normalized");
      } else {
        const verb = check ? (ko ? "정규화 필요" : "would normalize") : ko ? "정규화함" : "normalized";
        const target = ko ? "[Log](log.md) 포인터" : "a [Log](log.md) pointer";
        console.log(`  ✅ ${verb}: Recent Updates → ${target} (${result.before}B → ${result.after}B)`);
      }
      if (result.oversized) {
        console.log(
          ko
            ? "  ⚠️  overview가 여전히 예산 초과 — Key Findings를 토픽 페이지로 분산 권장"
            : "  ⚠️  overview still over budget — move Key Findings detail into topic pages",
        );
      }
    },
  };
}
