// "Stale" must mean *my* neighbour moved on without me — not "we were edited together".
//
// Staleness is propagated per updated file: changing page A marks every page that links to A as
// stale so the next deep pass re-reads it. But a close-out normally edits several pages at once,
// and cross-linked pages then marked EACH OTHER — a wiki that had just been brought fully up to
// date reported five stale pages (observed on a real repo). A page updated in the same pass is by
// definition not behind the change.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";

const roots: string[] = [];

function page(title: string, links: string[], extra = ""): string {
  const related = links.map((l) => `- [[${l}]] — grounds`).join("\n");
  return `---\ntitle: ${title}\ndescription: fixture\ndate: 2026-07-25\ntags: [fixture, stale]\nstatus: ready\ndomain: decision\nsource: probe.jsonl\n---\n\nTL;DR — one line.\n\n- a claim${extra}\n\n## Related\n${related}\n`;
}

function mkWiki(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-stale-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("A", ["3_decision/b"]), "utf8");
  writeFileSync(join(root, "docs", "wiki", "3_decision", "b.md"), page("B", ["3_decision/a"]), "utf8");
  const w = new WikiIndex(root);
  w.indexAll();
  rebuildReferenceGraph(w);
  return root;
}

function stalePages(root: string): string[] {
  const w = new WikiIndex(root);
  const conn = w.connect();
  try {
    return (
      conn
        .query("SELECT relative_path FROM documents WHERE stale_since IS NOT NULL ORDER BY relative_path")
        .all() as { relative_path: string }[]
    ).map((r) => r.relative_path);
  } finally {
    conn.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staleness propagation", () => {
  test("editing one page marks the page that links to it", () => {
    const root = mkWiki();
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("A", ["3_decision/b"], " — revised"), "utf8");
    new WikiIndex(root).indexAll();

    expect(stalePages(root)).toEqual(["docs/wiki/3_decision/b.md"]);
  });

  test("editing both pages in one pass marks neither — they are equally current", () => {
    const root = mkWiki();
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("A", ["3_decision/b"], " — revised"), "utf8");
    writeFileSync(join(root, "docs", "wiki", "3_decision", "b.md"), page("B", ["3_decision/a"], " — revised too"), "utf8");
    new WikiIndex(root).indexAll();

    expect(stalePages(root)).toEqual([]);
  });
});
