// Two things that decide whether capture QUIETLY loses sessions (src/engine/capture.ts).
//
// 1. Contention. capture.db is WAL, and at least three process classes open it at once: the 30s
//    daemon sweep, both session hooks, and any `llmwiki` subcommand. Every open runs the schema
//    block as a write transaction. SQLite's default busy timeout is 0 — the loser of any overlap
//    fails INSTANTLY with SQLITE_BUSY — and both callers absorb that silently (the daemon as a
//    counter, the hooks as `2>/dev/null; exit 0`). So contention presented as missing rows, never
//    as an error. The per-repo index has waited 5s since its first WAL day; this pins that the
//    queue does too.
//
// 2. Process identity. An interrupted OpenCode append is reclaimed only when the previous owner is
//    provably gone, which needs a start-time token so a recycled PID cannot pass for the original.
//    `ps -p <pid> -o lstart=` is absent from BusyBox, where the token came back empty forever and
//    no append was EVER reclaimed. procfs answers the same question with no subprocess.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeOwner, openCodeOwnerLive } from "../src/engine/capture.ts";

const CAPTURE = join(import.meta.dir, "..", "src", "engine", "capture.ts");
const scratches: string[] = [];

afterEach(() => {
  while (scratches.length) rmSync(scratches.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratches.push(dir);
  return dir;
}

describe("capture.db under concurrent writers", () => {
  test("simultaneous writers all land their rows instead of losing to SQLITE_BUSY", async () => {
    const state = scratch("llmwiki-capture-busy-");
    const transcripts = scratch("llmwiki-capture-transcripts-");
    const repo = scratch("llmwiki-capture-repo-");
    const script = join(scratch("llmwiki-capture-writer-"), "writer.ts");
    const WRITERS = 4;
    const ROWS = 25;

    // Real files on disk: a queued row is only "pending" while its transcript still has an unread
    // tail, so a fixture of imaginary paths would be filtered out before any assertion could see it.
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `import { enqueue, pendingReadOnly } from ${JSON.stringify(CAPTURE)};\n` +
        "const tag = process.argv[2];\n" +
        `const dir = ${JSON.stringify(transcripts)};\n` +
        `const repo = ${JSON.stringify(repo)};\n` +
        `for (let i = 0; i < ${ROWS}; i += 1) {\n` +
        "  const path = join(dir, `session-${tag}-${i}.jsonl`);\n" +
        '  writeFileSync(path, \'{"type":"user"}\\n\');\n' +
        "  enqueue(path, `s-${tag}-${i}`, repo, 1);\n" +
        "}\n" +
        "console.log(JSON.stringify({ total: pendingReadOnly(repo).length }));\n",
    );

    // Spawned asynchronously and joined afterwards. spawnSync would serialize them, which is the
    // one thing this test must not do — each child has to open the same database, and run the
    // schema's write transaction, while the others are doing the same.
    const children = Array.from({ length: WRITERS }, (_, i) =>
      Bun.spawn([process.execPath, script, String(i)], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LLMWIKI_STATE_DIR: state } as Record<string, string>,
      }),
    );

    const finished = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        out: await new Response(child.stdout).text(),
        err: await new Response(child.stderr).text(),
      })),
    );

    for (const one of finished) {
      expect(one.err).not.toContain("SQLITE_BUSY");
      expect(one.err).not.toContain("database is locked");
      expect(one.code).toBe(0);
    }
    // The last writer to finish sees the whole queue: nothing was dropped by a lock.
    const totals = finished.map((one) => JSON.parse(one.out.trim()).total as number);
    expect(Math.max(...totals)).toBe(WRITERS * ROWS);
  }, 15_000);
});

describe("openCodeOwnerLive", () => {
  test("recognizes this very process as alive", () => {
    expect(openCodeOwnerLive(openCodeOwner())).toBe(true);
  });

  test("produces a scheme-tagged token, never an empty one", () => {
    const { token } = openCodeOwner();
    expect(token).not.toBe("");
    // One of the two schemes; which one depends on whether this host has procfs.
    expect(/^(proc-starttime-v1|ps-lstart-c-v1):/.test(token)).toBe(true);
  });

  test("a token from a different start time is not this process", () => {
    const owner = openCodeOwner();
    const forged = { pid: owner.pid, token: `${owner.token}-tampered` };
    // Same scheme, different value → provably a different process that once held this PID.
    expect(openCodeOwnerLive(forged)).toBe(false);
  });

  test("an unusable PID is dead, not unknown", () => {
    expect(openCodeOwnerLive({ pid: -1, token: "" })).toBe(false);
    expect(openCodeOwnerLive({ pid: 0, token: "" })).toBe(false);
  });

  test("a live process with an unrecognizable token fails CLOSED, never open", () => {
    // "Cannot prove" must be null — taking over an append on a maybe-live owner would corrupt it.
    expect(openCodeOwnerLive({ pid: process.pid, token: "some-legacy-format" })).toBeNull();
  });

  test("an exited process is reported dead so its append can be reclaimed", async () => {
    const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
    const owner = openCodeOwner(child.pid);
    await child.exited;
    // The token was captured while it lived; now that it is gone the answer must be a definite no.
    expect(openCodeOwnerLive(owner)).toBe(false);
  });
});

// The concurrency test above proves the OUTCOME on this machine's timing; this pins the mechanism,
// so a future refactor that drops the pragma fails here rather than becoming a flaky loss of rows.
test("the queue connection sets a busy timeout, not SQLite's instant-fail default", () => {
  expect(readFileSync(CAPTURE, "utf-8")).toContain("PRAGMA busy_timeout");
});
