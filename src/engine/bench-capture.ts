// Deterministic capture-scale benchmark for the three automatic transcript adapters.
//
// This suite measures the part bench-scale intentionally does not: historical session discovery,
// revision gating, bounded sample materialization, and the fixed cost of launching the hook CLI.
// Timings remain observational. The structural counts are deterministic evidence and can become
// regression assertions without making CI timing-sensitive: `initial_candidates` is how many routes
// a cold gate admits, and `second_pass_candidates` is how many survive a gate that has already seen
// them — so gating works exactly when the first equals `discovered` and the second is zero.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLONE_ROOT } from "./paths.ts";
import { enroll, resetEnrollmentCache } from "./enrollment.ts";
import { resetProjectStateCache } from "./project-state.ts";
import { setEffectiveStateRoot } from "./state-dir.ts";
import { routeNeedsMaterialization, type DiscoveredRoute, type TranscriptSource } from "./source.ts";
import { summarizeSamples, type SampleSummary } from "./bench-scale.ts";
import { claudeJsonlSource, discoverClaudeRoutes } from "./sources/claude.ts";
import { codexSource, discoverCodexFileRoutes } from "./sources/codex.ts";
import {
  discoverOpenCodeRoutes,
  materializeOpenCodeRoute,
  materializeOpenCodeRoutes,
  opencodeSource,
  setExportDir,
} from "./sources/opencode.ts";

export const CAPTURE_SCALE_TIERS = [100, 1_000, 10_000] as const;
export const CAPTURE_SAMPLE_MATERIALIZATIONS = 10;

export type CaptureHarness = "claude" | "codex" | "opencode";

export interface CaptureHarnessReport {
  readonly discovered: number;
  /** Routes a cold revision gate admits — every discovered route, since it has observed none. */
  readonly initial_candidates: number;
  /** Routes that STILL demand materialization once the gate has observed them. Zero means the
   *  revision gate recognized every unchanged route; a non-zero value is a gating regression. */
  readonly second_pass_candidates: number;
  readonly sample_materializations: number;
  readonly successful_materializations: number;
  readonly timings_ms: {
    readonly discover: SampleSummary;
    readonly sample_materialize: SampleSummary;
  };
  readonly source_bytes: number;
}

export interface CaptureScaleReport {
  readonly schema_version: 1;
  readonly sessions: number;
  readonly repeats: number;
  readonly harnesses: Readonly<Record<CaptureHarness, CaptureHarnessReport>>;
}

export interface CaptureScaleSuiteReport {
  readonly schema_version: 2;
  readonly repeats: number;
  readonly tiers: readonly CaptureScaleReport[];
  readonly entrypoints: {
    readonly public_cli: "src/cli.ts";
    readonly automatic_hook: "src/hook-cli.ts";
  };
  readonly public_cli_ms: {
    readonly version: SampleSummary;
  };
  readonly hook_cli_ms: {
    readonly cold_start: SampleSummary;
    readonly empty_turn: SampleSummary;
    readonly enrollment_probe: SampleSummary;
  };
  readonly gating: "structural counts are deterministic; timing and byte distributions are observational";
}

type Fixture = {
  readonly root: string;
  readonly repo: string;
  readonly claudeProjects: string;
  readonly codexSessions: string;
  readonly opencodeDb: string;
};

function elapsed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
}

function initRepo(path: string): string {
  const result = spawnSync("git", ["init", "-q", path], { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git init failed: ${result.stderr ?? ""}`);
  const enrolled = enroll(path);
  if (!enrolled.ok) throw new Error(`capture-scale enrollment failed: ${enrolled.error}`);
  return path;
}

function seedOpenCode(path: string, repo: string, sessions: number): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER);
    BEGIN;
  `);
  const addSession = db.prepare("INSERT INTO session VALUES (?,?,?,?,NULL)");
  const addMessage = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
  try {
    for (let index = 0; index < sessions; index += 1) {
      const id = `capture-session-${String(index).padStart(6, "0")}`;
      addSession.run(id, repo, `Capture fixture ${index}`, index);
      addMessage.run(`${id}-u`, id, "user", 1, JSON.stringify({ text: `fixture prompt ${index}` }), index * 2);
      addMessage.run(
        `${id}-a`,
        id,
        "assistant",
        2,
        JSON.stringify({ content: [{ type: "text", text: `fixture answer ${index}` }] }),
        index * 2 + 1,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function seedFixture(root: string, sessions: number): Fixture {
  const repo = initRepo(join(root, "repo"));
  const claudeProjects = join(root, "claude", "projects", "capture-fixture");
  const codexSessions = join(root, "codex", "sessions", "2026", "08", "17");
  mkdirSync(claudeProjects, { recursive: true });
  mkdirSync(codexSessions, { recursive: true });

  for (let index = 0; index < sessions; index += 1) {
    const id = `capture-session-${String(index).padStart(6, "0")}`;
    const claude = [
      { type: "user", cwd: repo, sessionId: id, message: { role: "user", content: `fixture prompt ${index}` } },
      { type: "assistant", cwd: repo, sessionId: id, message: { role: "assistant", content: `fixture answer ${index}` } },
    ];
    writeFileSync(join(claudeProjects, `${id}.jsonl`), claude.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const codex = [
      { type: "session_meta", payload: { id, cwd: repo } },
      { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: `fixture answer ${index}` }] } },
    ];
    writeFileSync(join(codexSessions, `${id}.jsonl`), codex.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }

  const opencodeDb = join(root, "opencode.db");
  seedOpenCode(opencodeDb, repo, sessions);
  return { root, repo, claudeProjects, codexSessions, opencodeDb };
}

function treeBytes(path: string): number {
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += treeBytes(join(path, entry.name));
  }
  return total;
}

function measureHarness(
  source: TranscriptSource,
  discover: () => DiscoveredRoute[],
  sourcePath: string,
  repeats: number,
): CaptureHarnessReport {
  const discoverySamples: number[] = [];
  const materializationSamples: number[] = [];
  let discovered = -1;
  let initialCandidates = -1;
  let secondPassCandidates = -1;
  let sampleMaterializations = 0;
  let successfulMaterializations = 0;

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const discovery = elapsed(discover);
    discoverySamples.push(discovery.ms);
    const routes = discovery.value;
    const revisions: Record<string, string | number> = {};
    const initial = routes.filter((route) => routeNeedsMaterialization(route, revisions));
    // Same map, second look: every route the gate just recorded must now be recognized as unchanged.
    const secondPass = routes.filter((route) => routeNeedsMaterialization(route, revisions));
    const sample = initial.slice(0, CAPTURE_SAMPLE_MATERIALIZATIONS);
    const materialization = elapsed(() =>
      source.materializeMany
        ? source.materializeMany(sample).map((result) => result.session)
        : sample.map((route) => source.materialize(route)),
    );
    materializationSamples.push(materialization.ms);

    if (discovered < 0) {
      discovered = routes.length;
      initialCandidates = initial.length;
      secondPassCandidates = secondPass.length;
      sampleMaterializations = sample.length;
      successfulMaterializations = materialization.value.filter(Boolean).length;
    } else if (
      discovered !== routes.length ||
      initialCandidates !== initial.length ||
      secondPassCandidates !== secondPass.length ||
      sampleMaterializations !== sample.length
    ) {
      throw new Error(`capture-scale structural counts changed between repeats for ${source.kind}`);
    }
  }

  return {
    discovered,
    initial_candidates: initialCandidates,
    second_pass_candidates: secondPassCandidates,
    sample_materializations: sampleMaterializations,
    successful_materializations: successfulMaterializations,
    timings_ms: {
      discover: summarizeSamples(discoverySamples),
      sample_materialize: summarizeSamples(materializationSamples),
    },
    source_bytes: treeBytes(sourcePath),
  };
}

function measureCommand(
  entrypoint: "cli.ts" | "hook-cli.ts",
  args: readonly string[],
  repeats: number,
  input?: string,
): SampleSummary {
  const samples: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const result = elapsed(() =>
      spawnSync(process.execPath, [join(CLONE_ROOT, "src", entrypoint), ...args], {
        cwd: CLONE_ROOT,
        encoding: "utf-8",
        input,
      }),
    );
    if (result.value.status !== 0) {
      throw new Error(`${entrypoint} ${args[0] ?? ""} failed: ${result.value.stderr ?? ""}`);
    }
    samples.push(result.ms);
  }
  return summarizeSamples(samples);
}

export function runCaptureScaleSuite(
  repeats = 3,
  tiers: readonly number[] = CAPTURE_SCALE_TIERS,
): CaptureScaleSuiteReport {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error("capture-scale repeats must be positive");
  if (!tiers.length || tiers.some((tier) => !Number.isInteger(tier) || tier < 1)) {
    throw new Error("capture-scale tiers must be positive integers");
  }

  const scratch = mkdtempSync(join(tmpdir(), "llmwiki-capture-scale-"));
  setEffectiveStateRoot(join(scratch, "state"));
  setExportDir(join(scratch, "state", "opencode-export"));
  try {
    const reports: CaptureScaleReport[] = [];
    let probeRepo = "";
    for (const sessions of tiers) {
      const fixture = seedFixture(join(scratch, `tier-${sessions}`), sessions);
      probeRepo ||= fixture.repo;
      const opencodeFixtureSource: TranscriptSource = {
        ...opencodeSource,
        materialize: (route) => materializeOpenCodeRoute(route, [realpathSync(fixture.opencodeDb)]),
        materializeMany: (routes) => materializeOpenCodeRoutes(routes, [realpathSync(fixture.opencodeDb)]),
      };
      const harnesses = {
        claude: measureHarness(
          claudeJsonlSource,
          () => discoverClaudeRoutes([fixture.claudeProjects]),
          fixture.claudeProjects,
          repeats,
        ),
        codex: measureHarness(
          codexSource,
          () => discoverCodexFileRoutes(fixture.codexSessions),
          fixture.codexSessions,
          repeats,
        ),
        opencode: measureHarness(
          opencodeFixtureSource,
          () => discoverOpenCodeRoutes([fixture.opencodeDb]),
          fixture.opencodeDb,
          repeats,
        ),
      } satisfies Record<CaptureHarness, CaptureHarnessReport>;
      reports.push({ schema_version: 1, sessions, repeats, harnesses });
    }

    return {
      schema_version: 2,
      repeats,
      tiers: reports,
      entrypoints: { public_cli: "src/cli.ts", automatic_hook: "src/hook-cli.ts" },
      public_cli_ms: {
        version: measureCommand("cli.ts", ["--version"], repeats),
      },
      hook_cli_ms: {
        cold_start: measureCommand(
          "hook-cli.ts",
          ["context-hook", probeRepo],
          repeats,
          JSON.stringify({ cwd: probeRepo, session_id: "capture-benchmark" }),
        ),
        empty_turn: measureCommand("hook-cli.ts", ["turn-context-hook", probeRepo], repeats, ""),
        enrollment_probe: measureCommand("hook-cli.ts", ["enabled", probeRepo], repeats),
      },
      gating: "structural counts are deterministic; timing and byte distributions are observational",
    };
  } finally {
    resetEnrollmentCache();
    resetProjectStateCache();
    setEffectiveStateRoot(null);
    rmSync(scratch, { recursive: true, force: true });
  }
}
