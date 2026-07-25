import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";

const COLD_INDEX = join("docs", "wiki", "cold-index.md");

function coldPage(tier: "cold" | "warm", body: string): string {
  return [
    "---",
    "title: Archived retrieval policy",
    "description: metadatahit discovery record",
    "date: 2025-01-02",
    "tags: [archive, metadatahit]",
    "keywords: [keywordmetadatamarker]",
    "status: ready",
    `tier: ${tier}`,
    "---",
    "",
    body,
    "",
    "# Headinglabelmarker Section",
    "",
    "[[linklabelmarker]]",
  ].join("\n");
}

describe("cold wiki retrieval", () => {
  test("finds an explicit frontmatter keyword without indexing body prose", () => {
    // Given: a cold page with a declared keyword discovery field.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-keywords-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    writeFileSync(page, coldPage("cold", "unsearchable body prose"));
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      // When / Then: the declared keyword locates the original page.
      index.indexAll(db);
      expect(index.search(db, "keywordmetadatamarker", 10, "wiki").map((row) => row.relative_path)).toContain(
        "docs/wiki/4_insight/archive.md",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds a markdown heading label without indexing body prose", () => {
    // Given: a cold page with a structural heading label.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-heading-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    writeFileSync(page, coldPage("cold", "unsearchable body prose"));
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      // When / Then: the heading label locates the original page.
      index.indexAll(db);
      expect(index.search(db, "headinglabelmarker", 10, "wiki").map((row) => row.relative_path)).toContain(
        "docs/wiki/4_insight/archive.md",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds a wikilink target without indexing body prose", () => {
    // Given: a cold page with a structural wikilink target.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-wikilink-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    writeFileSync(page, coldPage("cold", "unsearchable body prose"));
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      // When / Then: the wikilink target locates the original page.
      index.indexAll(db);
      expect(index.search(db, "linklabelmarker", 10, "wiki").map((row) => row.relative_path)).toContain(
        "docs/wiki/4_insight/archive.md",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("indexes discovery metadata without storing or searching the cold body", () => {
    // Given: a cold page with a term found nowhere in its metadata.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    const original = coldPage("cold", "bodyonlymarker ".repeat(200));
    writeFileSync(page, original);
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      // When: the page is indexed.
      index.indexAll(db);

      // Then: its source bytes remain canonical, while FTS exposes metadata at the source path only.
      expect(readFileSync(page, "utf-8")).toBe(original);
      expect(index.search(db, "bodyonlymarker", 10, "wiki")).toEqual([]);
      expect(index.search(db, "metadatahit", 10, "wiki").map((row) => row.relative_path)).toContain(
        "docs/wiki/4_insight/archive.md",
      );
      expect(
        db.query("SELECT content IS NULL AS missing_content FROM documents WHERE relative_path='docs/wiki/4_insight/archive.md'").get(),
      ).toEqual({ missing_content: 1 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hydrates a cold body from disk and makes a missing source visible", () => {
    // Given: a cold page that is stored metadata-only in the derived index.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-hydrate-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    const original = coldPage("cold", "hydrated body text");
    writeFileSync(page, original);
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      index.indexAll(db);

      // When: a direct content consumer requests the indexed documents.
      const hydrated = index.listDocumentsWithContent(db).find((row) => row.relative_path === "docs/wiki/4_insight/archive.md");

      // Then: it receives the disk body, not an index copy.
      expect(hydrated?.content).toBe(original);

      // When: the source disappears after indexing.
      unlinkSync(page);

      // Then: consumers receive a visible failure instead of silently linting an empty body.
      expect(() => index.listDocumentsWithContent(db)).toThrow("cold wiki page body missing");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restores body indexing when a cold page becomes warm", () => {
    // Given: a cold page whose body is absent from the active FTS index.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-warm-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    writeFileSync(page, coldPage("cold", "warmrestoremarker ".repeat(200)));
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      index.indexAll(db);
      expect(index.search(db, "warmrestoremarker", 10, "wiki")).toEqual([]);

      // When: lifecycle policy changes the page back to warm.
      writeFileSync(page, coldPage("warm", "warmrestoremarker ".repeat(200)));
      index.indexAll(db);

      // Then: the same source body is indexed again.
      expect(index.search(db, "warmrestoremarker", 10, "wiki").map((row) => row.relative_path)).toContain(
        "docs/wiki/4_insight/archive.md",
      );
      expect(
        db.query("SELECT content IS NULL AS missing_content FROM documents WHERE relative_path='docs/wiki/4_insight/archive.md'").get(),
      ).toEqual({ missing_content: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes a deterministic registry that turn-context never suggests", () => {
    // Given: a cold page discoverable by its metadata.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-registry-"));
    const page = join(root, "docs", "wiki", "4_insight", "archive.md");
    mkdirSync(join(root, "docs", "wiki", "4_insight"), { recursive: true });
    writeFileSync(page, coldPage("cold", "unrelated cold body ".repeat(200)));
    const index = new WikiIndex(root);

    try {
      // When: index maintenance generates the cold discovery registry.
      index.indexAll();
      const registry = readFileSync(join(root, COLD_INDEX), "utf-8");

      // Then: it is deterministic discovery output, but turn-context points at the real page only.
      expect(registry).toContain("docs/wiki/4_insight/archive.md");
      const context = buildTurnContext(root, "metadatahit discovery record");
      expect(context).toContain("archive.md");
      expect(context).not.toContain("cold-index.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds cold FTS storage by metadata rather than body size", () => {
    // Given: two cold pages with identical metadata but radically different bodies.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cold-size-"));
    const wiki = join(root, "docs", "wiki", "4_insight");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "short.md"), coldPage("cold", "smallbody ".repeat(100)));
    writeFileSync(join(wiki, "large.md"), coldPage("cold", "largerbody ".repeat(20_000)));
    const index = new WikiIndex(root);
    const db = index.connect();

    try {
      // When: both pages are indexed.
      index.indexAll(db);

      // Then: FTS stores bounded discovery metadata, never the large Markdown body.
      const row = db.query<{ readonly indexed_bytes: number }, []>(
        "SELECT COALESCE(SUM(length(dc.content)), 0) AS indexed_bytes " +
          "FROM document_chunks dc JOIN documents d ON d.id=dc.document_id WHERE d.knowledge_tier='cold'",
      ).get();
      expect(row?.indexed_bytes ?? 0).toBeLessThan(4_000);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
