// P1-A2: review input bounding (scope selection) + no-change run hash.
// Verifies review stays prompt-bounded as the wiki grows (the ~100-page cliff) without an LLM call.
import { test, expect } from "bun:test";
import { _selectScope, _runHash } from "../src/engine/review.ts";

interface B {
  link: string;
  title: string;
  date: string;
  tldr: string;
  excerpt: string;
  cites: number;
  tags: string[];
}
// date = zero-padded index so lexical compare == recency order (deterministic, no cyclic dates).
function mk(i: number, tags: string[]): B {
  const d = String(i).padStart(4, "0");
  return { link: `p${d}`, title: `t${i}`, date: d, tldr: "", excerpt: `e${i}`, cites: 0, tags };
}

test("small wiki (≤ cap) passes through whole, no scope note", () => {
  const briefs = Array.from({ length: 30 }, (_, i) => mk(i, ["x" + i]));
  const { scoped, note } = _selectScope(briefs, 80);
  expect(scoped.length).toBe(30);
  expect(note).toBe("");
});

test("large wiki is capped at maxPages and emits a bounded note", () => {
  const briefs = Array.from({ length: 200 }, (_, i) => mk(i, ["t" + (i % 5)]));
  const { scoped, note } = _selectScope(briefs, 80);
  expect(scoped.length).toBe(80);
  expect(note).toContain("BOUNDED");
  // the single most-recent page (highest index) must be in scope
  expect(scoped.some((b) => b.link === "p0199")).toBe(true);
});

test("scope keeps recent pages + tag-neighbors, drops unrelated old pages", () => {
  // 7 most-recent share tag 'hot'; one OLD page shares 'hot' (neighbor); other old pages are unrelated.
  const recent = Array.from({ length: 7 }, (_, k) => mk(100 + k, ["hot"]));
  const neighborOld = mk(50, ["hot"]); // shares a core tag → should be pulled in
  // 6 unrelated old pages (total 14 > cap 10 forces scoping; core=7 recent, 3 neighbor slots)
  const unrelatedOld = Array.from({ length: 6 }, (_, k) => mk(49 - k, ["cold"]));
  const { scoped } = _selectScope([...unrelatedOld, neighborOld, ...recent], 10);
  const links = new Set(scoped.map((b) => b.link));
  for (const r of recent) expect(links.has(r.link)).toBe(true); // all recent kept
  expect(links.has("p0050")).toBe(true); // tag-neighbor pulled in
  expect(links.has("p0049")).toBe(false); // unrelated old dropped
  expect(links.has("p0048")).toBe(false);
});

test("runHash is deterministic and changes when content changes", () => {
  const a = Array.from({ length: 5 }, (_, i) => mk(i, ["t"]));
  expect(_runHash(a)).toBe(_runHash(a));
  const b = a.map((x, i) => (i === 2 ? { ...x, excerpt: x.excerpt + "!" } : x));
  expect(_runHash(b)).not.toBe(_runHash(a)); // an edited excerpt invalidates the skip cache
  expect(_runHash(a)).toHaveLength(16);
});
