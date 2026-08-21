// turn-context: deterministic per-turn read-injection — term extraction,
// FTS-query safety, precision gate, CJK matching on the trigram index, session dedup,
// and the porter→trigram migration of pre-existing index DBs.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext, displayRoot, extractTerms, ftsQuery } from "../src/engine/turncontext.ts";

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

  test("the banner names the clone its relative pointers belong to", () => {
    const out = buildTurnContext(root, "캡처 데몬이 트랜스크립트 큐를 놓치는 것 같은데 확인해줘");
    const head = out.split("\n")[0]!;
    expect(head).toContain("[llmwiki turn-context]");
    expect(head).toContain(displayRoot(root)); // two clones can share a basename; the path cannot
    // The pointer lines stay repo-relative — the root is stated once, not repeated per line.
    for (const line of out.split("\n").slice(1)) expect(line).toContain("  →  docs/wiki/");
  });

  test("displayRoot collapses home and leaves other paths alone", () => {
    expect(displayRoot(join(homedir(), "clone"))).toBe("~/clone");
    expect(displayRoot(homedir())).toBe("~");
    expect(displayRoot("/opt/elsewhere")).toBe("/opt/elsewhere");
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

describe("josa strip + identity witness (2026-08-04 retrieval quality pass)", () => {
  let root: string;
  let wiki: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-idw-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(join(wiki, "5_topic"), { recursive: true });
    mkdirSync(join(wiki, "3_decision"), { recursive: true });
    // Hub page: the title names the topic; the BODY never repeats it unspaced.
    writeFileSync(
      join(wiki, "5_topic", "문서-허브.md"),
      "---\ntitle: Q-INDEX 문서 허브 — 검색 품질 장치\ndescription: 문서 검색의 정체성 게이트\n---\n" +
        "검색 후보의 스코프 감사와 본문 검증을 다룬다. 인용 대조는 결정적이다. ".repeat(10),
    );
    // Mention page: body repeats the topic words; must not beat the hub via filler terms.
    writeFileSync(
      join(wiki, "3_decision", "토큰회전-결정.md"),
      "---\ntitle: 회의 토큰회전 운영 결정\ndescription: 만료 토큰 교체 기준\n---\n" +
        "토큰회전 비용과 운영 위험을 비교했다. 배치 산출물은 교체 기준을 유지한다. ".repeat(10),
    );
    new WikiIndex(root).indexAll();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("stripJosa: one nominal particle layer, original kept, verbs untouched", () => {
    const terms = extractTerms("배포안을 검토하자");
    expect(terms).toContain("배포안을"); // original survives — exact matches never lost
    expect(terms).toContain("배포안"); // stripped variant added
    expect(terms).not.toContain("검토하"); // 하자 is a verb ending, not a josa — untouched
  });

  test("josa-carrying prompt reaches the page that spells the bare noun", () => {
    const out = buildTurnContext(root, "토큰회전을 미루면 어떻게 되지");
    expect(out).toContain("토큰회전-결정.md");
  });

  test("spacing variant reaches the hub through the despaced identity", () => {
    // Prompt says 문서허브 (unspaced); title says 문서 허브; body never says either unspaced.
    const out = buildTurnContext(root, "문서허브를 손보자");
    expect(out).toContain("문서-허브.md");
  });

  test("a 2-char identity word alone cannot clear the gate (filler stays silent)", () => {
    const out = buildTurnContext(root, "내일 회의 몇 시더라");
    expect(out).toBe(""); // 회의(2자) sits in a title, but identity promotion needs ≥3 dense chars
  });
});

// A pointer's stated reason. Showing every matched term was tried and discarded: the score gate
// already requires each pointer to match the prompt, so all three printed the same list and the
// "reason" asserted an equal relevance the engine never established. Only IDENTITY terms — a
// prompt word in the page's title/description — differ between pointers, so only those are shown.
describe("pointer reason", () => {
  // Rendered per repo language; pinned here so the suite does not depend on ambient LLMWIKI_LANG.
  const LABEL = /(제목|titled):/;
  let root: string;
  let wiki: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-why-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(join(wiki, "5_topic"), { recursive: true });
    mkdirSync(join(wiki, "2_milestone"), { recursive: true });
    // hub: the prompt's words are in the TITLE
    writeFileSync(
      join(wiki, "5_topic", "quality-loop.md"),
      "---\ntitle: 품질 루프 — 생성 후 검수\n---\n" +
        "품질 루프는 생성 직후 결정적 검수를 돌리고 표적 보강을 수행한다. 트랜스크립트 기준. ".repeat(10),
    );
    // mention-only: the same words appear in the BODY, never in the title
    writeFileSync(
      join(wiki, "2_milestone", "unrelated-run.md"),
      "---\ntitle: 오케스트레이터 철거 실측\n---\n" +
        "철거 과정에서 품질 루프 검수 절차를 그대로 두었다. 트랜스크립트 큐도 유지. ".repeat(10),
    );
    new WikiIndex(root).indexAll();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a title match states its reason; a body-only match stays silent", () => {
    const out = buildTurnContext(root, "품질 루프 검수 절차를 확인하고 싶다");
    const hub = out.split("\n").find((l) => l.includes("quality-loop.md")) ?? "";
    const mention = out.split("\n").find((l) => l.includes("unrelated-run.md")) ?? "";

    // the label is bilingual (제목 / titled) and another suite may have pinned LLMWIKI_LANG —
    // assert the CONTRACT, not the ambient language
    expect(hub).toMatch(LABEL);
    expect(hub).toMatch(/품질|루프/);
    // the discriminating half: a page that only MENTIONS the words claims no reason
    expect(mention).not.toMatch(LABEL);
  });

  test("two-character Korean terms reach the reason even though they cannot promote the score", () => {
    // 품질·루프·검수 are 2 chars each — below the identity-promotion floor that protects scoring
    // from everyday vocabulary. Stating that a word is in the title is a fact about the title,
    // not a relevance claim, so the reason carries no such floor.
    const out = buildTurnContext(root, "품질 루프 검수 절차를 확인하고 싶다");
    const hub = out.split("\n").find((l) => l.includes("quality-loop.md")) ?? "";
    expect(hub).toMatch(new RegExp(`${LABEL.source}\\s*.*(품질|루프)`));
  });

  test("one concept spelled two ways is one reason, not two slots", () => {
    // "L-GATE" and "GATE" both match a title that holds L-GATE; the shorter is a substring of the
    // longer and must not spend a second slot restating it.
    mkdirSync(join(wiki, "3_decision"), { recursive: true });
    writeFileSync(
      join(wiki, "3_decision", "lgate.md"),
      "---\ntitle: L-GATE 접지 게이트 계약\n---\n" +
        "L-GATE 는 출력측 신뢰 장치다. 스코프 감사와 본문 검증 두 단계로 나뉜다. ".repeat(10),
    );
    new WikiIndex(root).indexAll();
    const line = buildTurnContext(root, "L-GATE 접지 게이트 계약이 뭐였지")
      .split("\n")
      .find((l) => l.includes("lgate.md")) ?? "";
    expect(line).toContain("L-GATE");
    // GATE is a substring of L-GATE — it must not appear as its own listed reason
    expect(line).not.toMatch(new RegExp(`${LABEL.source}[^)]*·GATE`, "i"));
  });
});
