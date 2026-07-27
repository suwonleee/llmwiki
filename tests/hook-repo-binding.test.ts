// Which repository a hook binds to, and that binding to it never writes to it.
//
// The adapters pass `${CLAUDE_PROJECT_DIR:-$PWD}` — the directory the session STARTED in. That is
// not necessarily the repository the session is working in: start an agent in ~ and work in
// ~/some-repo and the two differ for the rest of the session. Capture already takes the harness's
// word (the payload's `cwd`) when it files the session, so if the cold start kept using the startup
// directory, one process would READ one repository's wiki and WRITE the session into another's —
// the compounding loop quietly compounding into the wrong wiki, with every health check green.
//
// The second half pins the property the whole design rests on: read-injection READS. A session that
// merely starts in a repository must not modify its docs/ — filing is what /wiki-save is for.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-binding-"));
  dirs.push(d);
  return d;
}

/** Run the CLI the way a harness hook does: payload on stdin, machine state redirected. */
function run(args: string[], payload?: Record<string, unknown>): string {
  const r = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, LLMWIKI_STATE_DIR: join(scratch(), "state") },
    stdin: payload === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(payload)),
  });
  return r.stdout?.toString() ?? "";
}

/** An enrolled repository whose L0 says exactly one identifiable thing. */
function repoSaying(marker: string): string {
  const repo = makeGitRepo(tempDir("llmwiki-binding-repo-"));
  dirs.push(repo);
  mkdirSync(join(repo, "docs", "wiki"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wiki", "current-state.md"),
    `---\ntitle: Current State\n---\n\nDIRECTION: ${marker}\n`,
  );
  return enrollRepo(repo);
}

/** Path → content hash for every file under a subtree, so "unchanged" means byte-unchanged. */
function treeDigest(root: string, sub: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(join(root, sub));
  return out;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("which repository a hook binds to", () => {
  test("the harness's cwd outranks the startup directory the adapter passes", () => {
    const startedIn = repoSaying("the directory the session was launched from");
    const workingIn = repoSaying("the repository the work is actually in");

    const out = run(["context", startedIn, "--hook-event", "SessionStart"], {
      session_id: "s1",
      cwd: workingIn,
    });

    expect(out).toContain("the repository the work is actually in");
    expect(out).not.toContain("the directory the session was launched from");
  });

  test("…including when a transcript_path is present and the hint is recorded", () => {
    const startedIn = repoSaying("startup directory");
    const workingIn = repoSaying("working repository");

    const out = run(["context", startedIn, "--hook-event", "SessionStart"], {
      session_id: "s2",
      cwd: workingIn,
      transcript_path: join(scratch(), "sess.jsonl"),
    });

    expect(out).toContain("working repository");
  });

  test("a subdirectory reads the wiki at the worktree root", () => {
    // Enrollment resolves UPWARD (git rev-parse), so a subdirectory passes the gate. The reads then
    // looked for <repo>/src/docs/wiki and found nothing — silence indistinguishable from "this
    // project has no wiki", which is why nobody notices. `$PWD` is a subdirectory whenever the
    // agent was launched below the repository root, so the adapter reaches this path on its own.
    const repo = repoSaying("one level up");
    mkdirSync(join(repo, "src"), { recursive: true });

    const out = run(["context", join(repo, "src")]);

    expect(out).toContain("one level up");
  });

  test("…via the payload cwd too", () => {
    const repo = repoSaying("one level up");
    mkdirSync(join(repo, "src"), { recursive: true });

    const out = run(["context", repo, "--hook-event", "SessionStart"], { cwd: join(repo, "src") });

    expect(out).toContain("one level up");
  });

  test("an unenrolled cwd is silent even when the positional is enrolled", () => {
    // The precedence runs in the fail-closed direction too: taking the harness's word must never
    // become a way to inject an enrolled repository's wiki into a session sitting somewhere else.
    const enrolled = repoSaying("enrolled and irrelevant here");
    const elsewhere = makeGitRepo(tempDir("llmwiki-binding-unenrolled-"));
    dirs.push(elsewhere);
    mkdirSync(join(elsewhere, "docs", "wiki"), { recursive: true });
    writeFileSync(join(elsewhere, "docs", "wiki", "current-state.md"), "---\ntitle: x\n---\n\nbody\n");

    const out = run(["context", enrolled, "--hook-event", "SessionStart"], { cwd: elsewhere });

    expect(out).toBe("");
  });

  test("a nested project with its own wiki keeps its own wiki", () => {
    // A home directory that is itself a git repository absorbs every non-git project under it into
    // one worktree — so "resolve to the worktree root" would hand those projects someone else's
    // wiki. The nearest wiki wins over the enclosing worktree's.
    const outer = repoSaying("the worktree that swallowed everything");
    const nested = join(outer, "project");
    mkdirSync(join(nested, "docs", "wiki"), { recursive: true });
    writeFileSync(
      join(nested, "docs", "wiki", "current-state.md"),
      "---\ntitle: Current State\n---\n\nDIRECTION: the nested project's own wiki\n",
    );

    const out = run(["context", nested]);

    expect(out).toContain("the nested project's own wiki");
    expect(out).not.toContain("the worktree that swallowed everything");
  });

  test("the walk up stops at the enrolled worktree", () => {
    // Enrollment is consent for ONE worktree. A wiki sitting above it belongs to whoever owns that
    // directory, and no amount of walking may reach it.
    const outside = tempDir("llmwiki-binding-outside-");
    dirs.push(outside);
    mkdirSync(join(outside, "docs", "wiki"), { recursive: true });
    writeFileSync(
      join(outside, "docs", "wiki", "current-state.md"),
      "---\ntitle: Current State\n---\n\nDIRECTION: above the enrolled worktree\n",
    );
    const inner = enrollRepo(makeGitRepo(join(outside, "inner"))); // enrolled, no wiki of its own
    mkdirSync(join(inner, "src"), { recursive: true });

    const out = run(["context", join(inner, "src")]);

    expect(out).toBe("");
  });

  test("outside hook mode an explicit positional is still the human's instruction", () => {
    const named = repoSaying("the repository the human named");

    const out = run(["context", named]);

    expect(out).toContain("the repository the human named");
  });
});

describe("read-injection reads", () => {
  test("neither hook modifies docs/ in the repository it binds to", () => {
    const repo = repoSaying("untouched");
    run(["index", repo]); // the one command that does write a generated page (cold-index.md)
    const before = treeDigest(repo, "docs");

    run(["context", repo, "--hook-event", "SessionStart"], { session_id: "s4", cwd: repo });
    for (const prompt of ["untouched", "direction", "wiki"]) {
      run(["turn-context", repo, "--hook-event", "UserPromptSubmit"], { prompt, session_id: "s4", cwd: repo });
    }

    // Not "no new pages" — no changed BYTES anywhere under docs/. Filing is /wiki-save's job, and
    // a session that merely reads must leave the working tree exactly as it found it.
    expect(treeDigest(repo, "docs")).toEqual(before);
  });
});
