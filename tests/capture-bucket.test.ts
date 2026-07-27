// Where capture FILES a session decides whether a human ever sees it.
//
// update-status and the cold-start backlog query by the wiki root; a row keyed by the session's
// bare cwd (a subdirectory, a non-git folder inside an enrolled worktree) matches neither —
// captured, invisible, unselectable. Under self-selection that is the worst state: the session
// ages toward the harness's deletion as if the human had judged it not worth keeping, and the
// human was never shown it to judge. 29 live rows sat that way on the author's machine.
// The rule is the hook-binding rule applied to the write side: reads and writes share ONE answer.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { captureBucket } from "../src/engine/wiki-root.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-bucket-"));
  dirs.push(d);
  return d;
}

function repoWithWiki(): string {
  const r = makeGitRepo(tempDir("llmwiki-bucket-repo-"));
  dirs.push(r);
  mkdirSync(join(r, "docs", "wiki"), { recursive: true });
  return enrollRepo(r);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("captureBucket — a row is filed where its reads bind", () => {
  test("a subdirectory cwd files under the worktree's wiki root", () => {
    const repo = repoWithWiki();
    mkdirSync(join(repo, "src", "deep"), { recursive: true });

    expect(captureBucket(join(repo, "src", "deep"))).toBe(repo);
  });

  test("a nested project with its own wiki keeps its own bucket", () => {
    const outer = repoWithWiki();
    const nested = join(outer, "project");
    mkdirSync(join(nested, "docs", "wiki"), { recursive: true });

    expect(captureBucket(nested)).toBe(nested);
  });

  test("enrolled but no wiki anywhere → the worktree, where init will put one", () => {
    const repo = enrollRepo(makeGitRepo(tempDir("llmwiki-bucket-nowiki-")));
    dirs.push(repo);
    mkdirSync(join(repo, "sub"));

    expect(captureBucket(join(repo, "sub"))).toBe(repo);
  });

  test("outside any enrollment the cwd is returned unchanged — never invent a parent", () => {
    const stray = tempDir("llmwiki-bucket-stray-");
    dirs.push(stray);

    expect(captureBucket(stray)).toBe(stray);
  });

  test("enqueue itself normalizes, so no caller can reintroduce the raw-cwd bucket", () => {
    capture.setStateDir(join(scratch(), "state"));
    const repo = repoWithWiki();
    const sub = join(repo, "src");
    mkdirSync(sub, { recursive: true });
    const t = join(scratch(), "t.jsonl");
    writeFileSync(t, '{"a":1}\n');

    capture.enqueue(t, "s1", sub, 60);

    expect(capture.pending(repo).length).toBe(1); // visible where update-status looks…
    expect(capture.pending(sub).length).toBe(1); // …and via any other spelling of the same place
    expect(capture.pending(repo)[0]!.repo).toBe(repo); // …because there is ONE canonical key
  });

  test("route hints normalize the same way", () => {
    capture.setStateDir(join(scratch(), "state"));
    const repo = repoWithWiki();
    const sub = join(repo, "packages", "core");
    mkdirSync(sub, { recursive: true });
    const t = join(scratch(), "hinted.jsonl");
    writeFileSync(t, '{"a":1}\n');

    capture.recordRouteHint(t, sub, "s2", "claude-jsonl");

    expect(capture.routeHintFor(t)?.repo).toBe(repo);
  });
});
