// The route signal: where did this segment's work actually happen?
//
// Capture buckets a session by its cwd, so for a session started in an enrolled home (or any
// ancestor repo) the bucket and the `cwd=` header agree BY CONSTRUCTION while every edit went to
// another repo — the exact day this was built, a session run from `~` produced three releases in
// `~/llmwiki-runtime` and nothing deterministic in its extract said so. wiki-deep's scope gate
// told the drainer to judge by `cwd=`, which cannot see the mismatch. These tests pin the signal
// that can: mutated-file git roots on the extract, and the advisory line update-next prints when
// the dominant root is not the queue repo.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractIncrement } from "../src/engine/extract.ts";
import { renderRouteLines } from "../src/engine/update.ts";

const tmps: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

/** A plain git repo (a `.git` DIRECTORY is all the root probe needs — no commits required). */
function mkRepo(prefix: string): string {
  const d = join(tmp(prefix), "repo");
  mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
}

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function editRow(filePath: string, tool = "Edit", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-27T12:00:00Z",
    uuid: "u",
    message: { role: "assistant", content: [{ type: "tool_use", name: tool, input: { file_path: filePath } }] },
    ...extra,
  });
}

function userRow(text: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-27T12:00:00Z",
    cwd: "/Users/someone",
    message: { role: "user", content: text },
  });
}

describe("extractIncrement.touched", () => {
  test("mutation tool calls are counted per git root; reads and text rows are not", () => {
    const work = mkRepo("llmwiki-route-work-");
    const bucket = mkRepo("llmwiki-route-bucket-");
    const t = join(tmp("llmwiki-route-t-"), "s.jsonl");
    writeFileSync(
      t,
      [
        userRow("결제 재시도 상한을 고치자"),
        editRow(join(work, "src", "a.ts")),
        editRow(join(work, "src", "b.ts"), "Write"),
        editRow(join(work, "src", "c.ipynb"), "NotebookEdit"),
        editRow(join(bucket, "notes.md")),
        // a Read into the work repo must NOT count — investigation roams everywhere
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-27T12:01:00Z",
          uuid: "r",
          message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: join(work, "src", "a.ts") } }] },
        }),
      ].join("\n") + "\n",
    );

    const inc = extractIncrement(t);

    expect(inc.touched).toEqual({ [work]: 3, [bucket]: 1 });
  });

  test("a sidechain row's mutations never count — a subagent's edits are not this session's words or work", () => {
    const work = mkRepo("llmwiki-route-side-");
    const t = join(tmp("llmwiki-route-t-"), "s.jsonl");
    writeFileSync(t, [editRow(join(work, "src", "a.ts"), "Edit", { isSidechain: true })].join("\n") + "\n");

    expect(extractIncrement(t).touched).toEqual({});
  });

  test("paths outside any git repo are dropped, not misattributed", () => {
    const loose = join(tmp("llmwiki-route-loose-"), "no-repo-here");
    mkdirSync(loose, { recursive: true });
    const t = join(tmp("llmwiki-route-t-"), "s.jsonl");
    writeFileSync(t, [editRow(join(loose, "x.ts"))].join("\n") + "\n");

    expect(extractIncrement(t).touched).toEqual({});
  });
});

describe("renderRouteLines", () => {
  test("dominant root elsewhere → touched line + advisory naming both sides", () => {
    const work = mkRepo("llmwiki-route-w-");
    const bucket = mkRepo("llmwiki-route-b-");
    const lines = renderRouteLines(bucket, { [work]: 5, [bucket]: 1 });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`# touched: ${work}(5)`);
    expect(lines[1]).toContain("⚠ route:");
    expect(lines[1]).toContain(work);
    expect(lines[1]).toContain("file the session into THAT repo's wiki");
    expect(lines[1]).toContain(`update-done ${bucket}`); // the watermark stays with the queue
  });

  test("dominant root IS the queue repo → touched line only, no advisory", () => {
    const repo = mkRepo("llmwiki-route-same-");
    const lines = renderRouteLines(repo, { [repo]: 4 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("# touched:");
  });

  test("no mutations → silence (a chat-only session belongs to its bucket)", () => {
    expect(renderRouteLines(mkRepo("llmwiki-route-empty-"), {})).toEqual([]);
    expect(renderRouteLines(mkRepo("llmwiki-route-undef-"), undefined)).toEqual([]);
  });
});

// End to end through the real queue: the same header the /wiki-save and /wiki-deep skills read.
test("update-next carries touched roots for a queued transcript", async () => {
  const capture = await import("../src/engine/capture.ts");
  const update = await import("../src/engine/update.ts");
  const state = tmp("llmwiki-route-state-");
  capture.setStateDir(state);

  const bucket = mkRepo("llmwiki-route-ibucket-");
  const work = mkRepo("llmwiki-route-iwork-");
  // the queue key is the transcript path; a real bucket repo needs a git identity for enqueue
  spawnSync("git", ["-C", bucket, "init", "-q"], {});
  const t = join(tmp("llmwiki-route-t-"), "s.jsonl");
  writeFileSync(t, [userRow("작업"), editRow(join(work, "src", "a.ts"))].join("\n") + "\n");
  capture.enqueue(t, "s-route", bucket, 60, "claude-jsonl");

  const inc = update.nextIncrement(bucket, t);

  expect(inc.touched).toEqual({ [work]: 1 });
  const lines = renderRouteLines(bucket, inc.touched);
  expect(lines[1]).toContain("⚠ route:");
});
