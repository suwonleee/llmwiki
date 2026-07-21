// Lint rules for v3 evidence excerpts.
//
// The contract under test is where each rule stays SILENT, because that is what decides whether a
// shared wiki is usable. A teammate clones the repo without the author's transcripts; if "cannot
// verify" rendered as an error, every shared page would fail the 0-error gate — the exact failure
// v3 exists to remove. So: secrets always error, verification errors only where it can actually be
// checked, and the missing-excerpt nudge appears only where someone can act on it.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Linter, type WikiDoc } from "../src/engine/lint.ts";

const QUOTE = "로그는 그대로 두고 그 위에 주제층을 얹자";
const TRANSCRIPT = "abc12345.jsonl";

function page(domain: string, body: string): string {
  return `---\ntitle: T\ndescription: d\ndate: 2026-07-20\ntags: [a, b]\nstatus: ready\ndomain: ${domain}\nsource: ${TRANSCRIPT}\n---\n\n${body}\n`;
}

describe("lint — v3 evidence excerpts", () => {
  let linter: Linter;
  let dir: string;
  let transcriptPath: string;

  // A wiki page fixture; `docs/wiki/` in the path is what marks it as a wiki doc.
  const doc = (content: string, rel = "docs/wiki/3_decision/d.md"): WikiDoc => ({
    id: "doc1",
    path: "/repo/docs/wiki/3_decision/",
    filename: "d.md",
    relative_path: rel,
    content,
    source_kind: "wiki",
  });

  // sourceLookup entry for the cited transcript. `local` decides whether the engine can read it —
  // i.e. whether this is the author's machine or a teammate's clone.
  const sources = (local: boolean): Record<string, WikiDoc> => ({
    [TRANSCRIPT]: {
      id: "t1",
      path: "/__transcript__/",
      filename: TRANSCRIPT,
      relative_path: `__transcript__/${TRANSCRIPT}`,
      source_kind: "transcript",
      metadata: JSON.stringify({
        transcript_path: local ? transcriptPath : `/nonexistent/${TRANSCRIPT}`,
        session_id: "abc12345",
      }),
    },
  });

  beforeEach(() => {
    linter = new Linter(null, null);
    dir = mkdtempSync(join(tmpdir(), "llmwiki-lint-excerpt-"));
    transcriptPath = join(dir, TRANSCRIPT);
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-29T14:02:11Z",
        cwd: "/repo",
        message: { role: "user", content: QUOTE },
      }) + "\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const codes = (content: string, local = true) =>
    linter._excerpts(doc(content), content, sources(local)).map((i) => i.code);

  // ---- excerpt-secret ------------------------------------------------------------------------

  test("a secret in an excerpt is an ERROR — a pushed credential cannot be recalled", () => {
    const content = page(
      "decision",
      `- 자격증명으로 확인했다 [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [2026-06-29 14:02 user] "키는 ghp_NOTAREALTOKENNOTAREALTOKEN0000000000 였다"`,
    );
    const issues = linter._excerpts(doc(content), content, sources(true));
    const secret = issues.find((i) => i.code === "excerpt-secret");
    expect(secret?.severity).toBe("error");
  });

  test("secrets are caught on a teammate's machine too (no transcript needed to see a key)", () => {
    const content = page(
      "decision",
      `- x [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [ts user] "xoxb-EXAMPLE-NOT-A-REAL-TOKEN 로 호출했다"`,
    );
    expect(codes(content, /* local */ false)).toContain("excerpt-secret");
  });

  // ---- unverified-excerpt --------------------------------------------------------------------

  test("a fabricated quote is an ERROR when the transcript is readable here", () => {
    const content = page(
      "decision",
      `- 우리는 로그층을 폐기했다 [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [2026-06-29 14:02 user] "로그층을 전부 폐기하기로 확정했다"`,
    );
    const issues = linter._excerpts(doc(content), content, sources(true));
    expect(issues.find((i) => i.code === "unverified-excerpt")?.severity).toBe("error");
  });

  test("a verbatim quote passes clean", () => {
    const content = page("decision", `- 주제층을 얹는다 [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [2026-06-29 14:02 user] "${QUOTE}"`);
    expect(codes(content)).toEqual([]);
  });

  // ---- the teammate-machine contract (the P3 gate) -------------------------------------------

  test("THE CONTRACT: without the transcript, an unverifiable excerpt raises NOTHING", () => {
    const content = page(
      "decision",
      `- 우리는 로그층을 폐기했다 [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [2026-06-29 14:02 user] "이 인용은 검증할 수 없다"`,
    );
    // Same page that errors on the author's machine — silent on a clone. "Cannot check" ≠ "wrong".
    expect(codes(content, /* local */ true)).toContain("unverified-excerpt");
    expect(codes(content, /* local */ false)).toEqual([]);
  });

  // ---- missing-excerpt -----------------------------------------------------------------------

  test("a judgment page with no excerpt gets a WARN — but only while it can still be filled", () => {
    const content = page("decision", `- 무언가 결정했다 [^1]\n\n[^1]: ${TRANSCRIPT}`);
    const issues = linter._excerpts(doc(content), content, sources(true));
    expect(issues.find((i) => i.code === "missing-excerpt")?.severity).toBe("warn");

    // transcript gone (rotated away, or someone else's machine) → nobody can act → stay quiet
    expect(codes(content, /* local */ false)).toEqual([]);
  });

  test("fact-class pages are not nagged — their evidence is the tool record, not a quote", () => {
    for (const domain of ["milestone", "insight", "topic"]) {
      const content = page(domain, `- 무언가 했다 [^1]\n\n[^1]: ${TRANSCRIPT}`);
      expect(codes(content)).toEqual([]);
    }
  });

  test("the whole existing v2 corpus stays clean where transcripts are already gone", () => {
    const content = page("decision", `- 오래된 결정 [^1]\n\n[^1]: ${TRANSCRIPT}`);
    expect(codes(content, /* local */ false)).toEqual([]);
  });
});
