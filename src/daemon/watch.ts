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

function process_(d: DiscoveredSession, kind: string): void {
  if (d.lines < THRESHOLD_LINES) return;
  capture.enqueue(d.path, d.sessionId, d.repo, d.lines, kind);
  log(`captured sess=${(d.sessionId || "?").slice(0, 8)} repo=${d.repo} lines=${d.lines} [${kind}]`);
}

function runOnce(): number {
  let seen = 0;
  for (const { d, kind } of discoverAll()) {
    process_(d, kind);
    seen += 1;
  }
  return seen;
}

async function pollLoop(): Promise<void> {
  const last: Record<string, number> = {};
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const { d, kind } of discoverAll()) {
      let size: number;
      try {
        size = statSync(d.path).size;
      } catch {
        continue;
      }
      if (last[d.path] !== size) {
        last[d.path] = size;
        process_(d, kind);
      }
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
    const n = runOnce();
    console.log(`swept ${n} transcript(s); queue stats: ${JSON.stringify(capture.stats())}`);
    return;
  }
  log("llmwiki capture daemon starting");
  await watchLoop();
}

await main();
