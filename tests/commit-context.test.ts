import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { relevantCommits } from "../src/engine/commit-context.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";

const roots: string[] = [];
const prev = process.env.LLMWIKI_TURN_COMMITS;
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (prev === undefined) delete process.env.LLMWIKI_TURN_COMMITS;
  else process.env.LLMWIKI_TURN_COMMITS = prev;
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-commits-"));
  roots.push(root);
  const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  const commit = (file: string, msg: string) => {
    writeFileSync(join(root, file), msg);
    git("add", file);
    git("commit", "-q", "-m", msg);
  };
  commit("a.txt", "fix(upload): reject oversized archives before extraction\n\nLarge archives exhausted the worker; the size check now runs before unpacking.");
  for (let i = 0; i < 8; i++) commit(`n${i}.txt`, `chore: tidy formatting pass ${i}`);
  commit("b.txt", "feat(export): sheet export retries once on quota errors");
  mkdirSync(join(root, "docs", "wiki"), { recursive: true });
  return root;
}

describe("commit channel", () => {
  test("LLMWIKI_TURN_COMMITS=off: the turn block is unchanged", () => {
    process.env.LLMWIKI_TURN_COMMITS = "off";
    expect(buildTurnContext(repo(), "why do oversized archives get rejected before extraction?")).toBe("");
  });

  test("default on: an empty wiki still answers from a commit, with subject and first body line", () => {
    process.env.LLMWIKI_TURN_COMMITS = "on";
    const out = buildTurnContext(repo(), "why do oversized archives get rejected before extraction?");
    expect(out).toContain("commits related to this prompt");
    expect(out).toContain("reject oversized archives before extraction");
    expect(out).toContain("size check now runs before unpacking");
    expect(out).not.toContain("tidy formatting");
    expect(out.length).toBeLessThanOrEqual(1600);
  });

  test("on: an unrelated prompt stays silent", () => {
    process.env.LLMWIKI_TURN_COMMITS = "on";
    expect(buildTurnContext(repo(), "what colour should the onboarding banner be?")).toBe("");
  });

  test("a non-git directory yields nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-nogit-"));
    roots.push(dir);
    expect(relevantCommits(dir, ["archives", "extraction"])).toEqual([]);
  });
});
