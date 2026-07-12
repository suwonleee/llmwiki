// P0-1a: deterministic retrieval benchmark — golden-set loading, seeded split, scoring.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { loadQueries, ensureSplit, hitAtK, runBench, benchDir } from "../src/engine/bench.ts";

describe("bench", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-bench-"));
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    // two wiki pages with distinct, ≥3-char (trigram floor) content
    writeFileSync(
      join(root, "docs", "wiki", "daemon.md"),
      "---\ntitle: 캡처데몬 운영\nstatus: ready\n---\n\n캡처데몬 재시작 방법과 프로세스 관리 " .repeat(15),
    );
    writeFileSync(
      join(root, "docs", "wiki", "search.md"),
      "---\ntitle: 검색엔진\nstatus: ready\n---\n\n검색엔진 트라이그램 인덱스 구조 ".repeat(15),
    );
    new WikiIndex(root).indexAll();
    mkdirSync(benchDir(root), { recursive: true });
    writeFileSync(
      join(benchDir(root), "golden.toml"),
      `version = "1"

[[query]]
id = "q1"
question = "캡처데몬 재시작 방법"
target_pages = ["docs/wiki/daemon.md"]
must_refuse = false

[[query]]
id = "q2"
question = "트라이그램 인덱스"
target_pages = ["docs/wiki/search.md"]
must_refuse = false

[[query]]
id = "q3"
question = "페루의 수도는 어디인가"
target_pages = []
must_refuse = true
`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("loads TOML golden set and rejects duplicate ids", () => {
    const qs = loadQueries(root);
    expect(qs.length).toBe(3);
    writeFileSync(
      join(benchDir(root), "golden.toml"),
      `[[query]]\nid = "d"\nquestion = "a"\ntarget_pages = []\n\n[[query]]\nid = "d"\nquestion = "b"\ntarget_pages = []\n`,
    );
    expect(() => loadQueries(root)).toThrow(/duplicate/);
  });

  test("split is seeded and stable across calls", () => {
    const qs = loadQueries(root);
    const s1 = ensureSplit(root, qs);
    const s2 = ensureSplit(root, qs); // loads the persisted file
    expect(s1).toEqual(s2);
    expect(s1.tune.length + s1.sealed.length).toBe(3);
    expect(s1.seed).toBe(42);
  });

  test("hitAtK", () => {
    expect(hitAtK(["a.md"], ["b.md", "a.md"], 1)).toBe(0);
    expect(hitAtK(["a.md"], ["b.md", "a.md"], 5)).toBe(1);
    expect(hitAtK(["A.MD"], ["a.md"], 5)).toBe(1); // case-insensitive
    expect(hitAtK([], ["a.md"], 5)).toBe(0);
  });

  test("runBench scores content recall and refusal silence", () => {
    const r = runBench(root, "all");
    expect(r.n).toBe(3);
    expect(r.n_content).toBe(2);
    expect(r.n_refusal).toBe(1);
    expect(r.recall["r@5"]).toBe(1); // both content queries find their page
    expect(r.tc_refusal_ok).toBe(1); // out-of-corpus query → turn-context silent
  });

  test("subset run only scores split members", () => {
    const r = runBench(root, "tune");
    expect(r.n).toBeLessThan(3);
    expect(r.n).toBeGreaterThan(0);
  });

  test("missing golden set throws with guidance", () => {
    rmSync(benchDir(root), { recursive: true, force: true });
    expect(() => runBench(root, "all")).toThrow(/golden\.toml/);
  });
});
