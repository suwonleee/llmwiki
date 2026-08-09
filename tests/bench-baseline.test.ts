import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { loadQueries, runBench, toBenchBaseline } from "../src/engine/bench.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "bench-baseline");
const roots: string[] = [];

afterEach(() => {
  resetEnrollmentCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public retrieval baseline", () => {
  test("public retrieval baseline remains unchanged", () => {
    const box = tempDir("llmwiki-bench-baseline-");
    roots.push(box);
    const repo = enrollRepo(makeGitRepo(join(box, "repo")));
    cpSync(join(FIXTURE, "wiki"), join(repo, "docs", "wiki"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    cpSync(join(FIXTURE, "evidence", "capture-routing.ts"), join(repo, "src", "capture-routing.ts"));
    new WikiIndex(repo).indexAll();

    const actual = toBenchBaseline(runBench(repo, "all"));
    const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf-8"));

    expect(actual).toEqual(expected);
  });

  test("every code-labelled baseline query names public code evidence", () => {
    const box = tempDir("llmwiki-bench-evidence-");
    roots.push(box);
    const repo = enrollRepo(makeGitRepo(join(box, "repo")));
    cpSync(join(FIXTURE, "wiki"), join(repo, "docs", "wiki"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    const evidence = join(repo, "src", "capture-routing.ts");
    cpSync(join(FIXTURE, "evidence", "capture-routing.ts"), evidence);

    const codeQueries = loadQueries(repo).filter((query) => query.recoverable_from === "code");
    const gitQueries = loadQueries(repo).filter((query) => query.recoverable_from === "git");

    expect(codeQueries.map((query) => query.id)).toEqual(["capture-route"]);
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(evidence, "utf-8")).toContain("cobaltroutingmarker");
    expect(gitQueries).toEqual([]);
  });
});
