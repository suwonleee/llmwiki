// Page format v3 (evidence excerpts under footnotes) — the invariants that make it safe.
//
// Why these are tests and not a design note: the v3 format is only viable because the excerpt
// lives on an INDENTED CONTINUATION LINE, leaving the footnote definition line byte-identical to
// v2. Four parsers read that line (refs self-heal, lint FOOTNOTE_DEF, lint graph, distill), and
// the self-heal one anchors `\s*$` right after `.jsonl`. Append anything to that line and every
// teammate's transcript citation becomes an unresolved-citation error — the exact failure v3
// exists to prevent. That constraint is invisible in the format itself, so CI holds it.
import { test, expect, describe } from "bun:test";
import { stripEvidence } from "../src/engine/refs.ts";
import { dedupeByPage } from "../src/engine/db.ts";
import { TOPIC_BUDGET } from "../src/engine/lint.ts";

// The real regexes, copied from their owners (refs.ts:43, lint.ts:61-63). Copies, not imports:
// two of them are module-private, and a copy that drifts is exactly what this test should catch.
const SELF_HEAL = /^\[\^[^\]]+\]:\s*([^\s/]+\.jsonl)\s*$/gm;
const FOOTNOTE_DEF = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
const FOOTNOTE_USE = /\[\^([^\]]+)\](?!:)/g;

const ID = "3bd9cac5-8e77-462e-b86b-b5b94871981e.jsonl";
const count = (re: RegExp, s: string) => [...s.matchAll(new RegExp(re.source, re.flags))].length;

const V2 = `- 로그를 유지하고 주제층을 얹는다 [^s1]\n\n[^s1]: ${ID}\n`;
const V3 = `- 로그를 유지하고 주제층을 얹는다 [^s1]\n\n[^s1]: ${ID}\n    > [2026-06-29 14:02 user] "로그는 그대로 두고 그 위에 얹자"\n`;
const SAME_LINE = `- 로그를 유지하고 주제층을 얹는다 [^s1]\n\n[^s1]: ${ID} — "로그는 그대로 두고 얹자"\n`;

describe("page format v3 — parser compatibility", () => {
  test("v3 continuation line leaves every footnote parser reading exactly what v2 gave them", () => {
    for (const [re, name] of [
      [SELF_HEAL, "self-heal"],
      [FOOTNOTE_DEF, "lint footnote-def"],
      [FOOTNOTE_USE, "lint footnote-use"],
    ] as const) {
      expect(`${name}:${count(re, V3)}`).toBe(`${name}:${count(re, V2)}`);
    }
  });

  test("appending the excerpt to the footnote LINE breaks transcript self-heal (why v3 indents)", () => {
    expect(count(SELF_HEAL, V2)).toBe(1);
    expect(count(SELF_HEAL, SAME_LINE)).toBe(0); // → teammate citations become unresolved-citation
    expect(count(FOOTNOTE_DEF, SAME_LINE)).toBe(1); // still parses as a footnote, so lint alone won't catch it
  });
});

describe("stripEvidence — evidence stays in the file, out of the search index", () => {
  test("strips indented evidence lines, keeps the claim and the footnote definition", () => {
    const out = stripEvidence(V3);
    expect(out).toContain("로그를 유지하고 주제층을 얹는다 [^s1]");
    expect(out).toContain(`[^s1]: ${ID}`);
    expect(out).not.toContain("그 위에 얹자");
  });

  test("column-0 blockquotes are body content and survive (conflict callouts must never be dropped)", () => {
    const page = `- fact [^s1]\n\n> [conflict] 두 측정이 어긋난다\n\n[^s1]: ${ID}\n    > [ts user] "인용"\n`;
    const out = stripEvidence(page);
    expect(out).toContain("> [conflict] 두 측정이 어긋난다");
    expect(out).not.toContain('"인용"');
  });

  test("no-op on v2 pages (the whole existing corpus indexes identically)", () => {
    expect(stripEvidence(V2)).toBe(V2);
  });
});

describe("topic budget — evidence must not push prose out", () => {
  test("a page under budget stays under it no matter how much evidence it carries", () => {
    const prose = "- 사실 하나 [^s1]\n".repeat(200); // well under TOPIC_BUDGET
    const evidence = `[^s1]: ${ID}\n    > [ts user] "${"근".repeat(180)}"\n`.repeat(60);
    const page = prose + "\n" + evidence;

    expect(page.length).toBeGreaterThan(TOPIC_BUDGET); // whole file WOULD trigger the nag…
    expect(stripEvidence(page).length).toBeLessThan(TOPIC_BUDGET); // …but its prose is fine
  });
});

describe("dedupeByPage — top-K pages, not top-K chunks", () => {
  test("keeps each page's first (best-ranked) chunk and honors the limit", () => {
    const rows = [
      { relative_path: "a.md", content: "best-a" },
      { relative_path: "a.md", content: "worse-a" }, // same page — must not eat a second slot
      { relative_path: "b.md", content: "best-b" },
      { relative_path: "c.md", content: "best-c" },
    ];
    expect(dedupeByPage(rows).map((r) => r.relative_path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(dedupeByPage(rows)[0]!.content).toBe("best-a"); // first wins = best rank wins
    expect(dedupeByPage(rows, 2).map((r) => r.relative_path)).toEqual(["a.md", "b.md"]);
  });

  test("rows without a path are dropped rather than collapsed into one bogus group", () => {
    expect(dedupeByPage([{ content: "x" }, { relative_path: "", content: "y" }])).toEqual([]);
  });
});
