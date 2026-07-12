// Citation/link parsing.
// Tests assert the *current* behavior of the engine; do not change the engine.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCitationFilename, stripCode, parseWikiLinks, autoRegisterCitedTranscripts } from "../src/engine/refs.ts";
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
