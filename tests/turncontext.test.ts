// turn-context: deterministic per-turn read-injection — term extraction,
// FTS-query safety, precision gate, CJK matching on the trigram index, session dedup,
// and the porter→trigram migration of pre-existing index DBs.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext, extractTerms, ftsQuery } from "../src/engine/turncontext.ts";

describe("extractTerms / ftsQuery", () => {
  test("ascii identifiers, paths, and CJK runs; short noise dropped", () => {
    const terms = extractTerms("fix the bug in src/engine/db.ts — 캡처 데몬이 watch.ts 를 못 봄, 索引更新失败");
    expect(terms).toContain("src/engine/db.ts");
    expect(terms).toContain("watch.ts");
    expect(terms).toContain("데몬이");
    // An unspaced run comes out as word-sized windows, not one clause: "索引更新失败" as a
    // literal substring only matches a page that wrote those six characters in a row.
    expect(terms).toContain("索引更新");
    expect(terms).toContain("更新失败");
    expect(terms).not.toContain("캡처"); // 2-char CJK — below the trigram matching floor
    expect(terms).not.toContain("the"); // <4 ascii
    expect(terms).not.toContain("bug");
    expect(terms).not.toContain("봄"); // <3 CJK (trigram floor)
  });

  test("dedupes case-insensitively and caps at 12 most-specific", () => {
    const many = Array.from({ length: 30 }, (_, i) => `identifier_${i}_${"x".repeat(i)}`).join(" ");
    const terms = extractTerms(many + " Alpha ALPHA alpha");
    expect(terms.length).toBeLessThanOrEqual(12);
    expect(terms.filter((t) => t.toLowerCase() === "alpha").length).toBeLessThanOrEqual(1);
  });

  test("ftsQuery quotes every term so raw prompt syntax can never hit the MATCH parser", () => {
    const q = ftsQuery(['weird"term', "간단한(질문)"]);
    expect(q).toBe('"weird""term" OR "간단한(질문)"');
  });
});

describe("buildTurnContext", () => {
  let root: string;
  let wiki: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-tc-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(join(wiki, "3_decision"), { recursive: true });
    mkdirSync(join(wiki, "2_milestone"), { recursive: true });
    mkdirSync(join(wiki, "4_insight"), { recursive: true });
    // bodies repeated past MIN_CHUNK_TOKENS (32) — pages below the chunker floor are not
    // FTS-searchable by design (real condensed pages are always longer).
    writeFileSync(
      join(wiki, "3_decision", "capture-daemon.md"),
      "---\ntitle: 캡처 데몬 결정\n---\n" +
        "캡처 데몬(watch.ts)은 launchd 로 상주한다. 트랜스크립트 큐는 capture.db 에 쌓인다. ".repeat(10),
    );
    writeFileSync(
      join(wiki, "2_milestone", "fts-port.md"),
      "---\ntitle: FTS Port\n---\n" +
        "Ported chunker and search to bun sqlite fts5 trigram tokenizer for the index. ".repeat(10),
    );
    writeFileSync(
      join(wiki, "overview.md"),
      "---\ntitle: Overview\n---\n" + "캡처 데몬 watch.ts 트랜스크립트 overview page. ".repeat(10),
    );
    new WikiIndex(root).indexAll();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("korean prompt matches korean page; L0 pages excluded; pointers only", () => {
    const out = buildTurnContext(root, "캡처 데몬이 트랜스크립트 큐를 놓치는 것 같은데 확인해줘");
    expect(out).toContain("capture-daemon.md");
    expect(out).not.toContain("overview.md"); // L0 never re-suggested
    expect(out).not.toContain("launchd 로 상주"); // no body injection
  });

  test("english/identifier prompt matches english page", () => {
    const out = buildTurnContext(root, "why does the trigram tokenizer change affect chunker output?");
    expect(out).toContain("fts-port.md");
  });

  test("a prompt made only of two-character Hangul words still retrieves", () => {
    // The trigram index cannot represent a 2-character term, so these never reach MATCH — and in
    // Korean they are the ordinary technical words (캡처·큐), not the exotic ones. Before the
    // sub-floor pass this prompt was silent, which is the compounding loop failing on exactly the
    // question it exists to answer. Measured on this engine's own wiki: 1/7 → 5/7 relevant prompts.
    const out = buildTurnContext(root, "캡처 큐 상주");
    expect(out).toContain("capture-daemon.md");
  });

  test("…and a prompt of only grammatical filler stays silent", () => {
    // The recall above must not become "any Korean sentence matches something".
    expect(buildTurnContext(root, "이거 그거 저거")).toBe("");
  });

  test("cold discovery metadata points at the original page without surfacing its body", () => {
    // Given: a cold page with distinct metadata and body terms.
    writeFileSync(
      join(wiki, "4_insight", "cold-archive.md"),
      [
        "---",
        "title: Cold archive",
        "description: metadatahit discovery record",
        "date: 2025-01-02",
        "tags: [archive, metadatahit]",
        "status: ready",
        "tier: cold",
        "---",
        "",
        "bodyonlymarker ".repeat(200),
      ].join("\n"),
    );
    new WikiIndex(root).indexAll();

    // When / Then: metadata discovers the original page, while body-only terms stay silent.
    expect(buildTurnContext(root, "metadatahit discovery record")).toContain("cold-archive.md");
    expect(buildTurnContext(root, "bodyonlymarker")).toBe("");
  });

  test("silent on unrelated prompt and on hostile FTS syntax", () => {
    expect(buildTurnContext(root, "완전히 무관한 요리 레시피 이야기")).toBe("");
    expect(buildTurnContext(root, 'weird "quotes" AND (parens) NEAR/3 stuff*')).toBe("");
  });

  test("silent when repo has no index", () => {
    const empty = mkdtempSync(join(tmpdir(), "llmwiki-tc-empty-"));
    try {
      expect(buildTurnContext(empty, "캡처 데몬 트랜스크립트")).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("session dedup: same page not suggested twice in one session", () => {
    const sid = `test-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const first = buildTurnContext(root, "캡처 데몬 트랜스크립트 큐", sid);
    expect(first).toContain("capture-daemon.md");
    const second = buildTurnContext(root, "캡처 데몬 트랜스크립트 큐", sid);
    expect(second).toBe("");
    // a different session still gets the pointer
    const other = buildTurnContext(root, "캡처 데몬 트랜스크립트 큐", sid + "-other");
    expect(other).toContain("capture-daemon.md");
  });
});

describe("porter→trigram FTS migration", () => {
  test("old-tokenizer DB is rebuilt in place and CJK search works after", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-mig-"));
    try {
      const wiki = join(root, "docs", "wiki");
      mkdirSync(join(wiki, "4_insight"), { recursive: true });
      writeFileSync(
        join(wiki, "4_insight", "kr.md"),
        "---\ntitle: 한글 페이지\n---\n" + "증분추출 워터마크 로직 정리와 오프셋 관리 방법. ".repeat(10),
      );

      // 1) index with the CURRENT engine, then hand-rewrite chunks_fts back to the OLD tokenizer
      const idx = new WikiIndex(root);
      idx.indexAll();
      let db = new Database(idx.dbPath);
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_delete");
      db.exec("DROP TRIGGER IF EXISTS chunks_fts_update");
      db.exec("DROP TABLE chunks_fts");
      db.exec(
        "CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='document_chunks', " +
          "content_rowid='rowid', tokenize='porter unicode61')",
      );
      db.exec("INSERT INTO chunks_fts(rowid, content) SELECT rowid, content FROM document_chunks");
      db.close();

      // 2) connect() must detect + migrate; CJK substring search must now hit
      const conn = idx.connect();
      const sql = (
        conn.query("SELECT sql FROM sqlite_master WHERE name='chunks_fts'").get() as { sql: string }
      ).sql;
      expect(sql).toContain("trigram");
      const rows = idx.search(conn, "워터마크", 10, "wiki"); // ftsSanitize quotes it → trigram phrase
      expect(rows.length).toBeGreaterThan(0);
      conn.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// P1 HQE-lite — deterministic recency-decay term carry-over (no LLM/embedding).
import { accumulate } from "../src/engine/turncontext.ts";

describe("HQE-lite accumulate", () => {
  test("prior terms decay ×0.5 and age out below 0.25", () => {
    const t1 = accumulate({}, ["트랜스크립트", "데몬"]);
    expect(t1.merged["트랜스크립트"]).toBe(1);
    const t2 = accumulate(t1.merged, ["다른주제"]);
    expect(t2.merged["트랜스크립트"]).toBe(0.5);
    const t3 = accumulate(t2.merged, ["다른주제"]);
    expect(t3.merged["트랜스크립트"]).toBe(0.25);
    const t4 = accumulate(t3.merged, ["다른주제"]);
    expect(t4.merged["트랜스크립트"]).toBeUndefined(); // 0.125 < floor → aged out
  });

  test("carried excludes current-prompt terms and caps at 4 by weight", () => {
    const prior = { a1234: 1, b1234: 0.9, c1234: 0.8, d1234: 0.7, e1234: 0.6, 현재용어: 1 };
    const { carried } = accumulate(prior, ["현재용어"]);
    expect(carried).not.toContain("현재용어");
    expect(carried.length).toBe(4);
    expect(carried[0]).toBe("a1234"); // weight desc
  });

  test("store is capped and current terms always weigh 1", () => {
    const prior: Record<string, number> = {};
    for (let i = 0; i < 40; i++) prior[`term${String(i).padStart(2, "0")}`] = 1;
    const { merged } = accumulate(prior, ["새용어"]);
    expect(Object.keys(merged).length).toBeLessThanOrEqual(24);
    expect(merged["새용어"]).toBe(1);
  });
});
