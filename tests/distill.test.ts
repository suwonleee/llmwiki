// distill-verify: deterministic no-loss gate for the deep pass's topic re-distillation (D3).
// The mechanical no-loss contract — citation superset + verbatim [conflict] survival — must be
// engine-enforced, not prose-enforced. Pure functions; no LLM, no workspace.
import { test, expect, describe } from "bun:test";
import { footnoteSources, conflictLines, verifyDistill } from "../src/engine/distill.ts";

const OLD = `---
title: t
---
TL;DR — one line.

- fact A [^s1]
- fact B [^s2]
- fact B again, another session [^s3]

> [conflict] page-x claims 10, this session measured 12 — needs human review

[^s1]: aaaa.jsonl
[^s2]: bbbb.jsonl
[^s3]: bbbb.jsonl
`;

describe("footnoteSources", () => {
  test("distinct, lowercased source set", () => {
    expect([...footnoteSources(OLD)].sort()).toEqual(["aaaa.jsonl", "bbbb.jsonl"]);
  });

  test("uses the same parser as lint (dash-suffix stripped)", () => {
    expect([...footnoteSources("[^1]: cccc.jsonl — probe session\n")]).toEqual(["cccc.jsonl"]);
  });
});

describe("verifyDistill", () => {
  test("passes when every source and conflict callout survives (duplicate footnotes may merge)", () => {
    const distilled = `---
title: t
---
TL;DR — synthesized.

- fact A+B merged [^s1][^s2]

> [conflict] page-x claims 10, this session measured 12 — needs human review

[^s1]: aaaa.jsonl
[^s2]: bbbb.jsonl
`;
    const v = verifyDistill(OLD, distilled);
    expect(v.ok).toBe(true);
    expect(v.droppedSources).toEqual([]);
    expect(v.droppedConflicts).toEqual([]);
    expect(v.oldSources).toBe(2);
    expect(v.newSources).toBe(2);
  });

  test("fails when a citation source is dropped", () => {
    const v = verifyDistill(OLD, "- only A [^s1]\n\n[^s1]: aaaa.jsonl\n");
    expect(v.ok).toBe(false);
    expect(v.droppedSources).toEqual(["bbbb.jsonl"]);
  });

  test("fails when a [conflict] callout does not survive verbatim", () => {
    const noConflict = OLD.replace(/^> \[conflict\].*\n/m, "");
    const v = verifyDistill(OLD, noConflict);
    expect(v.ok).toBe(false);
    expect(v.droppedConflicts.length).toBe(1);
    expect(v.droppedConflicts[0]).toContain("page-x");
  });

  test("source matching is case-insensitive", () => {
    const v = verifyDistill("[^1]: AAAA.jsonl\n", "[^a]: aaaa.jsonl\n");
    expect(v.ok).toBe(true);
  });

  test("new page may ADD sources and callouts freely", () => {
    const grown = OLD + "\n- new fact [^s4]\n\n> [conflict] another one\n\n[^s4]: dddd.jsonl\n";
    expect(verifyDistill(OLD, grown).ok).toBe(true);
  });
});

describe("conflictLines", () => {
  test("extracts trimmed callout lines only", () => {
    const lines = conflictLines("  > [conflict] X vs Y\n> normal quote\ntext");
    expect(lines).toEqual(["> [conflict] X vs Y"]);
  });
});
