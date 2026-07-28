// `save-current` — the deterministic selection step of a manual /wiki-save.
//
// The 2026-07-28 audit reproduced the failure this command closes: in a real 44-line Claude
// session, the skill's "when unsure, the newest pending entry" fallback selected a pending CODEX
// transcript — another harness's session about to be filed as this one's judgment. And because
// the daemon's 50-line work threshold had (correctly) skipped the short current session, the
// exact transcript the human asked to save was not even in the pending list. These tests pin the
// replacement contract: exact session identity or explicit failure, manual saves ignore the
// passive threshold, and other repositories' sessions are counted but never named or enqueued.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];

function scratch(prefix = "llmwiki-savecur-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function claudeTranscript(dir: string, name: string, lines: number): string {
  const path = join(dir, name);
  const rows: string[] = [];
  for (let i = 0; i < lines; i++) {
    rows.push(JSON.stringify({ type: i % 2 ? "assistant" : "user", message: { content: `line ${i}` } }));
  }
  writeFileSync(path, rows.join("\n") + "\n");
  return path;
}

function recordHint(repo: string, transcript: string, sessionId: string, stateRoot: string): void {
  const payload = JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: sessionId,
    transcript_path: transcript,
    cwd: repo,
    source: "startup",
  });
  const r = Bun.spawnSync(["bun", CLI, "context", repo, "--hook-event", "SessionStart"], {
    stdin: new TextEncoder().encode(payload),
    env: { ...process.env, LLMWIKI_STATE_DIR: stateRoot, LLMWIKI_LANG: "en" },
  });
  if (r.exitCode !== 0) throw new Error(`context hook failed: ${r.stderr?.toString()}`);
}

function saveCurrent(
  repo: string,
  sessionId: string,
  stateRoot: string,
  extraEnv: Record<string, string> = {},
): { out: string; err: string; code: number | null } {
  const r = Bun.spawnSync(["bun", CLI, "save-current", repo, "--session", sessionId], {
    env: { ...process.env, LLMWIKI_STATE_DIR: stateRoot, LLMWIKI_LANG: "en", ...extraEnv },
  });
  return { out: r.stdout?.toString() ?? "", err: r.stderr?.toString() ?? "", code: r.exitCode };
}

afterEach(() => {
  resetEnrollmentCache();
  setEffectiveStateRoot(null);
  delete process.env.OPENCODE_DB;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("save-current exact session selection", () => {
  test("a 44-line current Claude session is selected exactly, below the daemon threshold", () => {
    const box = scratch();
    const stateRoot = join(box, "state");
    const repo = enrollRepo(makeGitRepo(join(box, "repo")));
    const current = claudeTranscript(box, "sess-current.jsonl", 44);
    recordHint(repo, current, "sess-current", stateRoot);

    // decoy: a NEWER, larger pending transcript from another session and another harness
    setEffectiveStateRoot(stateRoot);
    const codex = claudeTranscript(box, "codex-other.jsonl", 120);
    capture.enqueue(codex, "sess-other", repo, 120, "codex");

    const r = saveCurrent(repo, "sess-current", stateRoot);
    expect(r.code).toBe(0);
    expect(r.out).toContain(current);
    expect(r.out).not.toContain(codex);
    expect(r.out).toContain("44 lines");

    const rows = capture.pending(repo);
    const mine = rows.find((row) => row.transcript_path === current);
    expect(mine?.session_id).toBe("sess-current");
    expect(mine?.status).toBe("pending"); // 44 < 50: the passive threshold does not gate a manual save
  });

  test("no exact match → explicit refusal, and nothing is enqueued in its place", () => {
    const box = scratch();
    const stateRoot = join(box, "state");
    const repo = enrollRepo(makeGitRepo(join(box, "repo")));
    setEffectiveStateRoot(stateRoot);
    const codex = claudeTranscript(box, "codex-other.jsonl", 120);
    capture.enqueue(codex, "sess-other", repo, 120, "codex");

    const r = saveCurrent(repo, "sess-missing", stateRoot);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refusing to guess");
    // the decoy is untouched and nothing new appeared
    const rows = capture.pending(repo);
    expect(rows.map((row) => row.transcript_path)).toEqual([codex]);
  });

  test("a session recorded for ANOTHER repository is excluded, not borrowed", () => {
    const box = scratch();
    const stateRoot = join(box, "state");
    const repoA = enrollRepo(makeGitRepo(join(box, "repo-a")));
    const repoB = enrollRepo(makeGitRepo(join(box, "repo-b")));
    const transcript = claudeTranscript(box, "sess-b.jsonl", 60);
    recordHint(repoB, transcript, "sess-b", stateRoot);

    const r = saveCurrent(repoA, "sess-b", stateRoot);
    expect(r.code).toBe(2);
    expect(r.err).toContain("OTHER repositories");
    expect(r.err).not.toContain(transcript); // never name another repo's transcript
    setEffectiveStateRoot(stateRoot);
    expect(capture.pending(repoA)).toEqual([]);
  });

  test("an unenrolled repository dies before any lookup", () => {
    const box = scratch();
    const stateRoot = join(box, "state");
    const repo = makeGitRepo(join(box, "repo")); // NOT enrolled
    const r = saveCurrent(repo, "sess-any", stateRoot);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not enrolled");
  });

  test("an OpenCode session id resolves through routing and enqueues its short-session export", () => {
    const box = scratch();
    const stateRoot = join(box, "state");
    const repo = enrollRepo(makeGitRepo(join(box, "repo")));
    const dbPath = join(box, "opencode.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.run("INSERT INTO session VALUES ('ses_short', ?, '짧은 세션', 1000, NULL)", [repo]);
    const t = 1720000000000;
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      "msg_01", "ses_short", t, t,
      JSON.stringify({ role: "user", time: { created: t }, agent: "build" }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_01", "msg_01", "ses_short", t, t, JSON.stringify({ type: "text", text: "짧은 수동 저장 세션" }),
    );
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      "msg_02", "ses_short", t + 1, t + 1,
      JSON.stringify({ role: "assistant", time: { created: t + 1, completed: t + 2 } }),
    );
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(
      "prt_02", "msg_02", "ses_short", t + 1, t + 1, JSON.stringify({ type: "text", text: "네, 저장합니다" }),
    );
    db.close();

    const r = saveCurrent(repo, "ses_short", stateRoot, { OPENCODE_DB: dbPath });
    expect(r.code).toBe(0);
    expect(r.out).toContain("opencode-export");

    setEffectiveStateRoot(stateRoot);
    const rows = capture.pending(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("ses_short");
    expect(rows[0]!.source_kind).toBe("opencode");
  });
});
