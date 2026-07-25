#!/usr/bin/env bun
// llmwiki capture daemon — environment-agnostic auto-capture.
// Discovery/format now live behind the TranscriptSource abstraction (engine/source).
// The daemon only sweeps `sources()` and enqueues update debt to the central capture
// queue (engine/capture). No per-client hook required. Never calls an LLM — only records
// debt. Today the only auto-discovering source is claude-jsonl, so the
// default sweep is byte-identical to the pre-abstraction daemon. Zero-dep by default (fs
// size polling, 30s); uses chokidar for instant capture only if it happens to be installed.
import { statSync, existsSync } from "node:fs";
import * as capture from "../engine/capture.ts";
import { sources, discoverableSources, type DiscoveredSession } from "../engine/source.ts";

const THRESHOLD_LINES = 50; // skip trivial Q&A sessions (work-volume signal)
const POLL_SECONDS = 30;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} INFO llmwiki-daemon: ${msg}`);
}

// All auto-discoverable sessions across every registered source (plain returns none).
function discoverAll(): { d: DiscoveredSession; kind: string }[] {
  const out: { d: DiscoveredSession; kind: string }[] = [];
  for (const s of sources()) {
    for (const d of s.discover()) out.push({ d, kind: s.kind });
  }
  return out;
}

function process_(d: DiscoveredSession, kind: string): "enqueued" | "skipped_short" {
  if (d.lines < THRESHOLD_LINES) return "skipped_short";
  capture.enqueue(d.path, d.sessionId, d.repo, d.lines, kind);
  log(`captured sess=${(d.sessionId || "?").slice(0, 8)} repo=${d.repo} lines=${d.lines} [${kind}]`);
  return "enqueued";
}

// The daemon IS the capture loop, so one session must never take it down: a locked database, a
// file that vanished mid-sweep, an unwritable state dir. A throw here used to kill the process,
// and capture then stops SILENTLY — transcripts keep rotating per the harness's own retention, so
// the sessions are simply gone while the wiki merely looks quiet. Log it, count it, carry on.
function processGuarded(d: DiscoveredSession, kind: string): "enqueued" | "skipped_short" | "failed" {
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

function runOnce(): { discovered: number; enqueued: number; skippedShort: number; failed: number } {
  const counts = { discovered: 0, enqueued: 0, skippedShort: 0, failed: 0 };
  for (const { d, kind } of discoverAll()) {
    const outcome = processGuarded(d, kind);
    counts.discovered += 1;
    if (outcome === "enqueued") counts.enqueued += 1;
    else if (outcome === "failed") counts.failed += 1;
    else counts.skippedShort += 1;
  }
  return counts;
}

async function pollLoop(): Promise<void> {
  const last: Record<string, number> = {};
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Discovery walks other tools' directories, so it can throw on a permission or race too —
    // a failed sweep costs one poll interval, never the loop.
    try {
      for (const { d, kind } of discoverAll()) {
        let size: number;
        try {
          size = statSync(d.path).size;
        } catch {
          continue;
        }
        if (last[d.path] !== size) {
          last[d.path] = size;
          processGuarded(d, kind);
        }
      }
    } catch (e) {
      log(`sweep FAILED (retrying next poll): ${e}`);
    }
    await Bun.sleep(POLL_SECONDS * 1000);
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
      runOnce(); // initial sweep
      const watcher = chokidar.watch(dirs, { ignoreInitial: true });
      const onChange = (p: string) => {
        if (!p.endsWith(".jsonl") || !existsSync(p)) return;
        for (const s of discoverableSources()) {
          const d = s.probe(p);
          if (d) {
            process_(d, s.kind);
            return;
          }
        }
      };
      watcher.on("add", onChange).on("change", onChange);
      return; // watcher keeps the process alive
    }
  } catch {
    /* fall through to polling */
  }
  log(`polling every ${POLL_SECONDS}s`);
  await pollLoop();
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    const counts = runOnce();
    console.log(
      `sweep: discovered=${counts.discovered} enqueued=${counts.enqueued} ` +
        `skipped_short=${counts.skippedShort} failed=${counts.failed}; queue stats: ${queueStats()}`,
    );
    return;
  }
  log("llmwiki capture daemon starting");
  await watchLoop();
}

await main();
