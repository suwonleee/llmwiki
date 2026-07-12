// Byte-stability contract (P2): with STOCK conventions, every config-rendered prompt/rules text
// is byte-identical to the historical hardcoded text — proving the render refactor is a no-op
// for default users without any LLM A/B. Custom configs take the generic branch (also pinned).
import { test, expect } from "bun:test";
import {
  defaults, isStockConventions, renderDomainBullets, renderDomainList,
  renderGroundingRule, renderTerminologyLine, renderRuleCategories, renderRuleHumanQueue,
} from "../src/engine/config.ts";
import { schemaText, writePromptTemplate } from "../src/engine/autoupdate.ts";

test("stock conventions are detected", () => {
  expect(isStockConventions(defaults())).toBe(true);
});

test("schemaText renders byte-identical to the historical _SCHEMA prompt (stock)", () => {
  expect(schemaText(defaults())).toBe(`Wiki page rules (strict):
- Begin the file with a YAML frontmatter block containing: title, description (one sentence), date (YYYY-MM-DD), tags ([2+ entries]), status (ready|draft), domain, source.
- Choose ONE domain for this page and set the \`domain:\` field to it:
  - direction — the project's big direction/strategy, OR a shift in it this session (from what → to what, and why). Rare.
  - milestone — work progress + what's next: what was built / changed / measured this session, plus any remaining TODOs the human stated.
  - decision — an ADR: a problem the HUMAN faced this (or a past) session, the alternatives weighed, and the choice made (context / decision / alternatives / consequences).
  - insight — a realization or lesson surfaced while working with the human (a gotcha, a non-obvious learning, what made the result better) that helps future work.
- Every factual claim must carry a footnote citation \`[^1]\`, and the file must end with \`[^1]: <TRANSCRIPT_FILENAME>\`.
- Grounding rule: write only what is grounded in the transcript. For milestone, record stated facts. For insight / decision / direction, summarize what the HUMAN actually realized or decided — never invent judgments, opinions, or decisions the human did not make. When unsure, omit.
- Usefulness rule: everything written must help the NEXT work session. No filler, no restating the obvious.
- Write the page body in the SAME language as the session transcript / conversation (match the source; do not force or translate to a fixed language). Use English if the source language is unclear.
- Regardless of the prose language, keep code identifiers, file paths, function/API names, CLI commands, config keys, and error strings VERBATIM in their original form (do not translate or transliterate them) — they are the language-invariant search anchors of this wiki.
- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't naturally say — e.g. when writing Korean prefer \`방향성\` (NOT 진북/북극성/north-star) and \`업데이트\`/\`update\` (NOT distill).`);
});

test("writePromptTemplate keeps the historical domain-pick phrase and terminology line (stock)", () => {
  const wp = writePromptTemplate(defaults());
  expect(wp).toContain("(direction, milestone, decision, or insight) and set the `domain:` frontmatter field.");
  expect(wp).toContain("- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't say — e.g. when writing Korean prefer `방향성` (not 진북/북극성/north-star) and `업데이트`/`update` (not distill).");
});

test("cold-start rules render byte-identical to the historical text (stock)", () => {
  expect(renderRuleCategories("en")).toBe(
    "2) Record only what helps future work (no noise). Categories (reading order): 1_direction (big direction) / 2_milestone (work done + what's next) / 3_decision (problem·alternatives·choice = ADR) / 4_insight (realizations·gotchas while working).",
  );
  expect(renderRuleHumanQueue("ko")).toBe(
    "   방향성 전환(1_direction)만 사람 판단: 본문을 단정하지 말고 docs/wiki/0_review/ 에 올려 사람이 확정하게 한다. 분류 애매·품질 실패는 0_review로 보내지 말 것(모델이 판단/기각). 사람이 방향성을 처리하면 그 파일은 삭제.",
  );
});

test("custom conventions take the generic branch with the config's own words", () => {
  const c = defaults();
  c.categories = [
    { dir: "1_goal", domain: "goal", review: "human", guide: "분기 목표" },
    { dir: "2_lesson", domain: "lesson", review: "model", guide: "교훈" },
  ];
  expect(isStockConventions(c)).toBe(false);
  expect(renderDomainBullets(c)).toBe("  - goal — 분기 목표\n  - lesson — 교훈");
  expect(renderDomainList(c)).toBe("goal, or lesson");
  expect(renderGroundingRule(c)).toContain("For lesson, record stated facts. For goal,");
  expect(renderRuleCategories("ko", c)).toContain("1_goal (분기 목표) / 2_lesson (교훈)");
  expect(renderRuleHumanQueue("en", c)).toContain("(1_goal)");
  c.bannedTerms = [["foo", "bar"]];
  expect(renderTerminologyLine(c)).toContain("`foo` (prefer `bar`)");
});
