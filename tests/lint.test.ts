// Frontmatter + footnote + banned-term hygiene.
//
// `new Linter(null, null)._footnotes` is exercisable without an index/conn.
// Tests assert the *current* behavior of the engine; do not change the engine.
import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Linter, formatReport, TOPIC_BUDGET, type WikiDoc } from "../src/engine/lint.ts";
import { defaults } from "../src/engine/config.ts";
import { parseFrontmatter } from "../src/engine/frontmatter.ts";
import { WikiIndex } from "../src/engine/db.ts";

describe("parseFrontmatter", () => {
  test("normal yaml", () => {
    const content = "---\ntitle: Hello\ndescription: A page\n---\nbody";
    const meta = parseFrontmatter(content);
    expect(meta.fields["title"]).toBe("Hello");
    expect(meta.fields["description"]).toBe("A page");
  });

  test("tags list", () => {
    const content = "---\ntitle: T\ntags: [a, b, c]\n---\nbody";
    const meta = parseFrontmatter(content);
    expect(meta.fields["tags"]).toEqual(["a", "b", "c"]);
  });

  test("no frontmatter", () => {
    expect(parseFrontmatter("just body, no front matter").fields).toEqual({});
  });

  test("characterizes scalar status and list tags consumed by lint", () => {
    // Given: the legacy parser's supported scalar/list frontmatter shape.
    const content = "---\ntitle: Decision\ndate: 2026-07-23\ntags: [architecture, typed]\nstatus: ready\n---\nbody";
    const doc: WikiDoc = {
      id: "doc-1",
      path: "/docs/wiki/",
      filename: "decision.md",
      relative_path: "docs/wiki/decision.md",
    };
    const linter = new Linter(null, null);

    // When: lint consumes the legacy parser result.
    const metadata = parseFrontmatter(content);
    const issues = linter._frontmatter(doc, metadata.fields);

    // Then: page semantics stay accepted; `status` has no operational meaning here.
    expect(metadata.fields["tags"]).toEqual(["architecture", "typed"]);
    expect(issues.map((issue) => issue.code)).not.toContain("missing-frontmatter");
  });
});

describe("cold page hydration", () => {
  test("lint reads the on-disk body after the cold page is stored metadata-only", () => {
    // Given: a cold page missing a lint-required frontmatter field.
    const root = mkdtempSync(join(tmpdir(), "llmwiki-lint-cold-"));
    const wiki = join(root, "docs", "wiki", "4_insight");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(
      join(wiki, "cold.md"),
      [
        "---",
        "title: Cold lint page",
        "date: 2025-01-02",
        "tags: [cold, lint]",
        "status: ready",
        "tier: cold",
        "---",
        "",
        "lint must hydrate this body",
      ].join("\n"),
    );
    const index = new WikiIndex(root);
    const conn = index.connect();

    try {
      index.indexAll(conn);
      expect(
        conn.query("SELECT content IS NULL AS missing_content FROM documents WHERE relative_path='docs/wiki/4_insight/cold.md'").get(),
      ).toEqual({ missing_content: 1 });

      // When / Then: the lint reader receives the disk body and reports its missing description.
      const row = index.listDocumentsWithContent(conn).find((document) => document.relative_path === "docs/wiki/4_insight/cold.md");
      if (row === undefined || typeof row.content !== "string") throw new Error("cold lint fixture did not hydrate");
      const document: WikiDoc = {
        id: String(row.id),
        path: String(row.path),
        filename: String(row.filename),
        relative_path: String(row.relative_path),
        content: row.content,
      };
      const issues = new Linter(null, null, defaults())._frontmatter(document, parseFrontmatter(row.content).fields);
      expect(issues.map((issue) => issue.code)).toContain("missing-description");
    } finally {
      conn.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("footnotes", () => {
  let linter: Linter;
  beforeEach(() => {
    // _footnotes uses neither index nor conn → null is safe.
    linter = new Linter(null, null);
  });

  test("duplicate definition", () => {
    const content = "[^1]: file.pdf\n[^1]: dup.pdf\n";
    const codes = linter._footnotes("p.md", content).map((i) => i.code);
    expect(codes).toContain("duplicate-footnote");
  });

  test("use without definition", () => {
    const content = "Some text references [^9] here.\n";
    const issues = linter._footnotes("p.md", content);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("footnote-without-definition");
    expect(issues.some((i) => i.severity === "error")).toBe(true);
  });

  test("definition without use warns", () => {
    const content = "[^3]: only defined, never used\n";
    const issues = linter._footnotes("p.md", content);
    const match = issues.filter((i) => i.code === "unused-footnote-definition");
    expect(match.length).toBe(1);
    expect(match[0]!.severity).toBe("warn");
  });

  test("clean footnotes", () => {
    const content = "Cite this [^1].\n[^1]: file.pdf\n";
    expect(linter._footnotes("p.md", content)).toEqual([]);
  });
});

describe("banned terms", () => {
  let linter: Linter;
  beforeEach(() => {
    // _banned uses neither index nor conn → null is safe.
    linter = new Linter(null, null);
  });

  test("flags jargon", () => {
    for (const term of ["진북", "북극성", "distill"]) {
      const issues = linter._banned("p.md", `이 문서의 ${term} 설명`);
      expect(issues.map((i) => i.code)).toEqual(["banned-term"]);
      expect(issues[0]!.severity).toBe("warn");
    }
  });

  test("clean prose passes", () => {
    expect(linter._banned("p.md", "방향성을 업데이트했다")).toEqual([]);
  });

  test("ignores code spans", () => {
    // historical/code refs inside backticks are not flagged (prose-only scan)
    expect(linter._banned("p.md", "`wiki-distill-check.sh` 는 구 시스템")).toEqual([]);
  });
});

// P0-4: honesty rules — supersession pointer + numeric-confidence ban.
describe("honesty rules", () => {
  const doc = { id: 1, path: "/docs/wiki/", filename: "d.md", relative_path: "docs/wiki/d.md" };
  let linter: Linter;
  beforeEach(() => {
    linter = new Linter(null, null);
  });

  test("superseded without pointer is an error", () => {
    const issues = linter._frontmatter(doc as any, {
      title: "t", description: "d", date: "2026-07-06", tags: ["a", "b"], status: "superseded",
    });
    expect(issues.map((i) => i.code)).toContain("superseded-missing-pointer");
    expect(issues.find((i) => i.code === "superseded-missing-pointer")!.severity).toBe("error");
  });

  test("superseded with pointer passes", () => {
    const issues = linter._frontmatter(doc as any, {
      title: "t", description: "d", date: "2026-07-06", tags: ["a", "b"],
      status: "superseded", superseded_by: "3_decision/new-decision.md",
    });
    expect(issues.map((i) => i.code)).not.toContain("superseded-missing-pointer");
  });

  test("numeric confidence is warned", () => {
    const issues = linter._frontmatter(doc as any, {
      title: "t", description: "d", date: "2026-07-06", tags: ["a", "b"], confidence: "0.85",
    });
    const hit = issues.find((i) => i.code === "numeric-confidence");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warn");
  });

  test("non-numeric confidence prose is not flagged", () => {
    const issues = linter._frontmatter(doc as any, {
      title: "t", description: "d", date: "2026-07-06", tags: ["a", "b"],
      confidence: "grounded in two transcripts",
    });
    expect(issues.map((i) => i.code)).not.toContain("numeric-confidence");
  });
});

// Topic pages accrete (merge = append bullets, never rewrite existing lines) → advisory
// oversize debt with a re-distill pointer. Warn only, never an error (oversize is debt, not
// a gate-blocker). Explicit defaults() so a runner-local config can't skew the topic dir.
describe("topic oversize", () => {
  const mkDoc = (dir: string, filename = "t.md") =>
    ({ id: 1, path: `/repo/docs/wiki/${dir}/`, filename, relative_path: `docs/wiki/${dir}/${filename}` });
  let linter: Linter;
  beforeEach(() => {
    linter = new Linter(null, null, defaults());
  });

  test("topic page over budget warns with a re-distill pointer", () => {
    const issues = linter._oversizedTopic(mkDoc("5_topic") as any, "x".repeat(TOPIC_BUDGET + 1));
    expect(issues.map((i) => i.code)).toEqual(["topic-oversize"]);
    expect(issues[0]!.severity).toBe("warn");
    expect(issues[0]!.message).toContain("transcript");
  });

  test("topic page at the budget passes (boundary is inclusive)", () => {
    expect(linter._oversizedTopic(mkDoc("5_topic") as any, "x".repeat(TOPIC_BUDGET))).toEqual([]);
  });

  test("non-topic pages are never flagged, regardless of size", () => {
    expect(linter._oversizedTopic(mkDoc("2_milestone") as any, "x".repeat(TOPIC_BUDGET * 2))).toEqual([]);
  });

  test("a filename merely containing the topic dir name is not a topic page", () => {
    const doc = { id: 1, path: "/repo/docs/wiki/4_insight/", filename: "about-5_topic.md", relative_path: "docs/wiki/4_insight/about-5_topic.md" };
    expect(linter._oversizedTopic(doc as any, "x".repeat(TOPIC_BUDGET * 2))).toEqual([]);
  });
});

// --errors-only report shape: errors in full, warnings collapsed to per-code counts (debt
// stays visible as counts; the plain run still prints every line — nothing is lost).
describe("formatReport errors-only", () => {
  const issues = [
    { severity: "error" as const, code: "unresolved-citation", path: "a.md", message: "bad cite" },
    { severity: "warn" as const, code: "uncited-source", path: "s1.md", message: "w" },
    { severity: "warn" as const, code: "uncited-source", path: "s2.md", message: "w" },
    { severity: "warn" as const, code: "orphan-page", path: "o.md", message: "w" },
  ];

  test("collapses warnings to counts and keeps errors verbatim", () => {
    const out = formatReport(issues, 4, "repo", { errorsOnly: true });
    expect(out).toContain("[unresolved-citation]");
    expect(out).toContain("uncited-source 2");
    expect(out).toContain("orphan-page 1");
    expect(out).not.toContain("`s1.md`"); // individual warning lines suppressed
    expect(out).toContain("1 error, 3 warning"); // header counts unchanged
  });

  test("plain run still prints every warning line (default unchanged)", () => {
    const out = formatReport(issues, 4, "repo");
    expect(out).toContain("`s1.md`");
    expect(out).toContain("`s2.md`");
    expect(out).not.toContain("collapsed");
  });

  test("errors-only with zero issues is the same pass line", () => {
    expect(formatReport([], 3, "repo", { errorsOnly: true })).toContain("Lint passed");
  });
});
