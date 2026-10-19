// page-rank.ts: natural-language wiki retrieval for turn-context and `llmwiki search --kind wiki`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetForTests } from "../src/engine/config.ts";
import { loadWikiPages, matchSnippet, rankPages, searchWiki } from "../src/engine/page-rank.ts";

const roots: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function wiki(pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-pagerank-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(pages)) {
    const p = join(root, "docs", "wiki", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

const page = (title: string, body: string, extra = "") => `---\ntype: Note\ntitle: ${title}\ndescription: ${title}\n${extra}---\n\n${body}\n`;

describe("rankPages", () => {
  test("two-character words and particle-glued forms count; rare terms outrank common ones", () => {
    const root = wiki({
      "3_decision/a.md": page("배포 순서", "배포 전에 토큰 만료를 확인한다. 테스트 테스트 테스트."),
      "2_milestone/b.md": page("테스트 정리", "테스트를 돌렸다. 테스트 결과 정리."),
      "2_milestone/c.md": page("회고", "테스트 이야기만 있다."),
    });
    const hits = searchWiki(root, "토큰 만료를 왜 배포 전에 확인해?", 3);
    expect(hits[0]!.page.rel).toBe("3_decision/a.md");
    expect([...hits[0]!.terms]).toEqual(expect.arrayContaining(["토큰", "만료"]));
  });

  test("a term naming the page outranks the same term in another page's body", () => {
    const root = wiki({
      "5_topic/xmind.md": page("XMind 가져오기", "가져오기 규칙."),
      "2_milestone/m.md": page("작업 기록", "오늘 xmind 가져오기 관련 회의를 했다."),
    });
    expect(searchWiki(root, "xmind 가져오기 규칙", 2)[0]!.page.rel).toBe("5_topic/xmind.md");
  });

  test("reserved files, the queue and the quiz layer are not pages; a cold page is identity-only", () => {
    const root = wiki({
      "index.md": "# Decision\n\n* [x](x.md) - 비밀단어\n",
      "log.md": "# Log\n\n## 2026-10-13\n\n* **Update**: 비밀단어\n",
      "0_review/q.md": page("큐", "비밀단어"),
      "6_quiz/2026-10-13-quiz.md": page("퀴즈", "비밀단어"),
      "4_insight/cold.md": page("보관 페이지", "비밀단어 본문", "tier: cold\ntags: [archive, 보관태그]\n"),
    });
    expect(loadWikiPages(root).map((p) => p.rel)).toEqual(["4_insight/cold.md"]);
    expect(searchWiki(root, "비밀단어", 5)).toEqual([]);
    expect(searchWiki(root, "보관태그", 5)[0]!.page.rel).toBe("4_insight/cold.md");
  });

  test("the snippet is the body line holding the most matched terms", () => {
    const root = wiki({ "3_decision/a.md": page("A", "첫 줄.\n토큰 만료 확인 절차.\n[^1]: x.jsonl") });
    const [hit] = rankPages(loadWikiPages(root), ["토큰", "만료"]);
    expect(matchSnippet(hit!.page, hit!.terms)).toBe("토큰 만료 확인 절차.");
  });
});


describe("OKF descriptive type neutrality", () => {
  const typed = (type: string, body = "cache behavior") => page("cache", body).replace("type: Note", `type: ${type}`);

  test("preserves descriptive and custom types, and tolerates absent types", () => {
    const root = wiki({
      "a.md": typed("Decision"), "b.md": typed("Deployment Guide"),
      "c.md": page("cache", "cache").replace("type: Note\n", ""),
    });
    const types = loadWikiPages(root).sort((a, b) => a.rel.localeCompare(b.rel)).map(p => p.type);
    expect(types).toEqual(["Decision", "Deployment Guide", ""]);
    expect(searchWiki(root, "cache", 5)).toHaveLength(3);
  });

  test("changing only type cannot change ranking for causal, decision, or explanation questions", () => {
    const first = wiki({ "a.md": typed("Topic"), "b.md": typed("Decision"), "c.md": typed("Custom") });
    const swapped = wiki({ "a.md": typed("Decision"), "b.md": typed("Custom"), "c.md": typed("Topic") });
    for (const query of [
      "Why does cache eviction happen?", "Why is cache deployment failing?",
      "왜 cache 연결이 끊기는가?", "Explain the decision to use cache",
      "Explain why we chose cache", "How does cache work?",
      "cache 선택 이유", "cache 구조를 설명해줘", "why cache and how does cache work?",
    ]) {
      const ranks = (root: string) => searchWiki(root, query, 5).map(r => ({ rel: r.page.rel, relevance: r.relevance }));
      expect(ranks(first)).toEqual(ranks(swapped));
      expect(ranks(first).map(r => r.rel)).toEqual(["a.md", "b.md", "c.md"]);
    }
  });

  test("no lexical match stays silent regardless of type", () => {
    const root = wiki({ "a.md": typed("Decision"), "b.md": typed("Topic") });
    expect(searchWiki(root, "why zephyr?", 5)).toEqual([]);
    expect(searchWiki(root, "explain zephyr", 5)).toEqual([]);
  });
});


describe("OKF descriptive tags", () => {
  test("warm and cold pages are discoverable by tags without claiming title provenance", () => {
    const root = wiki({
      "a.md": page("Caching", "cache policy", "tags: [invalidation]\n"),
      "b.md": page("Archived policy", "hiddencontent", "tags: [invalidation]\ntier: cold\n"),
    });
    const hits = searchWiki(root, "invalidation", 5);
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(hit.idTerms.has("invalidation")).toBe(true);
      expect(hit.shownIdTerms.has("invalidation")).toBe(false);
      expect(hit.coverage).toBe(2);
    }
    expect(searchWiki(root, "hiddencontent", 5)).toEqual([]);
  });

  test("title evidence outweighs a tag and malformed tag shapes add no matches", () => {
    const root = wiki({
      "a.md": page("unrelated", "", "tags: [invalidation]\n"),
      "b.md": page("invalidation", ""),
      "c.md": page("other", "", "tags: { invalidation: true }\n"),
    });
    expect(searchWiki(root, "invalidation", 5).map(r => r.page.rel)).toEqual(["b.md", "a.md"]);
  });
});

test("search snippets preserve case-sensitive identifiers and original source text", () => {
  const source = "Set X-Request-ID with process.env.API_TOKEN; do not rename it.";
  const root = wiki({ "request.md": page("Request policy", source) });
  const [hit] = searchWiki(root, "x-request-id api_token", 1);
  expect(hit).toBeDefined();
  expect(matchSnippet(hit!.page, hit!.terms)).toBe(source);
});

test("cold-tier lookup never exposes archived body through original-case snippets", () => {
  const root = wiki({ "cold.md": page("ArchiveToken", "ArchiveToken secret implementation.", "tier: cold\n") });
  const [hit] = searchWiki(root, "ArchiveToken", 1);
  expect(hit).toBeDefined();
  expect(matchSnippet(hit!.page, hit!.terms)).not.toContain("secret implementation");
});

 test("overlong declared instructions are withheld whole, never truncated", () => {
  const root = wiki({ "3_decision/long-rule.md": page("Retry policy", "Retry policy background.", `x-llmwiki:\n  rule: "${"Always retry ".repeat(100)}except when the service rejects authentication"\n`) });
  expect(loadWikiPages(root)[0]!.rule).toBe("");
 });
