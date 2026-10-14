// turn-context excerpts: what rides under each pointer (rule line → best section → summary →
// description), the per-page and whole-block budgets, and the `x-llmwiki` trigger text (rule ·
// recall) that lets a rule page match a prompt sharing none of its title words.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetForTests } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext, pageExcerpt } from "../src/engine/turncontext.ts";

const roots: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function wiki(pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-excerpt-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(pages)) {
    const p = join(root, "docs", "wiki", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  new WikiIndex(root).indexAll();
  return root;
}

const page = (title: string, body: string, extra = "") =>
  `---\ntype: Decision\ntitle: ${title}\ndescription: ${title} 요약\ndate: 2026-10-01\ntags: [a, b]\n${extra}---\n\n${body}\n`;

// Twenty unrelated pages, so the relevance floor (≥ 20 pages) is in force as on a real wiki.
function filler(n = 22): Record<string, string> {
  const out: Record<string, string> = {};
  const topics = ["배포", "회고", "릴리스", "온보딩", "예산", "채용", "문서", "일정", "회의", "보안", "로그"];
  for (let i = 0; i < n; i++) {
    const t = topics[i % topics.length]!;
    out[`2_milestone/filler-${i}.md`] = page(`${t} 기록 ${i}`, `${t} 관련 진행 메모 ${i}. 다음 단계 정리.`.repeat(4));
  }
  return out;
}

const BODY = [
  "> 사람 확인 필요",
  "",
  "## Why",
  "",
  "캡처 데몬이 멈추면 큐가 쌓인다[^1]. 관련 → [결정](../3_decision/x.md).",
  "",
  "## What",
  "",
  "- 트랜스크립트 큐는 capture.db 에 쌓인다[^s2].",
  "- launchd 로 상주한다.",
  "",
  "### Details",
  "",
  "세부 사항만 있다.",
  "",
  "[^1]: a.jsonl",
  "    > [2026-10-01 10:00 user] \"데몬 살려\"",
  "[^s2]: b.jsonl",
].join("\n");

describe("pageExcerpt", () => {
  test("the section sharing the most prompt terms, with provenance stripped", () => {
    const lines = pageExcerpt(BODY, { terms: ["트랜스크립트", "capture.db", "launchd"], max: 500 });
    expect(lines).toEqual(["§ What", "- 트랜스크립트 큐는 capture.db 에 쌓인다.", "- launchd 로 상주한다."]);
  });

  test("footnote markers, definitions, evidence lines go; links keep their text; → never survives", () => {
    const text = pageExcerpt(BODY, { terms: ["데몬이"], max: 500 }).join("\n");
    expect(text).toBe("§ Why\n캡처 데몬이 멈추면 큐가 쌓인다. 관련 -> 결정.");
    expect(text).not.toContain("[^");
    expect(text).not.toContain("a.jsonl");
  });

  test("cross-link lines are navigation, never the excerpt; bold markers go", () => {
    const body = "## Related\n\n- [트랜스크립트 큐 설계](../5_topic/q.md) — grounds\n- 3_decision/트랜스크립트-큐 — extends\n\n## 본문\n\n- **트랜스크립트** 큐는 하루 보관.\n";
    expect(pageExcerpt(body, { terms: ["트랜스크립트"], max: 500 })).toEqual(["§ 본문", "- 트랜스크립트 큐는 하루 보관."]);
  });

  test("a declared rule wins over any section, verbatim", () => {
    const rule = "외부 httpx 요청에는 User-Agent: llmwiki/<ver> 헤더를 붙인다";
    expect(pageExcerpt(BODY, { rule, terms: ["launchd"], max: 500, ko: true })).toEqual([`규칙: ${rule}`]);
    expect(pageExcerpt(BODY, { rule, terms: [], max: 500 })).toEqual([`rule: ${rule}`]);
  });

  test("no overlap → the TL;DR section, else the description", () => {
    const withTldr = BODY.replace("## Why", "## TL;DR\n\n- 한 줄 요약.\n\n## Why");
    expect(pageExcerpt(withTldr, { terms: ["없는말"], max: 500 })).toEqual(["§ TL;DR", "- 한 줄 요약."]);
    expect(pageExcerpt(BODY, { terms: ["없는말"], description: "설명 문장", max: 500 })).toEqual(["설명 문장"]);
  });

  test("the budget counts indentation and newlines; the last line is cut with …", () => {
    const long = `## A\n\n${"가".repeat(300)}\n${"나".repeat(300)}\n`;
    const lines = pageExcerpt(long, { terms: ["가가가"], max: 200 });
    const cost = lines.reduce((n, l) => n + 6 + l.length + 1, 0);
    expect(cost).toBeLessThanOrEqual(200);
    expect(lines.at(-1)!.endsWith("…")).toBe(true);
    expect(pageExcerpt(long, { terms: ["가가가"], max: 50 })).toEqual([]); // a fragment is worse than none
  });
});

describe("buildTurnContext excerpts", () => {
  test("three long pages: each excerpt ≤ 500 chars, the block ≤ 1,600", () => {
    const long = (w: string) => `## 개요\n\n${`${w} 캡처 데몬 트랜스크립트 큐 처리 내용을 길게 설명한다. `.repeat(40)}`;
    const root = wiki({
      ...filler(),
      "3_decision/a.md": page("캡처 데몬 큐 결정 A", long("알파")),
      "3_decision/b.md": page("캡처 데몬 큐 결정 B", long("베타")),
      "4_insight/c.md": page("캡처 데몬 큐 통찰 C", long("감마")),
    });
    const out = buildTurnContext(root, "캡처 데몬 트랜스크립트 큐 처리가 이상해", "", { affinity: null });
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("  • ")).length).toBe(3);
    expect(out.length).toBeLessThanOrEqual(1600);
    // per-page block: the excerpt lines between one pointer and the next
    let block = 0;
    for (const l of lines.slice(1)) {
      if (l.startsWith("  • ")) block = 0;
      else block += l.length + 1;
      expect(block).toBeLessThanOrEqual(500);
    }
    expect(lines.filter((l) => l.startsWith("      ")).length).toBeGreaterThanOrEqual(3);
  });
});

describe("x-llmwiki trigger text", () => {
  const ruleFm = (recall: string) =>
    `x-llmwiki:\n  applies_to: ["src/adapters/**"]\n  rule: "외부 httpx 요청에는 User-Agent 헤더를 붙인다"\n${recall}`;
  const body = "## 결정\n\n외부 API 호출 정책. 헤더 누락으로 차단된 적이 있다.\n".repeat(3);

  test("a recall phrase reaches a prompt that shares no title words, and the rule rides as the excerpt", () => {
    const prompt = "Figma fetch_nodes 추가해줘";
    const without = wiki({ ...filler(), "3_decision/ua.md": page("외부 요청 헤더 규칙", body, ruleFm("")) });
    expect(buildTurnContext(without, prompt, "", { affinity: null })).toBe("");

    const withRecall = wiki({
      ...filler(),
      "3_decision/ua.md": page("외부 요청 헤더 규칙", body, ruleFm('  recall: ["Figma 연동", "fetch_nodes", "외부 API 클라이언트"]\n')),
    });
    const out = buildTurnContext(withRecall, prompt, "", { affinity: null });
    expect(out).toContain("docs/wiki/3_decision/ua.md");
    // Label language follows the wiki (LLMWIKI_LANG may be set by another file in this process).
    expect(out).toMatch(/\n {6}(rule|규칙): 외부 httpx 요청에는 User-Agent 헤더를 붙인다$/);
    // The reason stays title-only: a recall phrase is not what the page is called.
    expect(out).not.toMatch(/titled:|제목:/);
  });

  test("a retired page with recall phrases is still never emitted", () => {
    const root = wiki({
      ...filler(),
      "3_decision/ua.md": page("외부 요청 헤더 규칙", body, `status: deprecated\n${ruleFm('  recall: ["Figma 연동", "fetch_nodes"]\n')}`),
    });
    expect(buildTurnContext(root, "Figma fetch_nodes 추가해줘", "", { affinity: null })).toBe("");
  });
});
