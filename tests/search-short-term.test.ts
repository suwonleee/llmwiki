// Queries whose words are shorter than a trigram.
//
// SQLite's trigram tokenizer indexes three-character sequences, so a MATCH term with fewer than
// three characters has nothing in the index to compare against. That is not an English edge case:
// 언어 · 세션 · 보안 · 言語 · 语言 · 設定 are ordinary two-character words, and this tokenizer was
// chosen precisely BECAUSE it segments CJK. So the words a Korean, Japanese or Chinese reader is
// most likely to type are exactly the ones the index cannot answer — and worse, quoting one into
// the implicit-AND MATCH empties an otherwise good query.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { WikiIndex, ftsSanitize } from "../src/engine/db.ts";

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${title}\ndate: 2026-07-25\ntags: [topic, test]\nstatus: ready\n---\n\n${body}\n`;
}

describe("short-term search", () => {
  let root: string;
  let wiki: string;
  let idx: WikiIndex;
  let conn: Database;

  const paths = (rows: { relative_path?: unknown }[]) => rows.map((r) => String(r.relative_path));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-shortterm-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(
      join(wiki, "ko.md"),
      page(
        "언어 설정",
        "위키가 쓰는 언어는 설정으로 바꿀 수 있다. ".repeat(6) +
          "세션마다 다른 언어를 쓰는 팀도 같은 규칙을 공유한다. ".repeat(6),
      ),
    );
    writeFileSync(
      join(wiki, "ja.md"),
      page("言語の設定", "ウィキが書く言語は設定で変えられる。".repeat(12) + "チームで同じ規則を共有する。".repeat(8)),
    );
    writeFileSync(
      join(wiki, "zh.md"),
      page("语言设置", "维基使用的语言可以通过配置修改。".repeat(12) + "团队共享同样的规则。".repeat(8)),
    );
    writeFileSync(
      join(wiki, "en.md"),
      page("Database notes", "The db connection pool is configured per repository. ".repeat(10)),
    );
    idx = new WikiIndex(root);
    conn = idx.connect();
    idx.indexAll(conn);
  });

  afterEach(() => {
    conn.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a two-character Korean word finds the page that contains it", () => {
    expect(paths(idx.search(conn, "언어"))).toContain("docs/wiki/ko.md");
  });

  test("two-character Japanese and Chinese words work the same way", () => {
    expect(paths(idx.search(conn, "言語"))).toContain("docs/wiki/ja.md");
    expect(paths(idx.search(conn, "语言"))).toContain("docs/wiki/zh.md");
  });

  test("a two-letter Latin word is not silently unanswerable either", () => {
    expect(paths(idx.search(conn, "db"))).toContain("docs/wiki/en.md");
  });

  test("several short words are ANDed, not ORed", () => {
    // ko.md has both; ja.md has neither of these exact strings.
    expect(paths(idx.search(conn, "언어 세션"))).toContain("docs/wiki/ko.md");
    expect(paths(idx.search(conn, "언어 존재하지"))).toEqual([]);
  });

  test("one short word no longer empties a query that also has a long one", () => {
    // "설정으로" is matchable; "언어" alone is not. Together they must still find the page.
    expect(paths(idx.search(conn, "언어 설정으로"))).toContain("docs/wiki/ko.md");
  });

  test("a short word that appears nowhere still returns nothing", () => {
    expect(idx.search(conn, "뷁")).toEqual([]);
  });

  test("LIKE metacharacters in a short query are matched literally, not as wildcards", () => {
    // Were the fallback pattern unescaped, "%_" would match every chunk in the wiki.
    expect(idx.search(conn, "%_")).toEqual([]);
  });

  test("ftsSanitize keeps only terms the index can actually match", () => {
    // A term below the trigram floor cannot contribute precision — it can only zero the AND.
    expect(ftsSanitize("언어 설정으로")).toBe('"설정으로"');
    expect(ftsSanitize("회원가입 정책")).toBe('"회원가입"');
    expect(ftsSanitize("언어 세션")).toBe(""); // nothing matchable → caller falls back
    expect(ftsSanitize("native-epub Readium")).toBe('"native-epub" "Readium"'); // unchanged
  });
});
