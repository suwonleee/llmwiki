#!/usr/bin/env bun
// llmwiki capture daemon — environment-agnostic auto-capture.
// Discovery/format now live behind the TranscriptSource abstraction (engine/source).
// The daemon only sweeps `sources()` and enqueues update debt to the central capture
// queue (engine/capture). No per-client hook required. Never calls an LLM — only records
// debt. Today the only auto-discovering source is claude-jsonl, so the
// default sweep is byte-identical to the pre-abstraction daemon. Zero-dep by default (fs
// size polling, 30s); uses chokidar for instant capture only if it happens to be installed.
import { existsSync } from "node:fs";
import * as capture from "../engine/capture.ts";
import { rotateDaemonLog } from "../engine/state-dir.ts";
import { reassertClaudeReadHooks } from "../engine/doctor.ts";
import { checkEngineUpdate } from "../engine/update-check.ts";
import { runProjectMaintenance } from "../engine/project-maintenance.ts";
import { isEnrolled, isEnrolledFresh, resetEnrollmentCache } from "../engine/enrollment.ts";
import {
  sources,
  discoverableSources,
  routeNeedsMaterialization,
  type DiscoveredRoute,
  type DiscoveredSession,
  type MaterializationResult,
} from "../engine/source.ts";

const THRESHOLD_LINES = 50; // skip trivial Q&A sessions (work-volume signal)
const POLL_SECONDS = 30;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} INFO llmwiki-daemon: ${msg}`);
}

export interface SweepCounts {
  discovered: number;
  enqueued: number;
  skippedShort: number;
  skippedUnenrolled: number;
  routeUnresolved: number;
  failed: number;
}

function emptyCounts(): SweepCounts {
  return { discovered: 0, enqueued: 0, skippedShort: 0, skippedUnenrolled: 0, routeUnresolved: 0, failed: 0 };
}

// The two-stage sweep. Stage 1 (discoverRoutes) learns only where a session belongs; the
// enrollment predicate then decides whether stage 2 (materialize) may look at the session at
// all. Everything an unenrolled repository contributes to this process is a counter.
//
// Logging is deliberately AGGREGATE for the rejected side: printing the repository path of a
// session we refused to read would put the very inventory we are protecting into daemon.log.
function sweep(lastRevisions?: Record<string, string | number>): SweepCounts {
  const counts = emptyCounts();
  const durableRevisionUpdates: capture.RouteRevision[] = [];
  // Enrollment is cached per process; a sweep is the natural refresh point, so `llmwiki init`
  // takes effect on the next poll without restarting the daemon.
  resetEnrollmentCache();
  for (const s of sources()) {
    const candidates: DiscoveredRoute[] = [];
    for (let route of s.discoverRoutes()) {
      counts.discovered += 1;
      // Stage-1 could not tell whose session this is. Before giving up, check whether a harness
      // already told us during that session's SessionStart hook — the answer we were handed beats
      // the answer we infer from a file format we do not own.
      const hinted = route.repo ?? capture.routeHintFor(route.path)?.repo ?? null;
      if (!hinted) {
        counts.routeUnresolved += 1;
        continue;
      }
      route = { ...route, repo: hinted };
      // Enrollment is decided HERE — after routing (however the repository was learned) and before
      // materialization. tests/repo-io-static-boundary.test.ts pins this ordering by grep.
      if (!isEnrolled(route.repo)) {
        counts.skippedUnenrolled += 1;
        continue;
      }
      // Poll-mode short circuit: an enrolled transcript whose size has not moved since the last
      // sweep has nothing new to count or enqueue.
      if (!routeNeedsMaterialization(route, lastRevisions)) continue;
      candidates.push(route);
    }
    if (!candidates.length) continue;
    let materialized: MaterializationResult[];
    if (s.materializeMany) {
      try {
        materialized = s.materializeMany(candidates);
      } catch (e) {
        counts.failed += candidates.length;
        log(`materialize batch FAILED [${s.kind}]: ${e}`);
        if (lastRevisions) for (const route of candidates) delete lastRevisions[route.path];
        continue;
      }
    } else {
      materialized = candidates.map((route) => {
        try {
          return { session: s.materialize(route) };
        } catch (error) {
          return { session: null, error };
        }
      });
    }
    for (let index = 0; index < candidates.length; index += 1) {
      const route = candidates[index]!;
      const result = materialized[index] ?? { session: null, error: new Error("missing materialization result") };
      if (result.error) {
        counts.failed += 1;
        log(`materialize FAILED [${s.kind}]: ${result.error}`);
        if (lastRevisions) delete lastRevisions[route.path];
        continue;
      }
      const session: DiscoveredSession | null = result.session;
      if (!session) {
        counts.routeUnresolved += 1;
        if (lastRevisions && route.revision !== undefined) delete lastRevisions[route.path];
        continue;
      }
      const outcome = processGuarded(session, s.kind);
      if (outcome === "enqueued") counts.enqueued += 1;
      else if (outcome === "failed") counts.failed += 1;
      else if (outcome === "skipped_unenrolled") counts.skippedUnenrolled += 1;
      else counts.skippedShort += 1;
      if (route.revision !== undefined && (outcome === "enqueued" || outcome === "skipped_short")) {
        durableRevisionUpdates.push({ path: route.path, revision: route.revision });
      } else if (lastRevisions && route.revision !== undefined) {
        // A failed enqueue or an enrollment revocation must retry rather than becoming an
        // in-memory false success for the lifetime of the daemon.
        delete lastRevisions[route.path];
      }
    }
  }
  try {
    capture.recordRouteRevisions("opencode", durableRevisionUpdates);
  } catch (error) {
    // Do not let a transient capture.db failure turn the in-memory gate into a false durable
    // success. Forget these tokens so the next poll retries the complete capture path.
    if (lastRevisions) {
      for (const row of durableRevisionUpdates) delete lastRevisions[row.path];
    }
    throw error;
  }
  return counts;
}

function process_(d: DiscoveredSession, kind: string): "enqueued" | "skipped_short" | "skipped_unenrolled" {
  if (d.lines < THRESHOLD_LINES) return "skipped_short";
  // Re-check immediately before the write. Materialization can take a while on a large session,
  // and `llmwiki disable` during that window must not still land a row.
  if (!isEnrolledFresh(d.repo)) return "skipped_unenrolled";
  const outcome = capture.enqueue(d.path, d.sessionId, d.repo, d.lines, kind);
  // Every sweep re-offers every discovered session, so most calls record nothing. Announcing
  // those too buried the real events: idle sessions were re-logged every minute, and daemon.log
  // reached 11 MB of lines that described no change. The row is still offered exactly as before —
  // only the narration is now conditional, so "captured" in the log means something happened.
  if (outcome !== "unchanged") {
    log(`captured sess=${(d.sessionId || "?").slice(0, 8)} repo=${d.repo} lines=${d.lines} [${kind}] ${outcome}`);
  }
  return "enqueued";
}

// The daemon IS the capture loop, so one session must never take it down: a locked database, a
// file that vanished mid-sweep, an unwritable state dir. A throw here used to kill the process,
// and capture then stops SILENTLY — transcripts keep rotating per the harness's own retention, so
// the sessions are simply gone while the wiki merely looks quiet. Log it, count it, carry on.
function processGuarded(
  d: DiscoveredSession,
  kind: string,
): "enqueued" | "skipped_short" | "skipped_unenrolled" | "failed" {
  try {
    return process_(d, kind);
  } catch (e) {
    log(`capture FAILED sess=${(d.sessionId || "?").slice(0, 8)} repo=${d.repo} [${kind}]: ${e}`);
    return "failed";
  }
}

// The sweep report has to survive an unusable queue too, or the reporting itself becomes the
// crash that hides why nothing was captured.
function queueStats(): string {
  try {
    return JSON.stringify(capture.stats());
  } catch (e) {
    return `unavailable (${e})`;
  }
}

function runCycle(lastRevisions?: Record<string, string | number>): SweepCounts {
  const counts = sweep(lastRevisions);
  // Retention is deliberately after materialization: legacy exports can be migration evidence.
  pruneExportsIfDue();
  return counts;
}

function runOnce(): SweepCounts {
  return runCycle();
}

async function pollLoop(): Promise<void> {
  let lastRevisions: Record<string, string | number> = {};
  try {
    lastRevisions = capture.routeRevisions("opencode");
  } catch (e) {
    // Safe fallback: a damaged/unavailable state DB costs one conservative rescan, not capture.
    log(`route revision restore FAILED (using conservative sweep): ${e}`);
  }
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Discovery walks other tools' directories, so it can throw on a permission or race too —
    // a failed sweep costs one poll interval, never the loop.
    try {
      runCycle(lastRevisions);
    } catch (e) {
      log(`sweep FAILED (retrying next poll): ${e}`);
    }
    reassertWiringIfDue();
    checkEngineUpdateIfDue();
    maintainProjectStateIfDue();
    await Bun.sleep(POLL_SECONDS * 1000);
  }
}

// A live session writes settings.json back from its in-memory snapshot on any in-session change,
// silently dropping hooks added on disk after it started — including what setup.sh installed from
// inside that session. Re-assert daily, from the loop ONLY: `--once` runs inside tests and
// one-shot sweeps, and a sweep must never edit the user's profiles.
const WIRING_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastWiringAt = 0;

function reassertWiringIfDue(): void {
  const now = Date.now();
  if (now - lastWiringAt < WIRING_INTERVAL_MS) return;
  lastWiringAt = now;
  try {
    for (const note of reassertClaudeReadHooks()) log(`wiring self-heal: ${note}`);
  } catch (e) {
    log(`wiring self-heal FAILED (will retry tomorrow): ${e}`);
  }
}

// Engine update check — automatic CHECK, manual APPLY (engine/update-check.ts explains why the
// apply half must stay a human act). Daily, from the loop ONLY: `--once` runs inside tests and
// one-shot sweeps, and a test sweep must never touch the network.
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastUpdateCheckAt = 0;

function checkEngineUpdateIfDue(): void {
  const now = Date.now();
  if (now - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheckAt = now;
  try {
    const rec = checkEngineUpdate();
    if (rec) log(`update check: local v${rec.localVersion} · origin/main v${rec.remoteVersion} (${rec.behind} behind)`);
    else log("update check: no answer (offline, no origin, or unparsable) — retrying tomorrow");
  } catch (e) {
    log(`update check FAILED (will retry tomorrow): ${e}`);
  }
}

// Per-project index maintenance — compact, evict idle, collect orphans (engine/project-maintenance.ts).
// Daily, from the loop ONLY, for the same reason as the two above: `--once` runs inside tests and
// one-shot sweeps, and neither should delete anything. This is the whole point of holding project
// state centrally — while it lived inside each repository the daemon could not see it, so nothing
// ever reclaimed it and every index grew until a human happened to run /wiki-deep in that repo.
const PROJECT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastProjectMaintenanceAt = 0;

function maintainProjectStateIfDue(): void {
  const now = Date.now();
  if (now - lastProjectMaintenanceAt < PROJECT_MAINTENANCE_INTERVAL_MS) return;
  lastProjectMaintenanceAt = now;
  try {
    const r = runProjectMaintenance();
    if (r.compacted + r.evicted + r.collected > 0) {
      log(
        `index maintenance: compacted ${r.compacted} (${r.reclaimedBytes}B) · ` +
          `evicted ${r.evicted} (${r.evictedBytes}B, rebuilt on next use) · ` +
          `collected ${r.collected} orphan(s) (${r.collectedBytes}B)`,
      );
    }
  } catch (e) {
    log(`index maintenance FAILED (will retry tomorrow): ${e}`);
  }
}

async function watchLoop(): Promise<void> {
  // Optional fast path: instant capture via chokidar if it's installed. Never a hard
  // dep — fall back to polling (always correct, 30s latency is fine for capture).
  // Watch roots come from every auto-discovering source (claude profiles + codex sessions,
  // …); a changed file is resolved to its adapter via the source probe chain (plain never
  // auto-captures). With only Claude present this is byte-identical to before.
  try {
    // Variable specifier so tsc doesn't statically require the optional module.
    const chokidarSpec = "chokidar";
    const mod: any = await import(chokidarSpec).catch(() => null);
    const chokidar = mod?.default ?? mod;
    const dirs = discoverableSources().flatMap((s) => s.watchRoots?.() ?? []);
    if (chokidar && dirs.length) {
      log(`chokidar mode on: ${dirs.join(", ")}`);
      const watcher = chokidar.watch(dirs, { ignoreInitial: true });
      // Same two stages as the poll sweep, one file at a time: route (bounded metadata), check
      // enrollment, and only then materialize. probe() would read the whole transcript, which is
      // exactly what an unenrolled session must not cost.
      const onChange = (p: string) => {
        if (!p.endsWith(".jsonl") || !existsSync(p)) return;
        resetEnrollmentCache();
        for (const s of discoverableSources()) {
          const found = s.routeFor?.(p);
          if (!found) continue;
          // Same order as the sweep: inference first, then what the harness told us at SessionStart.
          const hinted = found.repo ?? capture.routeHintFor(found.path)?.repo ?? null;
          if (!hinted) return;
          const route = { ...found, repo: hinted };
          if (!isEnrolled(route.repo)) return;
          try {
            const d = s.materialize(route);
            if (d) processGuarded(d, s.kind);
          } catch (e) {
            log(`materialize FAILED [${s.kind}]: ${e}`);
          }
          return;
        }
      };
      watcher.on("add", onChange).on("change", onChange);
      // Chokidar is a latency optimization, not a replacement for discovery. OpenCode changes
      // happen inside SQLite (outside these watch roots), enrollment can change without a file
      // event, and TTL must keep running. Retain the authoritative periodic sweep alongside it.
      log(`polling every ${POLL_SECONDS}s (chokidar fast path also active)`);
      await pollLoop();
      return;
    }
  } catch {
    /* fall through to polling */
  }
  log(`polling every ${POLL_SECONDS}s`);
  await pollLoop();
}

// Retention runs at daemon startup and then at most once a day: the exports are the only
// conversation bodies llmwiki keeps, and an expiry that only fires on an explicit maintenance
// command is an expiry nobody runs.
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

function pruneExportsIfDue(force = false): void {
  const now = Date.now();
  if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  try {
    const { pairs, rows } = capture.pruneExports();
    if (pairs) log(`retention: removed ${pairs} expired OpenCode export pair(s), ${rows} pending row(s)`);
  } catch (e) {
    log(`retention FAILED (will retry tomorrow): ${e}`);
  }
  // Queue retention on the same clock. Until this line, `capture.prune()` only ran when a human
  // typed `llmwiki capture-prune` — which meant tombstoning existed as a command nobody runs while
  // the pending set silently accumulated dead rows (measured: 425 pending, 44% of them pointing at
  // deleted /tmp experiment repos, oldest past the harness's own retention window). Same fail-safe
  // shape as above: a broken prune costs one day, never the sweep.
  try {
    const { removed, skippedEphemeral } = capture.prune();
    if (removed || skippedEphemeral) {
      log(`retention: queue prune — ${removed} lost tombstone(s), ${skippedEphemeral} ephemeral-repo skip(s)`);
    }
  } catch (e) {
    log(`queue prune FAILED (will retry tomorrow): ${e}`);
  }
  rotateDaemonLogIfOversized();
}

// daemon.log has no rotation anywhere else: the service definitions append via `>>` forever, and
// the measured result was 11.7MB in two months on one machine. Copy-truncate, NOT rename: the
// shell holds the append-mode fd from that `>>`, so renaming would divert every subsequent line
// into the rotated file, while truncating in place lets O_APPEND writes continue at the new EOF.
// One generation kept (daemon.log.1) — this is an operational log, not an audit ledger; the audit
// ledger is capture.db, which is exactly why THIS file is safe to rotate and that one is not.
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function rotateDaemonLogIfOversized(): void {
  try {
    const size = rotateDaemonLog(capture.stateDir(), LOG_ROTATE_BYTES);
    if (size === null) return;
    log(`rotated daemon.log (${size} bytes → daemon.log.1)`);
  } catch (e) {
    // Windows can refuse the truncate while cmd holds the handle; a fat log is not worth a dead
    // daemon, and the failure is visible right here in the log it failed to rotate.
    log(`log rotation FAILED (will retry tomorrow): ${e}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    const counts = runOnce();
    console.log(
      `sweep: discovered=${counts.discovered} enqueued=${counts.enqueued} ` +
        `skipped_short=${counts.skippedShort} skipped_unenrolled=${counts.skippedUnenrolled} ` +
        `route_unresolved=${counts.routeUnresolved} failed=${counts.failed}; queue stats: ${queueStats()}`,
    );
    return;
  }
  log("llmwiki capture daemon starting");
  // The first poll sweeps before retention for the same migration-before-deletion invariant.
  lastPruneAt = 0;
  await watchLoop();
}

await main();
