// WikiIndex indexing / search / graph staleness.
// Builds a throwaway workspace; index DB lives in <workspace>/.llmwiki/index.db.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { WikiIndex, ftsSanitize, ftsRelax } from "../src/engine/db.ts";
import { updateReferences } from "../src/engine/refs.ts";

describe("WikiIndex", () => {
  let root: string;
  let wiki: string;
  let idx: WikiIndex;
  let conn: Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-db-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "a.md"), "# Alpha\n\n" + "alpha keyword content ".repeat(30));
    writeFileSync(join(wiki, "b.md"), "# Beta\n\nlinks [[a]] here\n\n" + "beta content ".repeat(30));
    idx = new WikiIndex(root);
    conn = idx.connect();
  });

  afterEach(() => {
    conn.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("index_all counts new", () => {
    const [neu, updated] = idx.indexAll(conn);
    expect(neu).toBe(2);
    expect(updated).toBe(0);
  });

  test("reindex unchanged skips", () => {
    idx.indexAll(conn);
    const [neu, updated] = idx.indexAll(conn);
    expect([neu, updated]).toEqual([0, 0]);
  });

  test("search fts match", () => {
    idx.indexAll(conn);
    const results = idx.search(conn, "keyword");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => String(r.relative_path).includes("a.md"))).toBe(true);
  });

  test("search tolerates FTS5 special chars (regression: hyphen no longer crashes)", () => {
    idx.indexAll(conn);
    // Raw "alpha-keyword" used to throw `SQLiteError: no such column: keyword`. Sanitized it
    // must not crash. (Under the trigram tokenizer, a hyphenated phrase only
    // matches literal "alpha-keyword" text, not the spaced "alpha keyword"; porter's
    // separator-splitting cross-match is gone by design. Spaced queries still match.)
    expect(() => idx.search(conn, "alpha-keyword")).not.toThrow();
    const r = idx.search(conn, "alpha keyword");
    expect(r.some((x) => String(x.relative_path).includes("a.md"))).toBe(true);
    // colon / boolean / NOT operators must not be parsed as syntax either.
    expect(() => idx.search(conn, "alpha: AND -beta NEAR(x)")).not.toThrow();
  });

  test("search empty / punctuation-only query returns [] (no invalid MATCH)", () => {
    idx.indexAll(conn);
    expect(idx.search(conn, "   ")).toEqual([]);
    expect(idx.search(conn, "--- :::")).toEqual([]);
  });

  test("ftsSanitize quotes word tokens and drops punctuation", () => {
    expect(ftsSanitize("native-epub Readium")).toBe('"native-epub" "Readium"');
    expect(ftsSanitize('say "hi"')).toBe('"say" """hi"""'); // embedded quote doubled
    expect(ftsSanitize("  --- ::: ")).toBe("");
    // Unicode word chars are kept, but "정책" is below the trigram floor: quoting it into the
    // implicit AND would empty the query instead of narrowing it. `search` answers the dropped
    // term by substring — see search-short-term.test.ts.
    expect(ftsSanitize("회원가입 정책")).toBe('"회원가입"');
  });

  test("change then reindex counts updated", () => {
    idx.indexAll(conn);
    writeFileSync(join(wiki, "b.md"), "# Beta\n\nlinks [[a]] here CHANGED\n\n" + "beta content ".repeat(30));
    const [neu, updated] = idx.indexAll(conn);
    expect(neu).toBe(0);
    expect(updated).toBe(1);
  });

  test("indexes derived frontmatter metadata without changing operational status", () => {
    // Given: a page whose knowledge lifecycle is distinct from index processing state.
    writeFileSync(
      join(wiki, "metadata.md"),
      [
        "---",
        "title: Derived metadata",
        "description: Derived descriptions are queryable.",
        "date: 2026-07-23",
        "tags: [index, typed]",
        "status: draft",
        "tier: hot",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );

    // When: the workspace is indexed.
    idx.indexAll(conn);
    const row = conn
      .query<
        {
          readonly description: string | null;
          readonly date: string | null;
          readonly tags: string;
          readonly status: string;
          readonly knowledge_status: string | null;
          readonly knowledge_tier: string | null;
        },
        []
      >(
        "SELECT description, date, tags, status, knowledge_status, knowledge_tier FROM documents WHERE relative_path='docs/wiki/metadata.md'",
      )
      .get();

    // Then: only derived columns carry page knowledge semantics.
    expect(row).toEqual({
      description: "Derived descriptions are queryable.",
      date: "2026-07-23",
      tags: '["index","typed"]',
      status: "ready",
      knowledge_status: "draft",
      knowledge_tier: "hot",
    });
  });

  test("repopulates stale derived metadata on every idempotent connection migration", () => {
    // Given: a previously indexed page whose derived columns are stale.
    writeFileSync(
      join(wiki, "stale.md"),
      [
        "---",
        "title: Stale derived metadata",
        "description: Idempotent metadata backfill.",
        "updated: 2026-07-24",
        "tags: [migration, idempotent]",
        "status: ready",
        "tier: warm",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    idx.indexAll(conn);
    conn.run(
      "UPDATE documents SET description=NULL, date=NULL, tags='[]', knowledge_status=NULL, knowledge_tier=NULL WHERE relative_path='docs/wiki/stale.md'",
    );
    conn.close();

    // When: the derived-state migration runs twice across independent connections.
    conn = idx.connect();
    const first = conn
      .query<
        {
          readonly description: string | null;
          readonly date: string | null;
          readonly tags: string;
          readonly knowledge_status: string | null;
          readonly knowledge_tier: string | null;
        },
        []
      >("SELECT description, date, tags, knowledge_status, knowledge_tier FROM documents WHERE relative_path='docs/wiki/stale.md'")
      .get();
    conn.close();
    conn = idx.connect();
    const second = conn
      .query<
        {
          readonly description: string | null;
          readonly date: string | null;
          readonly tags: string;
          readonly knowledge_status: string | null;
          readonly knowledge_tier: string | null;
        },
        []
      >("SELECT description, date, tags, knowledge_status, knowledge_tier FROM documents WHERE relative_path='docs/wiki/stale.md'")
      .get();

    // Then: both migrations converge on the same values without changing source bodies.
    expect(first).toEqual({
      description: "Idempotent metadata backfill.",
      date: "2026-07-24",
      tags: '["migration","idempotent"]',
      knowledge_status: "ready",
      knowledge_tier: "warm",
    });
    expect(second).toEqual(first);
  });

  test("adds derived metadata columns to a legacy index before backfilling its rows", () => {
    // Given: an index created before the derived metadata columns existed.
    conn.exec("ALTER TABLE documents DROP COLUMN description");
    conn.exec("ALTER TABLE documents DROP COLUMN knowledge_status");
    conn.exec("ALTER TABLE documents DROP COLUMN knowledge_tier");
    conn.run(
      "INSERT INTO documents (id, filename, title, path, relative_path, source_kind, file_type, status, content, tags, version, document_number) " +
        "VALUES ('legacy-page', 'legacy.md', 'Legacy', '/docs/wiki/', 'docs/wiki/legacy.md', 'wiki', 'md', 'ready', ?, '[]', 1, 100)",
      [
        [
          "---",
          "title: Legacy page",
          "description: Legacy metadata backfill.",
          "date: 2026-07-25",
          "tags: [legacy, migration]",
          "status: superseded",
          "tier: protected",
          "---",
          "",
          "Body.",
        ].join("\n"),
      ],
    );
    conn.close();

    // When: a current index connection runs the idempotent migration.
    conn = idx.connect();
    const row = conn
      .query<
        {
          readonly description: string | null;
          readonly date: string | null;
          readonly tags: string;
          readonly knowledge_status: string | null;
          readonly knowledge_tier: string | null;
        },
        []
      >("SELECT description, date, tags, knowledge_status, knowledge_tier FROM documents WHERE id='legacy-page'")
      .get();

    // Then: the schema and stale row converge without altering operational status.
    expect(row).toEqual({
      description: "Legacy metadata backfill.",
      date: "2026-07-25",
      tags: '["legacy","migration"]',
      knowledge_status: "superseded",
      knowledge_tier: "protected",
    });
  });

  test("links_to edge and staleness propagation", () => {
    idx.indexAll(conn);
    const docs = idx.listDocuments(conn);
    const bdoc = docs.find((d) => d.filename === "b.md")!;

    const [, links] = updateReferences(idx, conn, bdoc as any, readFileSync(join(wiki, "b.md"), "utf-8"));
    expect(links).toBe(1);
    const forward = idx.getForwardReferences(conn, String(bdoc.id));
    expect(forward.some((r) => r.filename === "a.md" && r.reference_type === "links_to")).toBe(true);

    // Touch a.md → propagateStaleness (inside indexFile) marks b.md stale.
    writeFileSync(join(wiki, "a.md"), "# Alpha\n\n" + "alpha keyword content ".repeat(30) + " MORE");
    idx.indexAll(conn);
    const stale = idx.findStalePages(conn);
    expect(stale.some((s) => s.filename === "b.md")).toBe(true);
  });
});

// per-file content cap for SOURCE files (large data fixtures are
// registered metadata-only; wiki pages exempt; growing past the cap drops stale chunks).
describe("SOURCE_CONTENT_CAP", () => {
  let root: string;
  let idx: WikiIndex;
  const big = () => "key: value-아주긴데이터 ".repeat(Math.ceil((WikiIndex.SOURCE_CONTENT_CAP + 4096) / 30));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-cap-"));
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    idx = new WikiIndex(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("oversized source file → metadata-only (no content, no chunks); small one stays searchable", () => {
    writeFileSync(join(root, "fixture.yaml"), big());
    writeFileSync(join(root, "ci.yaml"), "workflow: build-and-test unique-marker-token\n".repeat(40));
    const conn = idx.connect();
    idx.indexAll(conn);
    const rows = conn
      .query("SELECT relative_path, content IS NULL AS nocontent FROM documents WHERE source_kind='source'")
      .all() as any[];
    const fix = rows.find((r) => r.relative_path === "fixture.yaml");
    expect(fix).toBeTruthy(); // still registered → findable by name/path
    expect(fix.nocontent).toBe(1);
    const nChunks = (conn.query(
      "SELECT count(*) n FROM document_chunks dc JOIN documents d ON dc.document_id=d.id WHERE d.relative_path='fixture.yaml'",
    ).get() as any).n;
    expect(nChunks).toBe(0);
    expect(idx.search(conn, "unique-marker-token").length).toBeGreaterThan(0); // small file indexed
    conn.close();
  });

  test("wiki pages are exempt from the cap", () => {
    writeFileSync(join(root, "docs", "wiki", "huge.md"), "# T\n\n" + big());
    const conn = idx.connect();
    idx.indexAll(conn);
    const n = (conn.query(
      "SELECT count(*) n FROM document_chunks dc JOIN documents d ON dc.document_id=d.id WHERE d.relative_path LIKE 'docs/wiki/%'",
    ).get() as any).n;
    expect(n).toBeGreaterThan(0);
    conn.close();
  });

  test("file growing past the cap drops its stale chunks", () => {
    const p = join(root, "data.yaml");
    writeFileSync(p, "small: stale-body-marker\n".repeat(40));
    const conn = idx.connect();
    idx.indexAll(conn);
    expect(idx.search(conn, "stale-body-marker").length).toBeGreaterThan(0);
    writeFileSync(p, big());
    idx.indexAll(conn);
    expect(idx.search(conn, "stale-body-marker").length).toBe(0); // old body no longer served
    conn.close();
  });
});

// P0-3: relaxed-recall fallback (AND→OR retry) + P0-4: superseded down-rank.
describe("search relaxation + superseded down-rank", () => {
  let root: string;
  let idx: WikiIndex;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-relax-"));
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    idx = new WikiIndex(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("ftsRelax gating", () => {
    expect(ftsRelax("캡처 데몬 재시작")).toBe('"캡처" OR "데몬" OR "재시작"'); // CJK relaxes (unicode tokens)
    expect(ftsRelax("alpha bravo")).toBe('"alpha" OR "bravo"');
    expect(ftsRelax("alpha")).toBeNull(); // <2 tokens
    expect(ftsRelax('"exact phrase" here')).toBeNull(); // quoted → exact intent
    expect(ftsRelax("alpha AND bravo")).toBeNull(); // explicit boolean
    expect(ftsRelax("SPEC 16")).toBeNull(); // numeric token → ID-ish, no relax
    expect(ftsRelax("")).toBeNull();
  });

  test("strict miss falls back to OR relax and finds partial match", () => {
    // NB: terms must be ≥3 chars (trigram floor) — "데몬" alone can never match.
    writeFileSync(join(root, "docs", "wiki", "daemon.md"), "# T\n\n캡처데몬 프로세스 관련내용 ".repeat(20));
    const conn = idx.connect();
    idx.indexAll(conn);
    // strict AND of both terms misses (no page has 존재하지않는단어), relax finds 캡처데몬 page
    const rows = idx.search(conn, "캡처데몬 존재하지않는단어");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.relative_path).toBe("docs/wiki/daemon.md");
    conn.close();
  });

  test("raw queries never relax", () => {
    writeFileSync(join(root, "docs", "wiki", "daemon.md"), "# T\n\n캡처 데몬 관련 내용 ".repeat(20));
    const conn = idx.connect();
    idx.indexAll(conn);
    const rows = idx.search(conn, '"데몬" "존재하지않는단어"', 10, null, true);
    expect(rows.length).toBe(0);
    conn.close();
  });

  test("fts syntax error degrades to empty, not a crash", () => {
    const conn = idx.connect();
    idx.indexAll(conn);
    expect(idx.search(conn, 'broken(query"', 10, null, true)).toEqual([]);
    conn.close();
  });

  test("superseded frontmatter pages rank after live pages", () => {
    const fm = (status: string) =>
      `---\ntitle: t\nstatus: ${status}\n---\n\n판정규칙 공통내용 ` + "판정규칙 상세 ".repeat(30);
    writeFileSync(join(root, "docs", "wiki", "old-decision.md"), fm("superseded"));
    writeFileSync(join(root, "docs", "wiki", "live-decision.md"), fm("ready"));
    const conn = idx.connect();
    idx.indexAll(conn);
    const rows = idx.search(conn, "판정규칙");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.relative_path).toBe("docs/wiki/live-decision.md"); // live first
    const paths = rows.map((r: any) => r.relative_path);
    expect(paths).toContain("docs/wiki/old-decision.md"); // demoted, not filtered
    conn.close();
  });

  test("body mentioning the phrase is NOT demoted (frontmatter-only check)", () => {
    // explainer is status:ready but its BODY mentions the phrase early (within the first
    // 400 chars) — under a naive prefix-LIKE it would be falsely demoted below weaker.md.
    const explainer =
      `---\ntitle: t\nstatus: ready\n---\n\n본문에서 status: superseded 처리를 설명한다. ` +
      "공통검색어 상세 설명 ".repeat(30);
    const weaker =
      `---\ntitle: w\nstatus: ready\n---\n\n다른 주제. 공통검색어 한 번만. ` + "무관한 채움 문장 ".repeat(40);
    writeFileSync(join(root, "docs", "wiki", "explainer.md"), explainer);
    writeFileSync(join(root, "docs", "wiki", "weaker.md"), weaker);
    const conn = idx.connect();
    idx.indexAll(conn);
    const rows = idx.search(conn, "공통검색어");
    expect(rows.length).toBeGreaterThan(1);
    // explainer matches far more strongly — if it were demoted, weaker.md would lead
    expect(rows[0]!.relative_path).toBe("docs/wiki/explainer.md");
    conn.close();
  });
});
