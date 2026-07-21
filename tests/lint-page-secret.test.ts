// page-secret — the prose-side twin of excerpt-secret.
//
// The excerpt path is hard-gated at mint (screenSecrets) and re-checked by lint, but a page's
// PROSE could still carry a credential the session had in context — an env value pasted into a
// milestone, a token inside a quoted command. As with the excerpt rules, the contract under test
// is where the rule stays SILENT: config placeholders and short commit hashes must pass (or every
// setup note costs a close-out), while value-shaped credentials error wherever they sit — prose,
// fenced code, ledger lines. Excerpt lines stay excerpt-secret's finding so one leak yields one fix.
import { test, expect, describe } from "bun:test";
import { Linter, type WikiDoc } from "../src/engine/lint.ts";

// Message assertions are on the English strings; pin the language so a shell exporting
// LLMWIKI_LANG=ko does not fail the suite.
process.env.LLMWIKI_LANG = "en";

const TRANSCRIPT = "abc12345.jsonl";

function page(body: string): string {
  return `---\ntitle: T\ndescription: d\ndate: 2026-07-20\ntags: [a, b]\nstatus: ready\ndomain: decision\nsource: ${TRANSCRIPT}\n---\n\n${body}\n`;
}

describe("lint — page-secret", () => {
  const linter = new Linter(null, null);

  // A wiki page fixture; `docs/wiki/` in the path is what marks it as a wiki doc.
  const doc = (content: string, rel = "docs/wiki/3_decision/d.md", kind = "wiki"): WikiDoc => ({
    id: "doc1",
    path: "/repo/docs/wiki/3_decision/",
    filename: rel.split("/").pop()!,
    relative_path: rel,
    content,
    source_kind: kind,
  });

  const issues = (content: string, rel?: string, kind?: string) => linter._pageSecrets(doc(content, rel, kind), content);
  const codes = (content: string, rel?: string, kind?: string) => issues(content, rel, kind).map((i) => i.code);

  test("a value-shaped credential in prose is an ERROR — a pushed secret cannot be recalled", () => {
    const found = issues(page("토큰 ghp_NOTAREALTOKENNOTAREALTOKEN0000000000 로 호출해 확인했다"));
    expect(found.map((i) => i.code)).toEqual(["page-secret"]);
    expect(found[0]!.severity).toBe("error");
  });

  test("a named assignment with a real-looking value errors — fenced code included", () => {
    expect(codes(page('```bash\nexport DB_PASSWORD="Not-A-Real-Value-123"\n```'))).toEqual(["page-secret"]);
  });

  test("config placeholders stay silent — documentation must not cost close-outs", () => {
    expect(codes(page("설정: `LLMWIKI_API_KEY=<your-key>` 와 `AUTH_TOKEN=${CI_AUTH_TOKEN}`, 예시 `PASSWORD=...`"))).toEqual([]);
  });

  test("ordinary prose with a short commit hash and a path:line stays silent", () => {
    expect(codes(page("커밋 46007c4 에서 value-flag 허용목록을 고쳤다 (src/cli.ts:123 참고)"))).toEqual([]);
  });

  test("a 40-hex blob errors — the shape is a classic token's; shorten the hash instead", () => {
    expect(codes(page(`전체 해시 ${"a1b2c3d4".repeat(5)} 를 그대로 적으면 걸린다`))).toEqual(["page-secret"]);
  });

  test("an excerpt line is excerpt-secret's finding, not page-secret's", () => {
    const content = page(
      `- 자격증명으로 확인했다 [^1]\n\n[^1]: ${TRANSCRIPT}\n    > [2026-06-29 14:02 user] "키는 ghp_NOTAREALTOKENNOTAREALTOKEN0000000000 였다"`,
    );
    expect(codes(content)).toEqual([]);
  });

  test("ledger files are screened too — log lines get committed like any page", () => {
    expect(codes("## [2026-07-21] sync | xoxb-EXAMPLE-NOT-A-REAL-TOKEN 로 배포\n", "docs/wiki/log.md")).toEqual(["page-secret"]);
  });

  test("non-wiki docs are not this rule's business", () => {
    expect(codes("xoxb-EXAMPLE-NOT-A-REAL-TOKEN", "src/notes.md", "repo")).toEqual([]);
  });

  test("each offending line reports once, with its line number in the message", () => {
    const found = issues(page("첫 줄은 안전\nxoxb-EXAMPLE-NOT-A-REAL-TOKEN 로 확인\n중간도 안전\nxoxb-EXAMPLE-NOT-A-REAL-TOKEN 사용"));
    expect(found.length).toBe(2);
    expect(found[0]!.message).toContain("line 12");
    expect(found[1]!.message).toContain("line 14");
  });
});
