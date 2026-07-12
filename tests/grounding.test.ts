// Tests for the deterministic grounding layer.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGroundedFacts, assessGrounding } from "../src/engine/grounding.ts";

function fixtureJsonl(): string {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-grounding-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    {
      type: "assistant",
      uuid: "u1",
      timestamp: "2026-06-23T00:00:00Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/engine/db.ts" } }],
      },
    },
    {
      type: "assistant",
      uuid: "u2",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun test tests/" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t2", content: "77 pass, 0 fail" }],
      },
    },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return path;
}

test("collectGroundedFacts pulls file_touch / shell_run / check_result from tool events", () => {
  const path = fixtureJsonl();
  const { facts, corpus } = collectGroundedFacts(path, 0, "claude-jsonl");

  const kinds = facts.map((f) => f.kind);
  expect(kinds).toContain("file_touch");
  expect(kinds).toContain("shell_run");
  expect(kinds).toContain("check_result");

  const fileFact = facts.find((f) => f.kind === "file_touch");
  expect(fileFact?.detail).toContain("/repo/src/engine/db.ts");
  expect(fileFact?.spanHash).toMatch(/^[0-9a-f]{16}$/);

  // corpus carries raw tool input + result text for substring grounding
  expect(corpus).toContain("/repo/src/engine/db.ts");
  expect(corpus).toContain("77 pass");
});

test("collectGroundedFacts degrades gracefully for non-claude kinds", () => {
  const path = fixtureJsonl();
  const { facts, corpus } = collectGroundedFacts(path, 0, "plain");
  expect(facts).toHaveLength(0);
  expect(corpus).toBe("");
});

test("assessGrounding flags a fabricated file path, passes a grounded one", () => {
  const support = "edited /repo/src/engine/db.ts\nbun test tests/\n77 pass, 0 fail";

  const grounded = assessGrounding("Edited `db.ts` and ran the suite: 77 pass.", support);
  expect(grounded.unsupportedPaths).toHaveLength(0);

  const fabricated = assessGrounding("Refactored `payments/checkout.go` end to end.", support);
  expect(fabricated.unsupportedPaths).toContain("payments/checkout.go");
});

test("assessGrounding ignores the page's own provenance (frontmatter source + footnote)", () => {
  const support = "some prose with no paths at all";
  // The transcript filename appears in frontmatter `source:` and the footnote — both are the
  // page's own provenance pointer, not a claim about a file the work touched.
  const body =
    "---\ntitle: x\nsource: a1b2c3d4.jsonl\ntags: [a, b]\n---\n\n" +
    "A summary line with no asserted paths.\n\n[^1]: a1b2c3d4.jsonl";
  const r = assessGrounding(body, support);
  expect(r.unsupportedPaths).toHaveLength(0);
});

test("assessGrounding reports quantitative + overlap signals (advisory)", () => {
  const support = "edited db.ts and saw 77 pass";
  const r = assessGrounding("We hit 999 pass after the change.", support);
  // 999 pass is absent from the evidence → surfaced as advisory (not a hard gate)
  expect(r.unsupportedQuant.join(" ")).toContain("999");
  expect(typeof r.overlap).toBe("number");
});

test("assessGrounding matches across absolute-vs-relative path mismatch", () => {
  // tool event stores an absolute path; the page writes the relative one — must NOT be flagged
  const support = "edit /Users/me/repo/src/engine/db.ts";
  const r = assessGrounding("Touched `src/engine/db.ts` this session.", support);
  expect(r.unsupportedPaths).toHaveLength(0);
  // and the reverse direction
  const r2 = assessGrounding("Touched `/Users/me/repo/src/engine/db.ts`.", "edit src/engine/db.ts");
  expect(r2.unsupportedPaths).toHaveLength(0);
});

test("assessGrounding does not flag file extensions inside URLs / links", () => {
  const support = "no local paths here";
  const url = assessGrounding("See https://example.com/spec/readme.md for context.", support);
  expect(url.unsupportedPaths).toHaveLength(0);
  const link = assessGrounding("Refer to [the spec](https://x.io/a/b/notes.md).", support);
  expect(link.unsupportedPaths).toHaveLength(0);
});

test("collectGroundedFacts handles MultiEdit, string content, malformed lines, is_error", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-grounding2-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "tool_use", name: "MultiEdit", input: { file_path: "/r/x.ts", edits: [] } }] },
    }),
    "{ this is not valid json", // malformed → tolerated
    JSON.stringify({ type: "user", message: { role: "user", content: "plain string mentioning /r/notes.md" } }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: "Error: 3 failed" }] },
    }),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  const { facts, corpus } = collectGroundedFacts(path, 0, "claude-jsonl");

  // MultiEdit recorded as a file_touch
  expect(facts.some((f) => f.kind === "file_touch" && f.detail.includes("/r/x.ts"))).toBe(true);
  // string-form user content captured into corpus
  expect(corpus).toContain("/r/notes.md");
  // an errored tool_result must NOT mint a check_result card
  expect(facts.some((f) => f.kind === "check_result")).toBe(false);
});
