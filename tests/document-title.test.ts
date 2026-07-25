// A page's title is what the page says it is.
//
// The indexer parsed `description`, `tags`, `date`, `status` and `tier` out of frontmatter but
// derived `title` from the FILENAME, so every DB-backed surface (search results, turn-context
// pointers) showed "2026 07 25 Parse Amount In One Place" where the page itself says "Amount
// parsing lives in one function" — and the agent decides whether to Read a page from that label.
// File-backed surfaces (cold-start) always showed the real title, so the two disagreed.
//
// Titles are DERIVED state, so an index written by an older engine must repair itself on the next
// pass rather than demanding a manual reindex.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { resolveDocumentTitle } from "../src/engine/frontmatter.ts";

const roots: string[] = [];

function mkRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-doc-title-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  return root;
}

function page(title: string | null, body = "- a claim\n"): string {
  const fields = ["description: fixture", "date: 2026-07-25", "tags: [fixture, title]", "status: ready"];
  if (title !== null) fields.unshift(`title: ${title}`);
  return `---\n${fields.join("\n")}\n---\n\n${body}`;
}

function storedTitle(root: string, relative: string): string | null {
  const w = new WikiIndex(root);
  const conn = w.connect();
  try {
    const row = conn.query("SELECT title FROM documents WHERE relative_path = ?").get(relative) as
      | { title: string | null }
      | null;
    return row?.title ?? null;
  } finally {
    conn.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("document title resolution", () => {
  test("frontmatter title wins; the filename is only a fallback", () => {
    expect(
      resolveDocumentTitle({ title: "Amount parsing lives in one function" }, "docs/wiki/3_decision/2026-07-25-parse-amount.md"),
    ).toBe("Amount parsing lives in one function");
    // absent, blank, and non-string titles all fall back to the filename
    expect(resolveDocumentTitle({}, "docs/wiki/3_decision/2026-07-25-parse-amount.md")).toBe("2026 07 25 Parse Amount");
    expect(resolveDocumentTitle({ title: "   " }, "docs/wiki/4_insight/some_note.md")).toBe("Some Note");
    expect(resolveDocumentTitle(null, "src/engine/db.ts")).toBe("Db");
  });

  test("the indexed title comes from the page's own frontmatter", () => {
    const root = mkRepo();
    const relative = "docs/wiki/3_decision/2026-07-25-parse-amount.md";
    writeFileSync(join(root, relative), page("Amount parsing lives in one function"), "utf8");
    new WikiIndex(root).indexAll();

    expect(storedTitle(root, relative)).toBe("Amount parsing lives in one function");
  });

  test("a page with no frontmatter title keeps the filename-derived label", () => {
    const root = mkRepo();
    const relative = "docs/wiki/3_decision/2026-07-25-untitled-decision.md";
    writeFileSync(join(root, relative), page(null), "utf8");
    new WikiIndex(root).indexAll();

    expect(storedTitle(root, relative)).toBe("2026 07 25 Untitled Decision");
  });

  test("an index built by an older engine repairs its titles without a content change", () => {
    const root = mkRepo();
    const relative = "docs/wiki/3_decision/2026-07-25-parse-amount.md";
    writeFileSync(join(root, relative), page("Amount parsing lives in one function"), "utf8");
    const w = new WikiIndex(root);
    w.indexAll();

    // simulate the pre-fix index: a filename-derived title against unchanged content
    const conn = w.connect();
    conn.run("UPDATE documents SET title = ? WHERE relative_path = ?", ["2026 07 25 Parse Amount", relative]);
    conn.close();

    new WikiIndex(root).indexAll(); // same bytes on disk — the fast path must still self-heal
    expect(storedTitle(root, relative)).toBe("Amount parsing lives in one function");
  });

  test("search results carry the page's real title", () => {
    const root = mkRepo();
    writeFileSync(
      join(root, "docs", "wiki", "3_decision", "2026-07-25-parse-amount.md"),
      page("Amount parsing lives in one function", "- `parseAmount` strips separators before Number()\n"),
      "utf8",
    );
    const w = new WikiIndex(root);
    w.indexAll();
    const conn = w.connect();
    try {
      const hits = w.search(conn, "parseAmount", 5, "wiki");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.title).toBe("Amount parsing lives in one function");
    } finally {
      conn.close();
    }
  });
});
