// Sub-agent/fork threads replay the parent's context and carry no human turn of their own, so they
// enter the capture ledger as `skipped`, never as backlog work — and rows queued before the rule
// existed leave the backlog on the retention clock. Only POSITIVE evidence counts: a user fork,
// an unreadable head, or an adapter without the probe keeps the row as work.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { codexSource } from "../src/engine/sources/codex.ts";
import { isOpenCodeChildSession } from "../src/engine/sources/opencode.ts";
import { isSubagentTranscript } from "../src/engine/source.ts";

const PARENT = "01a00000-0000-7000-8000-00000000000a";
const CHILD = "01a00000-0000-7000-8000-00000000000b";

function rollout(path: string, meta: Record<string, unknown>): void {
  const lines = [
    { type: "session_meta", payload: { cwd: "/repo/a", ...meta } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

let dir: string;
const savedCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "llmwiki-subagent-")));
  capture.setStateDir(join(dir, "state"));
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("codex sub-agent detection", () => {
  test("thread_source=subagent is a sub-agent; a user thread and a user /fork are not", () => {
    const child = join(dir, `rollout-2026-09-21T13-15-42-${CHILD}.jsonl`);
    rollout(child, {
      id: CHILD,
      session_id: PARENT,
      forked_from_id: PARENT,
      parent_thread_id: PARENT,
      thread_source: "subagent",
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
    });
    const user = join(dir, "user.jsonl");
    rollout(user, { id: PARENT, thread_source: "user", source: "cli" });
    const fork = join(dir, "fork.jsonl");
    rollout(fork, { id: "f", forked_from_id: PARENT, thread_source: "user", source: "cli" });
    const legacy = join(dir, "legacy.jsonl");
    rollout(legacy, { id: "old" }); // pre-thread_source rollout: no evidence either way

    expect(codexSource.isSubagent!(child)).toBe(true);
    expect(codexSource.isSubagent!(user)).toBe(false);
    expect(codexSource.isSubagent!(fork)).toBe(false);
    expect(codexSource.isSubagent!(legacy)).toBe(false);
    expect(isSubagentTranscript("codex", child)).toBe(true);
    expect(isSubagentTranscript("claude-jsonl", child)).toBe(false); // adapter without the probe
  });

  test("a compressed rollout is answered from the Codex thread index, not decompressed", () => {
    process.env.CODEX_HOME = dir;
    const db = new Database(join(dir, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, thread_source TEXT)");
    db.run("INSERT INTO threads (id, thread_source) VALUES (?, 'subagent'), (?, 'user')", [CHILD, PARENT]);
    db.close();
    const child = join(dir, `rollout-2026-09-21T13-15-42-${CHILD}.jsonl.zst`);
    const parent = join(dir, `rollout-2026-09-21T10-23-35-${PARENT}.jsonl.zst`);
    writeFileSync(child, "not zstd — must never be read");
    writeFileSync(parent, "not zstd — must never be read");

    expect(codexSource.isSubagent!(child)).toBe(true);
    expect(codexSource.isSubagent!(parent)).toBe(false);
    // The logical .jsonl path (the queue key after in-place compression) resolves the same way.
    expect(codexSource.isSubagent!(child.slice(0, -".zst".length))).toBe(true);
  });
});

describe("opencode child-session detection", () => {
  test("a session with parent_id is a child; the root session is not", () => {
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT)");
    db.run("INSERT INTO session VALUES ('ses_root', NULL, '/repo/a'), ('ses_child', 'ses_root', '/repo/a')");
    db.close();
    const exportFor = (id: string): string => {
      const p = join(dir, `${id}.jsonl`);
      writeFileSync(p, JSON.stringify({ kind: "opencode-meta", sessionID: id, directory: "/repo/a", sourcePath: dbPath }) + "\n");
      return p;
    };

    expect(isOpenCodeChildSession(exportFor("ses_child"), [dbPath])).toBe(true);
    expect(isOpenCodeChildSession(exportFor("ses_root"), [dbPath])).toBe(false);
    // A meta line naming a database this engine does not read proves nothing.
    expect(isOpenCodeChildSession(exportFor("ses_child"), [])).toBe(false);
  });
});

describe("capture queue", () => {
  test("a sub-agent offer is recorded as skipped at the current size and stays skipped as it grows", () => {
    const t = join(dir, "child.jsonl");
    writeFileSync(t, "x\n");
    expect(capture.enqueue(t, "s1", "/repo/a", 1, "codex", () => true)).toBe("subagent");
    expect(capture.stats()).toEqual({ skipped: 1 });
    expect(capture.getOffset(t)).toBe(statSync(t).size);
    expect(capture.pending("/repo/a")).toEqual([]);

    // Unchanged re-offer: nothing written, predicate not even asked.
    let asked = false;
    expect(
      capture.enqueue(t, "s1", "/repo/a", 1, "codex", () => {
        asked = true;
        return true;
      }),
    ).toBe("unchanged");
    expect(asked).toBe(false);

    appendFileSync(t, "more\n");
    expect(capture.enqueue(t, "s1", "/repo/a", 2, "codex", () => true)).toBe("subagent");
    expect(capture.stats()).toEqual({ skipped: 1 });
    expect(capture.getOffset(t)).toBe(statSync(t).size);
  });

  test("without positive evidence the row is ordinary pending work", () => {
    const t = join(dir, "main.jsonl");
    writeFileSync(t, "x\n");
    expect(capture.enqueue(t, "s1", "/repo/a", 1, "codex", () => false)).toBe("new");
    expect(capture.stats()).toEqual({ pending: 1 });
  });

  test("backfill skips only the pending rows the predicate proves, and leaves the ledger alone", () => {
    mkdirSync(join(dir, "t"));
    const child = join(dir, "t", "child.jsonl");
    const main = join(dir, "t", "main.jsonl");
    const filed = join(dir, "t", "filed.jsonl");
    for (const p of [child, main, filed]) {
      writeFileSync(p, "x\n");
      capture.enqueue(p, null, "/repo/a", 1, "codex");
    }
    capture.mark(filed, 2, "distilled");

    const seen: string[] = [];
    const n = capture.skipPendingSubagents((r) => {
      seen.push(r.transcript_path);
      expect(r.source_kind).toBe("codex");
      return r.transcript_path !== main;
    });
    expect(n).toBe(1);
    expect(seen.sort()).toEqual([child, main].sort()); // distilled rows are never asked
    expect(capture.stats()).toEqual({ distilled: 1, pending: 1, skipped: 1 });
    expect(capture.pending("/repo/a").map((r) => r.transcript_path)).toEqual([main]);
  });
});
