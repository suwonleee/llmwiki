// P2: gap-queue lifecycle — extract review findings → track → self-close (loop-until-dry). LLM-0.
import { test, expect } from "bun:test";
import {
  extractGapsFromReview,
  parseQueue,
  renderQueue,
  RESOLVE_AFTER,
  type Gap,
} from "../src/engine/gaps.ts";

const REVIEW_EN = `---
title: review
---
## Contradiction
(none)
## Stale claim
(none)
## Missing concept page
- A page for the **ArtifactStore** seam is referenced in 3 sessions but missing.
- "retry policy" recurs with no page.
## Cross-references & next questions
- Should [[2_milestone/x]] link to [[3_decision/y]]?
## Grounding & citations
(none)
`;

test("extractGapsFromReview pulls missing-concept + next-question bullets, skips (none)", () => {
  const g = extractGapsFromReview(REVIEW_EN);
  expect(g.length).toBe(3);
  expect(g.filter((x) => x.type === "missing-concept").length).toBe(2);
  expect(g.filter((x) => x.type === "next-question").length).toBe(1);
  expect(g.some((x) => x.text.includes("ArtifactStore"))).toBe(true);
});

test("Korean headings are matched too", () => {
  const ko = `## 모순\n(없음)\n## 개념 누락\n- 캐시 무효화 정책 페이지 없음\n## 교차참조·다음 질문\n- [[a]]와 [[b]] 연결?\n`;
  const g = extractGapsFromReview(ko);
  expect(g.length).toBe(2);
  expect(g[0]!.type).toBe("missing-concept");
  expect(g[1]!.type).toBe("next-question");
});

test("render → parse round-trips state (hash, absent, status)", () => {
  const gaps: Gap[] = [
    { hash: "abc123", type: "missing-concept", text: "X page", status: "open", absent: 0, firstSeen: "2026-06-30", lastSeen: "2026-06-30" },
    { hash: "def456", type: "next-question", text: "link a,b?", status: "resolved", absent: 2, firstSeen: "2026-06-28", lastSeen: "2026-06-29" },
  ];
  const md = renderQueue(gaps, "2026-06-30");
  const back = parseQueue(md);
  expect(back.length).toBe(2);
  const open = back.find((g) => g.hash === "abc123")!;
  expect(open.status).toBe("open");
  expect(open.absent).toBe(0);
  const res = back.find((g) => g.hash === "def456")!;
  expect(res.status).toBe("resolved");
  expect(res.absent).toBe(2);
});

test("RESOLVE_AFTER is the loop-until-dry threshold (>=2)", () => {
  expect(RESOLVE_AFTER).toBeGreaterThanOrEqual(2);
});
