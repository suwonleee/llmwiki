// What the harness told us beats what we infer.
//
// Stage-1 routing reads a bounded prefix of a transcript to decide which repository a session
// belongs to — an inference about a file format we do not own, and one that silently resolved 22 of
// 2,687 real sessions when that format's key order stopped matching an assumption. Both hook-based
// harnesses hand the answer over in every hook payload (`transcript_path`; Codex marks it
// required), so for the session a human is actually sitting in there is no need to guess.
//
// The hint is deliberately weak: it is consulted ONLY when routing came back empty, and every gate
// after it still runs. These tests pin both halves — that it rescues an unroutable session, and
// that it cannot become a way into a repository nobody enrolled.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix = "llmwiki-hint-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

/** A transcript stage-1 cannot route: no `cwd` anywhere in it. */
function unroutableTranscript(projects: string): string {
  const path = join(projects, "session.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "summary", leafUuid: "u1", sessionId: "sess-hint" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    ].join("\n") + "\n",
  );
  return path;
}

function sessionStartPayload(cwd: string, transcript: string, sessionId = "sess-hint"): string {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    transcript_path: transcript,
    cwd,
    source: "startup",
  });
}

function runContext(repo: string, payload: string, stateRoot: string): { out: string; code: number | null } {
  const r = Bun.spawnSync(["bun", CLI, "context", repo, "--hook-event", "SessionStart"], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, LLMWIKI_STATE_DIR: stateRoot },
  });
  return { out: r.stdout?.toString() ?? "", code: r.exitCode };
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  resetEnrollmentCache();
  setEffectiveStateRoot(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("harness-supplied routing", () => {
  test("a session stage-1 cannot route is still routed from the hook payload", () => {
    const home = scratch("llmwiki-hint-home-");
    const projects = join(home, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
    const transcript = unroutableTranscript(projects);
    const repo = enrollRepo(makeGitRepo(tempDir("llmwiki-hint-repo-")));
    dirs.push(repo);
    const stateRoot = join(scratch(), "state");

    // Stage-1 genuinely cannot answer for this file.
    const route = claudeJsonlSource.discoverRoutes().find((r) => r.path === transcript);
    expect(route?.repo).toBeNull();

    const { code } = runContext(repo, sessionStartPayload(repo, transcript), stateRoot);
    expect(code).toBe(0);

    capture.setStateDir(stateRoot);
    const hint = capture.routeHintFor(transcript);
    expect(hint?.repo).toBe(repo);
    expect(hint?.sessionId).toBe("sess-hint");
  });

  test("an unenrolled repository teaches the engine nothing", () => {
    const home = scratch("llmwiki-hint-home-");
    const projects = join(home, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
    const transcript = unroutableTranscript(projects);
    const repo = makeGitRepo(tempDir("llmwiki-hint-cold-")); // git, but never enrolled
    dirs.push(repo);
    const stateRoot = join(scratch(), "state");

    runContext(repo, sessionStartPayload(repo, transcript), stateRoot);

    capture.setStateDir(stateRoot);
    expect(capture.routeHintFor(transcript)).toBeNull();
  });

  test("a hint is dropped once the harness has deleted the transcript", () => {
    const stateRoot = join(scratch(), "state");
    capture.setStateDir(stateRoot);
    const gone = join(scratch(), "deleted.jsonl");
    capture.recordRouteHint(gone, "/repo/a", "s1", "claude-jsonl");
    expect(capture.routeHintFor(gone)?.repo).toBe("/repo/a");

    capture.prune(0);

    expect(capture.routeHintFor(gone)).toBeNull();
  });

  test("a live transcript keeps its hint through a prune", () => {
    const stateRoot = join(scratch(), "state");
    capture.setStateDir(stateRoot);
    const live = join(scratch(), "live.jsonl");
    writeFileSync(live, "{}\n");
    capture.recordRouteHint(live, "/repo/b", "s2", "claude-jsonl");

    capture.prune(0);

    expect(capture.routeHintFor(live)?.repo).toBe("/repo/b");
  });
});
