// Citation/link parsing.
// Tests assert the *current* behavior of the engine; do not change the engine.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCitationFilename, stripCode, parseWikiLinks, autoRegisterCitedTranscripts, rebuildReferenceGraph, referenceGraphCounts } from "../src/engine/refs.ts";
import { WikiIndex } from "../src/engine/db.ts";

describe("autoRegisterCitedTranscripts (durable provenance self-heal)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-heal-"));
    mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("registers a cited (rotated) .jsonl transcript, ignores code-path citations", () => {
    const page =
      "---\ntitle: t\ndescription: d\ndate: 2026-06-20\ntags: [a,b]\nstatus: ready\n---\n\n" +
      "the user chose X[^1]; module Y does Z[^2].\n\n" +
      "[^1]: 3757c3c6-c56b-4dee-8773-4dd5bc79bb85.jsonl\n[^2]: src/app/thing.py\n";
    writeFileSync(join(root, "docs", "wiki", "3_decision", "d.md"), page);
    const w = new WikiIndex(root);
    w.indexAll();

    const n = autoRegisterCitedTranscripts(w);
    expect(n).toBe(1); // only the .jsonl, never the code path

    const conn = w.connect();
    const kinds = conn
      .query("SELECT filename, source_kind FROM documents WHERE source_kind = 'transcript'")
      .all() as { filename: string }[];
    conn.close();
    expect(kinds.map((k) => k.filename)).toContain("3757c3c6-c56b-4dee-8773-4dd5bc79bb85.jsonl");
  });

  test("idempotent — second run registers nothing new", () => {
    const page =
      "---\ntitle: t\ndescription: d\ndate: 2026-06-20\ntags: [a,b]\nstatus: ready\n---\n\nx[^1]\n\n[^1]: abc12345-0000-0000-0000-000000000000.jsonl\n";
    writeFileSync(join(root, "docs", "wiki", "3_decision", "d.md"), page);
    const w = new WikiIndex(root);
    w.indexAll();
    expect(autoRegisterCitedTranscripts(w)).toBe(1);
    expect(autoRegisterCitedTranscripts(w)).toBe(0); // already registered
  });

  test("hydrates a cold metadata-only page before repairing transcript provenance", () => {
    // Given: a cold page whose citation body is absent from SQLite storage.
    const page = [
      "---",
      "title: Cold citation",
      "description: Citation metadata",
      "date: 2025-01-02",
      "tags: [cold, citation]",
      "status: ready",
      "tier: cold",
      "---",
      "",
      "citation survives hydration[^1]",
      "",
      "[^1]: cold-session.jsonl",
    ].join("\n");
    writeFileSync(join(root, "docs", "wiki", "3_decision", "cold.md"), page);
    const w = new WikiIndex(root);
    w.indexAll();
    const conn = w.connect();

    try {
      expect(
        conn.query("SELECT content IS NULL AS missing_content FROM documents WHERE relative_path='docs/wiki/3_decision/cold.md'").get(),
      ).toEqual({ missing_content: 1 });
      expect(
        w.listDocumentsWithContent(conn).find((document) => document.relative_path === "docs/wiki/3_decision/cold.md")?.content,
      ).toContain("cold-session.jsonl");

      // When / Then: refs reads the on-disk body and registers its cited transcript.
      expect(autoRegisterCitedTranscripts(w)).toBe(1);
    } finally {
      conn.close();
    }
  });
});

describe("parseCitationFilename", () => {
  test("plain", () => {
    expect(parseCitationFilename("f.pdf")).toEqual(["f.pdf", null]);
  });

  test("with page", () => {
    expect(parseCitationFilename("f.pdf, p.3")).toEqual(["f.pdf", 3]);
  });

  test("markdown link with page", () => {
    expect(parseCitationFilename("[a.md](x), p.5")).toEqual(["a.md", 5]);
  });

  test("dash description stripped", () => {
    expect(parseCitationFilename("foo.md — desc")).toEqual(["foo.md", null]);
  });

  // `path:line` tolerance — the universal convention warm sessions keep producing.
  // Rejecting it caused a lint→rework loop every close-out (observed 2026-07-21 in a
  // real project close-out); the line number is absorbed into the same
  // locator slot `, p.N` already uses. Canonical format stays the bare path.
  test("code path with :line absorbed", () => {
    expect(parseCitationFilename("src/engine/refs.ts:79")).toEqual(["src/engine/refs.ts", 79]);
  });

  test("code path with :line range absorbed (start line kept)", () => {
    expect(parseCitationFilename("src/engine/lint.ts:464-476")).toEqual(["src/engine/lint.ts", 464]);
  });

  test("extension-only filename with :line absorbed", () => {
    expect(parseCitationFilename("cli.ts:12")).toEqual(["cli.ts", 12]);
  });

  test("non-path colon suffix NOT stripped (unresolved reports what was written)", () => {
    expect(parseCitationFilename("12:30")).toEqual(["12:30", null]);
  });

  test("transcript filename untouched", () => {
    expect(parseCitationFilename("5f2e7479-5ef3-407b-b9c7-2f4c3ca0287e.jsonl")).toEqual([
      "5f2e7479-5ef3-407b-b9c7-2f4c3ca0287e.jsonl",
      null,
    ]);
  });

  test("document-type target with :N NOT stripped (bare-.jsonl$ consumers must agree)", () => {
    // autoRegisterCitedTranscripts/ensureExcerpts anchor on bare `.jsonl$` — stripping here
    // would make `x.jsonl:12` resolve in the parser but dangle there. Intact = one visible error.
    expect(parseCitationFilename("abc.jsonl:12")).toEqual(["abc.jsonl:12", null]);
    expect(parseCitationFilename("paper.pdf:3")).toEqual(["paper.pdf:3", null]);
  });

  test("line:col keeps the col only (recorded: falls through to visible unresolved)", () => {
    expect(parseCitationFilename("src/a.ts:12:34")).toEqual(["src/a.ts:12", 34]);
  });

  test(":line plus dash description", () => {
    expect(parseCitationFilename("src/foo.ts:12 — why it matters")).toEqual(["src/foo.ts", 12]);
  });
});

describe("stripCode", () => {
  test("inline code blanked", () => {
    // inline `code` → spaces, so a [[link]] inside is not parsed.
    const out = stripCode("before `[[inline]]` after");
    expect(out).not.toContain("[[inline]]");
  });

  test("fence blanked", () => {
    const out = stripCode("text\n```\n[[fenced]]\n```\nend");
    expect(out).not.toContain("[[fenced]]");
  });

  test("wiki links ignore code", () => {
    const links = parseWikiLinks("use `[[incode]]` but [[real]] here", "");
    expect(links).toContain("real");
    expect(links).not.toContain("incode");
  });
});

describe("parseWikiLinks", () => {
  test("markdown and bracket links", () => {
    const content =
      "[text](milestones/foo.md)\n" +
      "[[current-state]]\n" +
      "[[a/b|alias]]\n" +
      "[ext](http://example.com)\n" +
      "![img](pic.png)\n" +
      "`[[incode]]`\n";
    const links = parseWikiLinks(content, "");
    expect(links).toContain("milestones/foo.md");
    expect(links).toContain("current-state");
    expect(links).toContain("a/b"); // alias dropped
    // http, image, and code-span links are excluded
    expect(links).not.toContain("http://example.com");
    expect(links).not.toContain("pic.png");
    expect(links).not.toContain("incode");
  });
});

describe("referenceGraphCounts (no-op index reuses the graph)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-refcounts-"));
    mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const page = (body: string) =>
    "---\ntitle: t\ndescription: d\ndate: 2026-06-20\ntags: [a,b]\nstatus: ready\n---\n\n" + body;

  test("reports the stored graph byte-for-byte as the rebuild that made it", () => {
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("see [[3_decision/b]]\n"));
    writeFileSync(join(root, "docs", "wiki", "3_decision", "b.md"), page("plain\n"));
    const w = new WikiIndex(root);
    w.indexAll();
    const built = rebuildReferenceGraph(w);

    const reused = referenceGraphCounts(w);
    expect(reused).toEqual({ citations: built.citations, links: built.links, pages: built.pages });
  });

  test("an empty graph reads as null — indistinguishable from never-built, so the caller rebuilds", () => {
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("no links at all\n"));
    const w = new WikiIndex(root);
    w.indexAll();
    // Graph never materialized (and this wiki has no edges anyway): the reuse path must decline.
    expect(referenceGraphCounts(w)).toBeNull();
  });

  test("a completed linkless rebuild marks the zero-edge graph as reusable", () => {
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("no links at all\n"));
    const w = new WikiIndex(root);
    w.indexAll();

    expect(rebuildReferenceGraph(w)).toEqual({ citations: 0, links: 0, pages: 1, transcriptsRegistered: 0 });
    expect(referenceGraphCounts(w)).toEqual({ citations: 0, links: 0, pages: 1 });
  });

  test("an interrupted rebuild restores the prior graph but invalidates reuse until a complete rebuild", () => {
    const a = join(root, "docs", "wiki", "3_decision", "a.md");
    const b = join(root, "docs", "wiki", "3_decision", "b.md");
    const c = join(root, "docs", "wiki", "3_decision", "c.md");
    writeFileSync(a, page("see [[3_decision/b]]\n"));
    writeFileSync(b, page("plain\n"));
    writeFileSync(c, page("plain\n"));
    const w = new WikiIndex(root);
    w.indexAll();
    rebuildReferenceGraph(w);

    const before = w.connect();
    let oldEdge: { source: string; target: string };
    try {
      oldEdge = before
        .query(
          "SELECT s.filename AS source, t.filename AS target " +
            "FROM document_references r " +
            "JOIN documents s ON s.id = r.source_document_id " +
            "JOIN documents t ON t.id = r.target_document_id",
        )
        .get() as { source: string; target: string };
      expect(oldEdge).toEqual({ source: "a.md", target: "b.md" });
      expect(before.query("SELECT value FROM index_build WHERE key = 'refs-built'").get()).toEqual({ value: "1" });
    } finally {
      before.close();
    }

    // The new graph would contain two edges. Fail deterministically after the first insert, when
    // a non-transactional rebuild would already have exposed a mixed old/new graph.
    writeFileSync(a, page("see [[3_decision/c]]\n"));
    writeFileSync(b, page("also see [[3_decision/c]]\n"));
    expect(w.indexAll()).toEqual([0, 2, 0]);
    const originalUpsert = w.upsertReference.bind(w);
    let upserts = 0;
    w.upsertReference = (db, sourceId, targetId, refType, locator) => {
      upserts += 1;
      if (upserts === 2) throw new Error("simulated interrupted refs rebuild");
      originalUpsert(db, sourceId, targetId, refType, locator);
    };
    try {
      expect(() => rebuildReferenceGraph(w)).toThrow("simulated interrupted refs rebuild");
    } finally {
      w.upsertReference = originalUpsert;
    }

    const after = w.connect();
    try {
      const edges = after
        .query(
          "SELECT s.filename AS source, t.filename AS target " +
            "FROM document_references r " +
            "JOIN documents s ON s.id = r.source_document_id " +
            "JOIN documents t ON t.id = r.target_document_id " +
            "ORDER BY source, target",
        )
        .all();
      expect(edges).toEqual([oldEdge!]);
      expect(after.query("SELECT value FROM index_build WHERE key = 'refs-built'").get()).toBeNull();
    } finally {
      after.close();
    }

    // A positive edge count without the completion marker is still untrusted.
    expect(referenceGraphCounts(w)).toBeNull();
    expect(rebuildReferenceGraph(w)).toEqual({ citations: 0, links: 2, pages: 3, transcriptsRegistered: 0 });
    expect(referenceGraphCounts(w)).toEqual({ citations: 0, links: 2, pages: 3 });
  });

  test("a deletion-only pass reports removed>0, so the caller knows to rebuild", () => {
    const p = join(root, "docs", "wiki", "3_decision", "a.md");
    writeFileSync(p, page("x\n"));
    const w = new WikiIndex(root);
    expect(w.indexAll()[0]).toBe(1); // new
    rmSync(p);
    const [neu, updated, removed] = w.indexAll();
    expect([neu, updated, removed]).toEqual([0, 0, 1]); // not a no-op — edges may have died with it
  });
});
