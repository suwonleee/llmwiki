// P1-B2: overview normalizer keeps the entry point bounded (Recent Updates → log pointer),
// deterministically and idempotently, preserving curated sections. LLM-0.
import { test, expect } from "bun:test";
import { normalizeOverviewText, RECENT_POINTER_KO } from "../src/engine/overview.ts";

const CURATED = `---
title: Overview
---

## Key Findings
- 큐레이션된 통찰 A [[2_milestone/x]]
- 큐레이션된 통찰 B [[3_decision/y]]
`;

test("collapses a grown Recent Updates body to the pointer; preserves curated content", () => {
  const bloated =
    CURATED +
    `
## Recent Updates
- 2026-06-30 — 긴 세션 단락 1 ...
- 2026-06-29 — 긴 세션 단락 2 ...
- 2026-06-28 — 긴 세션 단락 3 ...
`;
  const { text, collapsed } = normalizeOverviewText(bloated, "ko");
  expect(collapsed).toBe(true);
  expect(text).toContain("## Key Findings"); // curated kept
  expect(text).toContain("큐레이션된 통찰 A");
  expect(text).toContain(RECENT_POINTER_KO);
  expect(text).not.toContain("긴 세션 단락 1"); // session prose removed
  expect((text.match(/^- /gm) || []).length).toBe(2); // only the 2 curated bullets remain
});

test("idempotent: already-canonical overview is unchanged", () => {
  const canonical = CURATED + `\n## Recent Updates\n\n${RECENT_POINTER_KO}\n`;
  const { text, collapsed } = normalizeOverviewText(canonical, "ko");
  expect(collapsed).toBe(false);
  expect(text).toBe(canonical);
});

test("no Recent Updates section → untouched", () => {
  const { text, collapsed } = normalizeOverviewText(CURATED, "ko");
  expect(collapsed).toBe(false);
  expect(text).toBe(CURATED);
});

test("preserves a section that comes AFTER Recent Updates", () => {
  const withTrailing =
    CURATED +
    `\n## Recent Updates\n- ZZSESSIONPROSE 세션 기록 ...\n\n## 관련 기록\n- [[2_milestone/z]]\n`;
  const { text, collapsed } = normalizeOverviewText(withTrailing, "ko");
  expect(collapsed).toBe(true);
  expect(text).toContain("## 관련 기록"); // trailing curated section survives
  expect(text).toContain("[[2_milestone/z]]");
  expect(text).toContain(RECENT_POINTER_KO);
  expect(text).not.toContain("ZZSESSIONPROSE"); // distinct marker (pointer text itself contains "세션")
});
