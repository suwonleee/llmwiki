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
    expect(ftsSanitize("회원가입 정책")).toBe('"회원가입" "정책"'); // unicode word chars kept
  });

  test("change then reindex counts updated", () => {
    idx.indexAll(conn);
    writeFileSync(join(wiki, "b.md"), "# Beta\n\nlinks [[a]] here CHANGED\n\n" + "beta content ".repeat(30));
    const [neu, updated] = idx.indexAll(conn);
    expect(neu).toBe(0);
    expect(updated).toBe(1);
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
