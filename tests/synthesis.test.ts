// Deterministic synthesis — the digest/spine ASSEMBLE links from the
// grounded citation graph, never generate claims. Tests: determinism, hub (in-degree) ranking,
// 0_review surfacing, boundedness, and the empty-wiki guard.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { buildDigest, buildSpine } from "../src/engine/synthesis.ts";

function page(title: string): string {
  return `---\ntitle: ${title}\ndescription: d\ndate: 2026-06-20\ntags: [t, u]\nstatus: ready\n---\n\nbody ${title}\n`;
}

describe("deterministic synthesis", () => {
  let root: string;
  let wiki: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-syn-"));
    wiki = join(root, "docs", "wiki");
    for (const c of ["1_direction", "2_milestone", "3_decision", "4_insight", "0_review"]) {
      mkdirSync(join(wiki, c), { recursive: true });
    }
    writeFileSync(join(wiki, "2_milestone", "hub.md"), page("Hub Page"));
    writeFileSync(join(wiki, "4_insight", "a.md"), page("Insight A"));
    writeFileSync(join(wiki, "4_insight", "b.md"), page("Insight B"));

    // index, then make hub a 2-inbound hub by wiring the grounded graph directly.
    const idx = new WikiIndex(root);
    idx.indexAll();
    const db = idx.connect();
    const docs = idx.listDocumentsWithContent(db);
    const id = (fn: string) => String(docs.find((d) => String(d.filename) === fn)!.id);
    idx.upsertReference(db, id("a.md"), id("hub.md"), "cites", null);
    idx.upsertReference(db, id("b.md"), id("hub.md"), "cites", null);
    db.close();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("digest is deterministic (same index → identical output)", () => {
    expect(buildDigest(root)).toBe(buildDigest(root));
  });

  test("digest only links existing pages (no fabricated content)", () => {
    const out = buildDigest(root);
    // every markdown link target must be a real wiki page path we created
    for (const m of out.matchAll(/\]\(([^)]+)\)/g)) {
      expect(m[1]).toMatch(/^docs\/wiki\/(1_direction|2_milestone|3_decision|4_insight)\/.+\.md$/);
    }
  });

  test("hub ranked by in-degree (2 inbound)", () => {
    const out = buildDigest(root);
    // language-neutral: the hubs section lists hub.md with its inbound count (works in en/ko)
    expect(out).toMatch(/\[.*\]\(docs\/wiki\/2_milestone\/hub\.md\) — 2 inbound/);
  });

  test("spine surfaces the hub with its count, bounded", () => {
    const spine = buildSpine(root);
    expect(spine.join("\n")).toMatch(/hub\.md\s+\(2x\)/);
    expect(spine.length).toBeLessThanOrEqual(5); // max 4 hubs + 1 summary line
  });

  test("0_review items surface in digest and spine summary", () => {
    writeFileSync(join(wiki, "0_review", "2026-06-20-some-direction.md"), "Q. confirm?\n");
    // language-neutral: the open item's filename + the spine's neutral summary line
    expect(buildDigest(root)).toContain("2026-06-20-some-direction");
    expect(buildSpine(root).join("\n")).toContain("0_review: 1 open");
  });

  test("empty wiki → spine empty, digest points to /wiki-update", () => {
    const empty = mkdtempSync(join(tmpdir(), "llmwiki-syn0-"));
    mkdirSync(join(empty, "docs", "wiki", "2_milestone"), { recursive: true });
    expect(buildSpine(empty)).toEqual([]);
    // language-neutral: both en/ko empty messages point to /wiki-update
    expect(buildDigest(empty)).toContain("/wiki-update");
    rmSync(empty, { recursive: true, force: true });
  });
});
