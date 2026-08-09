import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const roots: string[] = [];

function arm(scores: Record<string, number>) {
  return {
    schema_version: 1,
    label: "fixture",
    corpus_files: 1,
    build_failures: 0,
    pages: 2,
    topic_pages: 1,
    bench: {
      subset: "all",
      n: Object.keys(scores).length,
      recall: {
        "r@5": Object.keys(scores).length
          ? Object.values(scores).reduce((sum, value) => sum + value, 0) / Object.keys(scores).length
          : 0,
      },
      tc_pointer_hit: 0,
      tc_refusal_ok: 0,
      n_content: Object.keys(scores).length,
      n_refusal: 0,
      query_set_fingerprint: "fixture-query-set",
      passive: {},
      downstream_read: null,
      per_query: Object.entries(scores).map(([id, score]) => ({ id, "r@5": score })),
    },
    lint_errors: 0,
    lint_warns: 0,
    lintHealth: 1,
    linkIntegrity: 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compare-verdict CLI", () => {
  test("reports changed query deltas in query-id order", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-compare-cli-"));
    roots.push(root);
    const current = join(root, "current.json");
    const challenger = join(root, "challenger.json");
    writeFileSync(current, JSON.stringify(arm({ "z-query": 1, "a-query": 0, unchanged: 1 })));
    writeFileSync(challenger, JSON.stringify(arm({ "z-query": 0, "a-query": 1, unchanged: 1 })));

    const result = Bun.spawnSync([process.execPath, CLI, "compare-verdict", current, challenger], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout?.toString() ?? "";

    expect(result.exitCode).toBe(1);
    expect(output).toContain("a-query delta: +1.000");
    expect(output).toContain("z-query delta: -1.000");
    expect(output.indexOf("a-query delta")).toBeLessThan(output.indexOf("z-query delta"));
    expect(output).not.toContain("unchanged delta");
  });

  test("malformed arm JSON fails closed with a nonzero keep verdict", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-compare-cli-malformed-"));
    roots.push(root);
    const current = join(root, "current.json");
    const challenger = join(root, "challenger.json");
    writeFileSync(current, JSON.stringify(arm({ shared: 0 })));
    const malformed = arm({ shared: 1 });
    malformed.bench.per_query[0]!["r@5"] = 2;
    writeFileSync(challenger, JSON.stringify(malformed));

    const result = Bun.spawnSync([process.execPath, CLI, "compare-verdict", current, challenger], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("=== verdict: keep ===");
    expect(output).toContain("malformed arm report");
    expect(output).toContain("r@5 must be finite in [0,1]");
  });

  test("swapped score kinds for the same query ids exit nonzero with keep", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-compare-cli-kinds-"));
    roots.push(root);
    const currentPath = join(root, "current.json");
    const challengerPath = join(root, "challenger.json");
    const current = arm({ q1: 1, q2: 1 });
    current.bench.n_content = 1;
    current.bench.n_refusal = 1;
    current.bench.tc_refusal_ok = 1;
    current.bench.per_query = [{ id: "q1", "r@5": 1 }, { id: "q2", refusal_ok: true }] as any;
    const challenger = arm({ q1: 1, q2: 1 });
    challenger.bench.n_content = 1;
    challenger.bench.n_refusal = 1;
    challenger.bench.tc_refusal_ok = 1;
    challenger.bench.per_query = [{ id: "q1", refusal_ok: true }, { id: "q2", "r@5": 1 }] as any;
    writeFileSync(currentPath, JSON.stringify(current));
    writeFileSync(challengerPath, JSON.stringify(challenger));

    const result = Bun.spawnSync([process.execPath, CLI, "compare-verdict", currentPath, challengerPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("=== verdict: keep ===");
    expect(output).toContain("incompatible benchmark score kinds");
  });
});
