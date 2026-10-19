// Long Korean prompts: two-character nouns must survive, question endings must not take slots.
//
// The sub-floor pass used to be `extractTerms(prompt, 2)` minus the main terms. That list is capped
// at the 12 LONGEST candidates, so on any prompt with 12+ longer tokens every two-character word was
// cut before the subtraction — the pass meant for 승인·예산·배포 returned nothing on exactly the long
// prompts it exists for. Interrogative forms (…되나요, …있나요) filled those slots instead, and they
// almost never appear in wiki prose.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTerms, subFloorTerms } from "../src/engine/query-terms.ts";
import { promptTerms, searchWiki } from "../src/engine/page-rank.ts";

const LONG =
  "배포 파이프라인에서 권한 검사를 통과한 요청만 승인되는데, 예산 한도를 넘긴 사용자의 요청은 어떻게 처리되나요? 재시도 정책도 그대로 적용되나요?";

describe("sub-floor terms on long Korean prompts", () => {
  test("two-character nouns survive a prompt with many longer tokens", () => {
    const main = extractTerms(LONG);
    expect(main.length).toBe(12);
    const sub = subFloorTerms(LONG, main);
    for (const w of ["배포", "권한", "검사", "승인", "예산", "한도", "처리"]) expect(sub).toContain(w);
  });

  test("a 하다/되다 question yields its noun stem", () => {
    expect(subFloorTerms("정책이 그대로 적용되나요?", [])).toContain("적용");
    expect(subFloorTerms("이 요청을 승인할 수 있나요?", [])).toContain("승인");
  });

  test("interrogative forms do not take main-term slots; their stems are kept", () => {
    const main = extractTerms(LONG);
    expect(main).not.toContain("처리되나요");
    expect(main).not.toContain("적용되나요");
    expect(subFloorTerms(LONG, main)).toContain("처리");
  });

  test("a stem-less question word yields nothing", () => {
    const { terms, subFloor } = promptTerms("이 설정 지금도 있나요? 어떻게 되나요?");
    expect([...terms, ...subFloor]).not.toContain("있나요");
    expect([...terms, ...subFloor]).not.toContain("되나요");
    expect(subFloor).toContain("설정");
  });

  test("sub-floor keeps prompt order and its own cap, and never repeats main terms", () => {
    const main = extractTerms(LONG);
    const sub = subFloorTerms(LONG, main);
    expect(sub.length).toBeLessThanOrEqual(12);
    expect(sub[0]).toBe("배포");
    for (const t of sub) expect(main.map((m) => m.toLowerCase())).not.toContain(t.toLowerCase());
  });

  test("non-Korean prompts are unchanged", () => {
    expect(subFloorTerms("rename src/engine/db.ts connection pool", [])).toEqual([]);
    expect(extractTerms("rename src/engine/db.ts connection pool")).toContain("src/engine/db.ts");
  });
});

describe("search reaches a page through two-character nouns of a long prompt", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  test("the budget page ranks first", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-subfloor-"));
    roots.push(root);
    const wiki = join(root, "docs", "wiki", "5_topic");
    mkdirSync(wiki, { recursive: true });
    const page = (title: string, body: string) => `---\ntype: Topic\ntitle: ${title}\ndescription: ${title}\ndate: 2026-10-19\ntags: [topic, test]\nstatus: stable\n---\n\n${body}\n`;
    writeFileSync(join(wiki, "budget.md"), page("사용자별 한도", "예산 한도를 넘긴 요청은 승인 단계에서 거절한다. 재시도는 적용하지 않는다.\n"));
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(wiki, `other-${i}.md`), page(`파이프라인 메모 ${i}`, "파이프라인에서 사용자의 요청을 그대로 통과시키는 정책을 기록한다.\n"));
    }
    expect(searchWiki(root, LONG, 3)[0]?.page.rel).toBe("5_topic/budget.md");
  });
});
