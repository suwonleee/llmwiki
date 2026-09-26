// A linked worktree (`git worktree add`) of an enrolled repository is the same repository in a
// second checkout — the shape "one task = one worktree" produces all day. Before inheritance it read
// as unenrolled: no cold start, no turn context, no capture, and a session that ran there never
// reached any backlog. These tests pin the whole loop from the worktree's side: reads bind to the
// worktree's own (branch) wiki, capture files into the MAIN worktree's bucket from either side,
// the route advisory treats the two checkouts as one repository, and the close-out commands
// (update-done, register-transcript, lint) work when run with the worktree path.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { ensureOwnedStateRoot, setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { buildTurnContext, displayRoot } from "../src/engine/turncontext.ts";
import { renderRouteLines } from "../src/engine/update.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { captureBucket } from "../src/engine/wiki-root.ts";
import { recordInstallReceipt } from "../src/engine/update-check.ts";
import { enrollRepo, git, makeGitRepo, tempDir } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];

function scratch(prefix: string): string {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
}

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${title}\ndate: 2026-09-23\ntags: [test]\nstatus: ready\n---\n\n${body}\n`;
}

/** An enrolled main worktree with a committed wiki, plus a linked worktree on its own branch. */
function fixture(): { main: string; linked: string; state: string } {
  const base = scratch("llmwiki-linked-");
  const main = makeGitRepo(join(base, "main"));
  mkdirSync(join(main, "docs", "wiki"), { recursive: true });
  writeFileSync(join(main, "docs", "wiki", "current-state.md"), page("Current state", "MAIN-TREE-STATE"));
  git(main, ["add", "-A"]);
  git(main, ["commit", "-q", "-m", "wiki"]);
  enrollRepo(main);
  const linked = join(base, "wt");
  git(main, ["worktree", "add", "-q", "-b", "task", linked]);
  // the branch copy diverges — reads in the worktree must see THIS text, not the main tree's
  writeFileSync(join(linked, "docs", "wiki", "current-state.md"), page("Current state", "BRANCH-COPY-STATE"));
  const state = scratch("llmwiki-linked-state-");
  capture.setStateDir(state);
  ensureOwnedStateRoot(state);
  expect(recordInstallReceipt(join(import.meta.dir, ".."), state)).toBe(true);
  resetEnrollmentCache();
  return { main, linked: realpathSync(linked), state };
}

function cli(args: string[], state: string, stdin?: string): { out: string; code: number | null } {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: { ...process.env, LLMWIKI_STATE_DIR: state, LLMWIKI_LANG: "en" },
  });
  return { out: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}`, code: r.exitCode };
}

function transcript(dir: string, cwd: string): string {
  const t = join(dir, "sess-linked.jsonl");
  const rows = [
    { type: "user", timestamp: "2026-09-23T10:00:00Z", cwd, sessionId: "sess-linked", message: { role: "user", content: "결정: 워크트리에서 A 채택, 이유는 B" } },
    { type: "assistant", timestamp: "2026-09-23T10:01:00Z", cwd, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: join(cwd, "src", "a.ts") } }] } },
  ];
  writeFileSync(t, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return t;
}

afterEach(() => {
  resetEnrollmentCache();
  setEffectiveStateRoot(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("linked worktree of an enrolled repository", () => {
  test("cold start reads the worktree's own branch wiki; an opted-out worktree gets zero bytes", () => {
    const { linked, state } = fixture();
    const on = cli(["context", linked], state);
    expect(on.out).toContain("BRANCH-COPY-STATE");
    expect(on.out).not.toContain("MAIN-TREE-STATE");
    expect(cli(["status", linked], state).out).toContain("inherited");

    expect(cli(["disable", linked], state).code).toBe(0);
    const off = cli(["context", linked], state);
    expect(off.out).toBe("");
    expect(cli(["enabled", linked], state).code).toBe(1);
  });

  test("capture buckets into the main worktree on the write side and on every read side", () => {
    const { main, linked } = fixture();
    mkdirSync(join(linked, "src"), { recursive: true });
    expect(captureBucket(linked)).toBe(main);
    expect(captureBucket(join(linked, "src"))).toBe(main);
    expect(captureBucket(main)).toBe(main);

    const t = transcript(scratch("llmwiki-linked-t-"), linked);
    capture.enqueue(t, "sess-linked", linked, 60, "claude-jsonl");
    expect(capture.pending(main).map((r) => r.transcript_path)).toEqual([t]);
    expect(capture.pending(linked).map((r) => r.transcript_path)).toEqual([t]);
    expect(capture.pending(main)[0]!.repo).toBe(main);
    expect(capture.transcriptsForRepo(linked).map((r) => r.path)).toEqual([t]);
    expect(capture.stats(linked)).toEqual({ pending: 1 });

    capture.recordRouteHint(t, join(linked, "src"), "sess-linked", "claude-jsonl");
    expect(capture.routeHintFor(t)?.repo).toBe(main);
  });

  test("a never-enrolled main keeps the worktree's cwd — no invented parent", () => {
    const base = scratch("llmwiki-linked-noenroll-");
    const main = makeGitRepo(join(base, "main"));
    const linked = join(base, "wt");
    git(main, ["worktree", "add", "-q", "-b", "task", linked]);
    resetEnrollmentCache();
    expect(captureBucket(linked)).toBe(realpathSync(linked));
  });

  test("update-status (both paths), update-next without a false route warning, update-done from the worktree", () => {
    const { main, linked, state } = fixture();
    const t = transcript(scratch("llmwiki-linked-t-"), linked);
    capture.enqueue(t, "sess-linked", linked, 60, "claude-jsonl"); // as the daemon files it

    for (const ws of [main, linked]) {
      const status = cli(["update-status", ws], state);
      expect(status.out).toContain("1 transcript(s) pending update");
      expect(status.out).toContain(t);
    }

    const next = cli(["update-next", main, t], state);
    expect(next.code).toBe(0);
    expect(next.out).toContain(`# touched: ${linked}(1)`);
    expect(next.out).not.toContain("⚠ route");
    const offset = Number(/new_offset=(\d+)/.exec(next.out)![1]);

    const done = cli(["update-done", linked, t, String(offset)], state);
    expect(done.code).toBe(0);
    expect(cli(["update-status", main], state).out).toContain("No pending transcripts");
    expect(cli(["update-status", linked], state).out).toContain("distilled 1");
  });

  test("route advisory: same repository across checkouts is silent, a different repository still warns", () => {
    const { main, linked } = fixture();
    expect(renderRouteLines(main, { [linked]: 3 })).toEqual([`# touched: ${linked}(3)`]);
    expect(renderRouteLines(linked, { [main]: 3 })).toEqual([`# touched: ${main}(3)`]);
    const other = makeGitRepo(scratch("llmwiki-linked-other-"));
    const lines = renderRouteLines(main, { [other]: 2 });
    expect(lines[1]).toContain("⚠ route");
  });

  test("register-transcript + lint in the worktree resolve its transcript and branch-only citations", () => {
    const { linked, state } = fixture();
    const t = transcript(scratch("llmwiki-linked-t-"), linked);
    capture.enqueue(t, "sess-linked", linked, 60, "claude-jsonl"); // as the daemon files it
    mkdirSync(join(linked, "src"), { recursive: true });
    writeFileSync(join(linked, "src", "branch-only.ts"), "export const x = 1;\n");
    mkdirSync(join(linked, "docs", "wiki", "3_decision"), { recursive: true });
    writeFileSync(
      join(linked, "docs", "wiki", "3_decision", "2026-09-23-a-채택.md"),
      page(
        "A 채택",
        "## 결정\n\n- 워크트리에서 A 채택 [^s1]\n- 지점 [^c1]\n\n[^s1]: sess-linked.jsonl\n[^c1]: src/branch-only.ts",
      ),
    );
    const reg = cli(["register-transcript", linked], state);
    expect(reg.out).toContain("registered 1 transcript(s)");
    expect(cli(["index", linked], state).code).toBe(0);
    const lint = cli(["lint", linked, "--errors-only"], state);
    expect(lint.out).not.toContain("unresolved-citation");
    expect(lint.code).toBe(0);
  });

  test("turn context in a worktree without its own index borrows the main wiki index, filtered to this checkout", () => {
    const { main, linked } = fixture();
    const body = "캡처 데몬(watch.ts)은 launchd 로 상주한다. 트랜스크립트 큐는 capture.db 에 쌓인다. ".repeat(10);
    for (const name of ["capture-daemon.md", "capture-daemon-old.md"]) {
      for (const root of [main, linked]) {
        mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
        writeFileSync(join(root, "docs", "wiki", "3_decision", name), `---\ntitle: 캡처 데몬 ${name}\n---\n${body}`);
      }
    }
    unlinkSync(join(linked, "docs", "wiki", "3_decision", "capture-daemon-old.md")); // gone on this branch
    new WikiIndex(main).indexAll();
    expect(existsSync(new WikiIndex(linked).dbPath)).toBe(false);

    let out = buildTurnContext(linked, "캡처 데몬이 트랜스크립트 큐를 놓치는 것 같은데 확인해줘");
    expect(out).toContain("3_decision/capture-daemon.md");
    // the cold start's readers leave an EMPTY own index behind in a fresh worktree — still borrow
    const own = new WikiIndex(linked);
    own.connect().close();
    expect(existsSync(own.dbPath)).toBe(true);
    out = buildTurnContext(linked, "캡처 데몬이 트랜스크립트 큐를 놓치는 것 같은데 확인해줘");
    expect(out).toContain("3_decision/capture-daemon.md");
    rmSync(own.dbPath);
    expect(out.split("\n")[0]).toContain(displayRoot(linked)); // pointers name this checkout
    expect(out).not.toContain("capture-daemon-old.md"); // exists only in the main checkout
    expect(existsSync(new WikiIndex(linked).dbPath)).toBe(false); // a read never builds state

    // a plain (non-linked) repository without an index stays silent, as before
    rmSync(new WikiIndex(main).dbPath);
    expect(buildTurnContext(linked, "캡처 데몬이 트랜스크립트 큐를 놓치는 것 같은데 확인해줘")).toBe("");
  });
});
