// P0-1b: frozen-corpus A/B — deterministic core (scoreArm + judgeArms). No LLM:
// arms are hand-built wikis; runArm's ingest path is covered by ingest's own tests.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreArm, judgeArms, type ArmResult } from "../src/engine/compare.ts";

function makeWiki(root: string, opts: { withBench?: boolean; goodPage?: boolean } = {}) {
  mkdirSync(join(root, "docs", "wiki"), { recursive: true });
  const body = opts.goodPage
    ? "---\ntitle: 캡처데몬 운영\ndescription: d\ndate: 2026-07-06\ntags: [a, b]\nstatus: ready\n---\n\n캡처데몬 재시작 방법과 프로세스 관리 ".repeat(1) + "캡처데몬 상세 ".repeat(30)
    : "no frontmatter at all\n"; // missing-frontmatter → lint error
  writeFileSync(join(root, "docs", "wiki", "daemon.md"), body);
  if (opts.withBench) {
    mkdirSync(join(root, "docs", "wiki", ".bench"), { recursive: true });
    writeFileSync(
      join(root, "docs", "wiki", ".bench", "golden.toml"),
      `[[query]]\nid = "q1"\nquestion = "캡처데몬 재시작"\ntarget_pages = ["docs/wiki/daemon.md"]\nmust_refuse = false\n`,
    );
  }
}

describe("compare scoreArm", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-cmp-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("scores a healthy arm with bench", () => {
    makeWiki(root, { withBench: true, goodPage: true });
    const r = scoreArm(root, "current", { corpus: 1, failures: 0 });
    expect(r.pages).toBe(1);
    expect(r.topic_pages).toBe(0); // daemon.md is not under 5_topic/
    expect(r.lint_errors).toBe(0);
    expect(r.bench).not.toBeNull();
    expect(r.bench!.recall["r@5"]).toBe(1);
    expect(r.lintHealth).toBeGreaterThanOrEqual(0.5); // 1 page + its orphan-page warn → exactly 0.5
    expect(r.linkIntegrity).toBe(1); // no links → healthy
  });

  test("lint errors depress lintHealth; missing bench → null", () => {
    makeWiki(root, { withBench: false, goodPage: false });
    const r = scoreArm(root, "current", { corpus: 1, failures: 0 });
    expect(r.lint_errors).toBeGreaterThan(0);
    expect(r.bench).toBeNull();
    expect(r.lintHealth).toBeLessThan(1);
  });
});

describe("compare judgeArms (sequential gates, regression-block first)", () => {
  const arm = (over: Partial<ArmResult>): ArmResult => ({
    label: "x",
    corpus_files: 3,
    build_failures: 0,
    pages: 5,
    topic_pages: 2,
    bench: {
      subset: "all", n: 2, recall: { "r@5": 1 }, tc_pointer_hit: 1, tc_refusal_ok: 1,
      n_content: 1, n_refusal: 1,
      per_query: [{ id: "q1", "r@5": 1 }, { id: "q2", refusal_ok: true }],
    } as any,
    lint_errors: 0,
    lint_warns: 0,
    lintHealth: 1,
    linkIntegrity: 1,
    ...over,
  });
  const withScores = (s: Record<string, number>, over: Partial<ArmResult> = {}): ArmResult =>
    arm({
      bench: {
        subset: "all", n: Object.keys(s).length, recall: {}, tc_pointer_hit: 0, tc_refusal_ok: 0,
        n_content: Object.keys(s).length, n_refusal: 0,
        per_query: Object.entries(s).map(([id, v]) => ({ id, "r@5": v })),
      } as any,
      ...over,
    });

  test("challenger partial → keep", () => {
    const v = judgeArms(arm({}), arm({ build_failures: 1 }));
    expect(v.verdict).toBe("keep");
  });

  test("single query regression < -0.10 blocks even with better average", () => {
    const cur = withScores({ q1: 1, q2: 0, q3: 0 });
    const cha = withScores({ q1: 0, q2: 1, q3: 1 }); // avg +0.33 but q1 dropped 1→0
    expect(judgeArms(cur, cha).verdict).toBe("keep");
  });

  test("structural regression blocks", () => {
    const v = judgeArms(arm({}), arm({ linkIntegrity: 0.8, pages: 6 }));
    expect(v.verdict).toBe("keep");
  });

  test("no shared queries → undecided", () => {
    const v = judgeArms(arm({ bench: null }), arm({ bench: null }));
    expect(v.verdict).toBe("undecided");
  });

  test("avg > +0.10 → adopt", () => {
    const cur = withScores({ q1: 0, q2: 0 });
    const cha = withScores({ q1: 1, q2: 1 });
    const v = judgeArms(cur, cha);
    expect(v.verdict).toBe("adopt");
    expect(v.avg_query_delta).toBe(1);
  });

  test("pages changed + small positive delta → adopt", () => {
    const cur = withScores({ q1: 1, q2: 0, q3: 1, q4: 1, q5: 1, q6: 1, q7: 1, q8: 1, q9: 1, q10: 1, q11: 1, q12: 1 });
    const cha = withScores(
      { q1: 1, q2: 1, q3: 1, q4: 1, q5: 1, q6: 1, q7: 1, q8: 1, q9: 1, q10: 1, q11: 1, q12: 1 },
      { pages: 6 },
    ); // avg delta +0.083 (≤0.10) but output changed with a positive delta
    expect(judgeArms(cur, cha).verdict).toBe("adopt");
  });

  test("identical arms → undecided (no decisive delta)", () => {
    expect(judgeArms(arm({}), arm({})).verdict).toBe("undecided");
  });
});
