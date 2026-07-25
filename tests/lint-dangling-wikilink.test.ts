// `[[wikilink]]` is the wiki's primary internal-linking idiom — every Related section is built
// from it — yet the dangling-link rule only ever inspected markdown `[text](path)` links. A
// `[[...]]` pointing at nothing produced no edge, no warning, and an orphaned page: the rot was
// invisible, which is exactly how a wiki quietly stops being navigable over years of use.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { Linter, type LintIssue } from "../src/engine/lint.ts";
import { getConfig, _resetForTests } from "../src/engine/config.ts";

describe("dangling wikilink", () => {
  let root: string;
  let wiki: string;
  let idx: WikiIndex;

  function page(dir: string, name: string, body: string): void {
    const target = join(wiki, dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, `${name}.md`),
      `---\ntitle: ${name}\ndescription: ${name}\ndate: 2026-07-25\ntags: [topic, test]\nstatus: ready\n---\n\n${body}\n`,
    );
  }

  function lint(): LintIssue[] {
    const conn = idx.connect();
    idx.indexAll(conn);
    const linter = new Linter(idx as any, conn, getConfig(root));
    const [issues] = linter.run();
    conn.close();
    return issues;
  }

  const dangling = (issues: LintIssue[]) => issues.filter((i) => i.code === "dangling-wikilink");

  beforeEach(() => {
    _resetForTests?.();
    root = mkdtempSync(join(tmpdir(), "llmwiki-danglink-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    idx = new WikiIndex(root);
    page("5_topic", "language-settings", "The language a wiki writes in. ".repeat(12));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a link to a page that does not exist is reported", () => {
    page("3_decision", "d1", "Grounded in [[5_topic/no-such-page]].\n\n" + "Body text. ".repeat(20));
    const found = dangling(lint());
    expect(found.length).toBe(1);
    expect(found[0]!.path).toContain("d1.md");
    expect(found[0]!.message).toContain("5_topic/no-such-page");
  });

  test("it is advisory — a forward reference must never block a close-out", () => {
    page("3_decision", "d1", "Grounded in [[5_topic/no-such-page]].\n\n" + "Body text. ".repeat(20));
    expect(dangling(lint()).every((i) => i.severity === "warn")).toBe(true);
  });

  test("a link that resolves is not reported, by path or by bare name", () => {
    page(
      "3_decision",
      "d1",
      "Both [[5_topic/language-settings]] and [[language-settings]] resolve.\n\n" + "Body text. ".repeat(20),
    );
    expect(dangling(lint())).toEqual([]);
  });

  test("an alias or anchor does not change what is checked", () => {
    page(
      "3_decision",
      "d1",
      "See [[5_topic/language-settings|the language page]] and [[5_topic/language-settings#part]].\n\n" +
        "Body text. ".repeat(20),
    );
    expect(dangling(lint())).toEqual([]);
  });

  test("link syntax shown inside code is documentation, not a link", () => {
    page(
      "3_decision",
      "d1",
      "Write `[[5_topic/whatever]]` to link.\n\n```md\n[[5_topic/also-not-real]]\n```\n\n" + "Body text. ".repeat(20),
    );
    expect(dangling(lint())).toEqual([]);
  });
});
