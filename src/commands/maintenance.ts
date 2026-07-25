import * as capture from "../engine/capture.ts";
import { runDoctor, type DoctorHarness } from "../engine/doctor.ts";
import { refreshGapQueue } from "../engine/gaps.ts";
import { migrate } from "../engine/migrate.ts";
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
      console.log(`✓ capture queue pruned: ${result.removed} dead pending row(s) removed, ${result.kept} pending kept (age guard ${days}d)`);
    },
    doctor: (args) => {
      const harness = getFlagValue(args, "--harness") ?? "all";
      if (isDoctorHarness(harness)) {
        process.exit(runDoctor(Boolean(args.flags["--fix"]), harness));
      }
      die("doctor --harness must be one of: all, codex, claude, opencode");
    },
    gaps: (args) => {
      const date = getFlagValue(args, "--date") || new Date().toISOString().slice(0, 10);
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
        return;
      }
      console.log(`=== migrate [${result.verdict === "migrated" ? "COMMIT" : "DRY-RUN"}] ===`);
      for (const pair of result.pairs ?? []) console.log(`  ${pair.from} → ${pair.to}${pair.domain ? `  (domain → ${pair.domain})` : ""}`);
      if (result.strays?.length) console.log(`  ⚠ unmapped: ${result.strays.join(", ")} (use --map old=new)`);
      console.log(`  links rewritten: ${result.linksRewritten}   frontmatter domains: ${result.domainsRewritten}`);
      if (result.quizLedgerRemapped) console.log(`  quiz ledger identities remapped: ${result.quizLedgerRemapped}`);
      if (result.verdict === "migrated") console.log(`  reindexed · lint errors: ${result.lintErrors}`);
      else console.log("  (dry-run — apply with --commit)");
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
        const target = ko ? "[[log.md]] 포인터" : "an [[log.md]] pointer";
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
