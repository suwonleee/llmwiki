// Co-editing pages is not evidence that dependency claims were reverified.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { acknowledgeFreshness, freshnessSnapshot } from "../src/engine/source-freshness.ts";
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

  test("editing both pages in one pass requires explicit verification of both", () => {
    const root = mkWiki();
    writeFileSync(join(root, "docs", "wiki", "3_decision", "a.md"), page("A", ["3_decision/b"], " — revised"), "utf8");
    writeFileSync(join(root, "docs", "wiki", "3_decision", "b.md"), page("B", ["3_decision/a"], " — revised too"), "utf8");
    new WikiIndex(root).indexAll();

    expect(stalePages(root)).toEqual(["docs/wiki/3_decision/a.md", "docs/wiki/3_decision/b.md"]);
    for (const path of stalePages(root)) acknowledgeFreshness(root, freshnessSnapshot(root, path), {
      verifiedBy: "fixture-verifier", evidence: "Read both revised pages and checked their claims",
    });
    expect(stalePages(root)).toEqual([]);
  });
});


describe("code-source citation staleness", () => {
  function codeCitationFixture(): { root: string; source: string; citation: string } {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cites-stale-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "wiki", "5_topic"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    const source = join(root, "src", "policy.ts");
    const citation = join(root, "docs", "wiki", "5_topic", "citation.md");
    writeFileSync(source, "export const MAX_RETRIES = 1;\n");
    writeFileSync(citation, citationPage(1));
    writeFileSync(join(root, "docs", "wiki", "5_topic", "link.md"),
      "---\ntype: Topic\ntitle: Linked policy\n---\n\nSee [policy](../../../src/policy.ts).\n");
    const index = new WikiIndex(root);
    index.indexAll();
    rebuildReferenceGraph(index);
    return { root, source, citation };
  }

  function citationPage(retries: number): string {
    return "---\ntype: Topic\ntitle: Retry policy\nsources:\n  - id: policy\n    resource: src/policy.ts\n---\n\n" +
      `MAX_RETRIES is ${retries}.[^policy]\n\n[^policy]: Current implementation.\n`;
  }

  test("a changed code source marks both its OKF citation and Markdown-link dependents", () => {
    const { root, source } = codeCitationFixture();
    expect(stalePages(root)).toEqual([]);
    // Different length ensures the incremental index sees the source update.
    writeFileSync(source, "export const MAX_RETRIES = 100;\n");
    expect(new WikiIndex(root).indexAll()[1]).toBe(1);
    expect(stalePages(root)).toEqual([
      "docs/wiki/5_topic/citation.md", "docs/wiki/5_topic/link.md",
    ]);
  });

  test("a citation revised with its code source requires verification just like an untouched link", () => {
    const { root, source, citation } = codeCitationFixture();
    writeFileSync(source, "export const MAX_RETRIES = 100;\n");
    writeFileSync(citation, citationPage(100));
    expect(new WikiIndex(root).indexAll()[1]).toBe(2);
    expect(stalePages(root)).toEqual(["docs/wiki/5_topic/citation.md", "docs/wiki/5_topic/link.md"]);
    acknowledgeFreshness(root, freshnessSnapshot(root, "docs/wiki/5_topic/citation.md"), {
      verifiedBy: "fixture-verifier", evidence: "Confirmed revised retry count matches code",
    });
    expect(stalePages(root)).toEqual(["docs/wiki/5_topic/link.md"]);
  });
});
