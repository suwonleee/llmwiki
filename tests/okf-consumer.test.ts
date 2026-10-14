// OKF-aware consumption: how links resolve (relative to the linking page's folder, bundle-absolute,
// percent-encoded), what lint enforces on an OKF bundle versus a legacy wiki, how the per-turn
// pointers mark retired or stale knowledge, and the OKF line of wiki-doctor.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { Linter, type LintIssue } from "../src/engine/lint.ts";
import { getConfig, _resetForTests } from "../src/engine/config.ts";
import { hrefCandidates, parseWikiLinks, rebuildReferenceGraph, wikiPageDir } from "../src/engine/refs.ts";
import { buildTurnContext, currencyMark, pageCurrency } from "../src/engine/turncontext.ts";
import { formatWikiDoctorReport, runWikiDoctor } from "../src/engine/wiki-doctor.ts";

const OKF_ROOT_INDEX = '---\nokf_version: "0.2"\n---\n';
const temporary: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const path = join(root, "docs", "wiki", rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function page(fields: Record<string, string>, body: string): string {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}\n`;
}

const filler = (word: string) => `${word} body text for the index. `.repeat(12);

function lint(root: string): LintIssue[] {
  const idx = new WikiIndex(root);
  const conn = idx.connect();
  idx.indexAll(conn);
  rebuildReferenceGraph(idx);
  const [issues] = new Linter(idx as any, conn, getConfig(root)).run();
  conn.close();
  return issues;
}

beforeEach(() => {
  _resetForTests?.();
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("href resolution", () => {
  test("`../` resolves by path from the linking page's folder", () => {
    expect(hrefCandidates("../5_topic/x.md", "3_decision")).toEqual(["5_topic/x.md"]);
    expect(hrefCandidates("./y.md", "3_decision")).toEqual(["3_decision/y.md"]);
    expect(hrefCandidates("y.md", "3_decision")).toEqual(["3_decision/y.md"]);
    // A `..` above the wiki root cannot leave the bundle.
    expect(hrefCandidates("../../x.md", "3_decision")).toEqual(["x.md"]);
  });

  test("a bundle-absolute href is relative to docs/wiki", () => {
    expect(hrefCandidates("/5_topic/x.md", "3_decision")).toEqual(["5_topic/x.md"]);
    expect(hrefCandidates("/5_topic/x.md#part", "")).toEqual(["5_topic/x.md"]);
  });

  test("percent-encoding is decoded before lookup", () => {
    const encoded = `../5_topic/${encodeURIComponent("언어 설정")}.md`;
    expect(hrefCandidates(encoded, "3_decision")).toEqual(["5_topic/언어 설정.md"]);
    expect(hrefCandidates("a%20b.md", "")).toEqual(["a b.md"]);
    expect(hrefCandidates("100%.md", "")).toEqual(["100%.md"]); // a stray % is literal
  });

  test("a bare nested href keeps the legacy wiki-root reading as a second candidate", () => {
    expect(hrefCandidates("5_topic/x.md", "3_decision")).toEqual(["3_decision/5_topic/x.md", "5_topic/x.md"]);
    expect(hrefCandidates("5_topic/x.md", "")).toEqual(["5_topic/x.md"]);
  });

  test("parseWikiLinks resolves against the page folder and still reads [[wikilinks]]", () => {
    const links = parseWikiLinks("[a](../5_topic/x.md) [b](/4_insight/y.md) [[legacy-page]]", "3_decision");
    expect(links).toEqual(["5_topic/x.md", "4_insight/y.md", "legacy-page"]);
  });

  test("the page folder comes from the file, whether a row or a file path is given", () => {
    expect(wikiPageDir({ relative_path: "docs/wiki/3_decision/a.md", path: "/docs/wiki/3_decision/" })).toBe("3_decision");
    expect(wikiPageDir({ relative_path: "docs/wiki/current-state.md", path: "/docs/wiki/" })).toBe("");
    expect(wikiPageDir({ path: "/repo/docs/wiki/3_decision/a.md" })).toBe("3_decision");
    expect(wikiPageDir({ path: "/docs/wiki/3_decision/" })).toBe("3_decision");
  });

  test("graph edges follow the path, not a same-named file elsewhere", () => {
    const root = tempRoot("llmwiki-okf-edges-");
    const meta = { title: "t", description: "d", date: "2026-10-13", tags: "[a, b]", status: "stable" };
    write(root, "5_topic/x.md", page({ ...meta, title: "topic x" }, filler("topic")));
    write(root, "4_insight/x.md", page({ ...meta, title: "insight x" }, filler("insight")));
    write(root, "3_decision/a.md", page(meta, "[topic](../5_topic/x.md)\n\n" + filler("a")));
    write(root, "3_decision/b.md", page(meta, "[insight](/4_insight/x.md)\n\n" + filler("b")));
    write(root, "3_decision/c.md", page(meta, `[enc](${encodeURI("../5_topic/x.md")})\n\n` + filler("c")));
    const idx = new WikiIndex(root);
    idx.indexAll();
    rebuildReferenceGraph(idx);
    const conn = idx.connect();
    const docs = idx.listDocuments(conn);
    const linksOf = (name: string) => {
      const d = docs.find((x) => x.relative_path === `docs/wiki/3_decision/${name}`)!;
      return idx
        .getForwardReferences(conn, String(d.id))
        .filter((r) => r.reference_type === "links_to")
        .map((r) => `${r.path}${r.filename}`);
    };
    expect(linksOf("a.md")).toEqual(["/docs/wiki/5_topic/x.md"]);
    expect(linksOf("b.md")).toEqual(["/docs/wiki/4_insight/x.md"]);
    expect(linksOf("c.md")).toEqual(["/docs/wiki/5_topic/x.md"]);
    conn.close();
  });
});

describe("lint on a legacy wiki", () => {
  test("one okf-not-converted advisory, never a per-page OKF error", () => {
    const root = tempRoot("llmwiki-okf-legacy-");
    const meta = { title: "t", description: "d", date: "2026-10-13", tags: "[a, b]", status: "ready" };
    write(root, "3_decision/a.md", page(meta, "[[b]]\n\n" + filler("a")));
    write(root, "3_decision/b.md", page(meta, "[[a]]\n\n" + filler("b")));
    const issues = lint(root);
    const advisory = issues.filter((i) => i.code === "okf-not-converted");
    expect(advisory.length).toBe(1);
    expect(advisory[0]!.severity).toBe("warn");
    expect(advisory[0]!.message).toContain("llmwiki okf");
    expect(advisory[0]!.message).toContain("--commit");
    expect(issues.filter((i) => i.code.startsWith("okf-") && i.code !== "okf-not-converted")).toEqual([]);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("lint on an OKF bundle", () => {
  let root: string;
  const meta = {
    type: "Decision",
    title: "t",
    description: "d",
    date: "2026-10-13",
    tags: "[a, b]",
    status: "stable",
    generated: "{ by: llmwiki/test, at: 2026-10-13T10:00:00+09:00 }",
  };
  beforeEach(() => {
    root = tempRoot("llmwiki-okf-bundle-");
    write(root, "index.md", OKF_ROOT_INDEX);
    write(root, "5_topic/언어 설정.md", page({ ...meta, type: "Topic" }, filler("topic")));
  });

  test("a page without `type` is an OKF error; no okf-not-converted advisory", () => {
    const { type: _omit, ...untyped } = meta;
    write(root, "3_decision/a.md", page(untyped, `[t](../5_topic/${encodeURIComponent("언어 설정")}.md)\n\n` + filler("a")));
    const issues = lint(root);
    const missing = issues.filter((i) => i.code === "okf-type-missing");
    expect(missing.length).toBe(1);
    expect(missing[0]!.severity).toBe("error");
    expect(missing[0]!.path).toContain("3_decision/a.md");
    expect(issues.some((i) => i.code === "okf-not-converted")).toBe(false);
  });

  test("soft OKF rules are warnings: legacy status spelling, wikilinks", () => {
    write(root, "3_decision/a.md", page({ ...meta, status: "ready" }, "[[5_topic/언어 설정]]\n\n" + filler("a")));
    const issues = lint(root).filter((i) => i.path.includes("3_decision/a.md"));
    expect(issues.find((i) => i.code === "okf-status")?.severity).toBe("warn");
    expect(issues.find((i) => i.code === "okf-wikilink")?.severity).toBe("warn");
  });

  test("a dangling [[wikilink]] names the link form itself as legacy", () => {
    write(root, "3_decision/a.md", page(meta, "[[5_topic/nowhere]]\n\n" + filler("a")));
    const d = lint(root).find((i) => i.code === "dangling-wikilink");
    expect(d?.severity).toBe("warn");
    expect(d?.message).toContain("pre-OKF");
  });

  test("bundle-absolute and percent-encoded links resolve; a broken one is still an error", () => {
    write(
      root,
      "3_decision/a.md",
      page(meta, `[abs](/5_topic/${encodeURIComponent("언어 설정")}.md) [rel](../5_topic/언어%20설정.md)\n\n` + filler("a")),
    );
    write(root, "3_decision/b.md", page(meta, "[gone](/5_topic/missing.md)\n\n" + filler("b")));
    const dangling = lint(root).filter((i) => i.code === "dangling-link");
    expect(dangling.length).toBe(1);
    expect(dangling[0]!.path).toContain("3_decision/b.md");
  });

  test("`generated.at` satisfies the date requirement", () => {
    const { date: _omit, ...undated } = meta;
    write(root, "3_decision/a.md", page(undated, filler("a")));
    const issues = lint(root).filter((i) => i.path.includes("3_decision/a.md"));
    expect(issues.some((i) => i.code === "missing-date")).toBe(false);
  });

  test("index.md at any level is reserved — never linted as a page", () => {
    write(root, "3_decision/index.md", "# Decision\n\n* [a](a.md) - d\n");
    write(root, "3_decision/a.md", page(meta, filler("a")));
    const idx = new WikiIndex(root);
    const conn = idx.connect();
    idx.indexAll(conn);
    const linter = new Linter(idx as any, conn, getConfig(root));
    const fake = { id: "x", path: "/docs/wiki/3_decision/", filename: "index.md", relative_path: "docs/wiki/3_decision/index.md", content: "# no frontmatter" };
    (linter as any).okf = (linter as any)._isOkf(); // run() decides this once per lint
    expect(linter._lintPage(fake, {}, {}, { byName: {}, byRelpath: {} }, 3)).toEqual([]);
    conn.close();
  });
});

describe("superseded pointer (OKF lifecycle)", () => {
  const linter = new Linter(null, null, getConfig());
  const doc = { id: "1", path: "/docs/wiki/3_decision/", filename: "a.md", relative_path: "docs/wiki/3_decision/a.md" };
  const base = { title: "t", description: "d", date: "2026-10-13", tags: ["a", "b"] };
  const has = (meta: Record<string, string | string[]>) =>
    linter._frontmatter(doc, meta).some((i) => i.code === "superseded-missing-pointer");

  test("`superseded` without a successor is an error", () => {
    expect(has({ ...base, status: "superseded" })).toBe(true);
    expect(has({ ...base, status: "superseded", superseded_by: "[[b]]" })).toBe(false);
  });

  test("plain `deprecated` is a lifecycle state; with `superseded_at` it needs `superseded_by`", () => {
    expect(has({ ...base, status: "deprecated" })).toBe(false);
    expect(has({ ...base, status: "deprecated", superseded_at: "2026-10-01" })).toBe(true);
    expect(has({ ...base, status: "deprecated", superseded_at: "2026-10-01", superseded_by: "../3_decision/b.md" })).toBe(false);
  });
});

describe("turn-context marks retired and stale knowledge", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot("llmwiki-okf-tc-");
    const body = "Tokenizer migration notes for the trigram chunker index rebuild. ".repeat(10);
    write(root, "3_decision/tokenizer-old.md", page({ title: "Trigram tokenizer chunker plan", status: "deprecated", superseded_by: "tokenizer-new.md" }, body));
    // The current page lacks one prompt word ("notes"), so the retired one leads by a point.
    write(root, "3_decision/tokenizer-new.md", page({ title: "Trigram tokenizer chunker plan v2", status: "stable" }, body.replaceAll("notes ", "")));
    write(root, "4_insight/tokenizer-stale.md", page({ title: "Trigram tokenizer chunker caveat", stale_after: "2020-01-01T00:00:00+00:00" }, body));
    new WikiIndex(root).indexAll();
  });

  test("pageCurrency reads lifecycle and stale_after from the file", () => {
    expect(pageCurrency(root, "docs/wiki/3_decision/tokenizer-old.md")).toEqual({ deprecated: true, stale: false });
    expect(pageCurrency(root, "docs/wiki/4_insight/tokenizer-stale.md")).toEqual({ deprecated: false, stale: true });
    expect(pageCurrency(root, "docs/wiki/3_decision/tokenizer-new.md")).toEqual({ deprecated: false, stale: false });
    expect(pageCurrency(root, "docs/wiki/missing.md")).toEqual({ deprecated: false, stale: false });
    expect(currencyMark({ deprecated: true, stale: true })).toBe(" (deprecated)");
    expect(currencyMark({ deprecated: false, stale: true })).toBe(" (stale)");
  });

  test("pointers carry the mark, and the retired page drops below a current peer one point behind", () => {
    const out = buildTurnContext(root, "trigram tokenizer chunker plan notes", "", { affinity: null });
    const lines = out.split("\n").slice(1);
    const oldLine = lines.findIndex((l) => l.includes("tokenizer-old.md"));
    const newLine = lines.findIndex((l) => l.includes("tokenizer-new.md"));
    expect(oldLine).toBeGreaterThan(-1);
    expect(newLine).toBeGreaterThan(-1);
    expect(lines[oldLine]).toContain("(deprecated)  →");
    expect(lines[newLine]).not.toContain("(deprecated)");
    expect(newLine).toBeLessThan(oldLine);
    const staleLine = lines.find((l) => l.includes("tokenizer-stale.md"));
    if (staleLine) expect(staleLine).toContain("(stale)  →");
  });
});

describe("wiki-doctor OKF line", () => {
  beforeEach(() => {
    capture.setStateDir(tempRoot("llmwiki-okf-doctor-state-"));
  });

  test("a legacy wiki gets one advisory pointing at `llmwiki okf`, and --fix never converts it", () => {
    const root = tempRoot("llmwiki-okf-doctor-legacy-");
    write(root, "overview.md", page({ title: "Overview", description: "d", date: "2026-10-13", tags: "[a, b]" }, filler("o")));
    const report = runWikiDoctor(root, { fix: true, today: "2026-10-13" });
    expect(report.okf.bundle).toBe(false);
    const finding = report.findings.find((f) => f.code === "okf-not-converted");
    expect(finding?.command).toContain("llmwiki okf");
    expect(finding?.severity).toBe("info");
    expect(formatWikiDoctorReport(report)).toContain("okf       : legacy");
    expect(runWikiDoctor(root, { today: "2026-10-13" }).okf.bundle).toBe(false);
  });

  test("an OKF bundle reports conformant/total and errors; the listings never read as a stale index", () => {
    const root = tempRoot("llmwiki-okf-doctor-bundle-");
    write(root, "index.md", OKF_ROOT_INDEX);
    write(root, "4_insight/typed.md", page({ type: "Insight", title: "typed", description: "d", date: "2026-10-13", tags: "[a, b]" }, filler("t")));
    write(root, "4_insight/untyped.md", page({ title: "untyped", description: "d", date: "2026-10-13", tags: "[a, b]" }, filler("u")));
    const check = runWikiDoctor(root, { today: "2026-10-13" });
    expect(check.okf.bundle).toBe(true);
    expect(check.okf.errors).toBeGreaterThan(0);
    expect(formatWikiDoctorReport(check)).toMatch(/okf {7}: bundle · \d+\/\d+ conformant · \d+ error/);
    expect(check.findings.some((f) => f.code === "okf-nonconformant")).toBe(true);

    const fixed = runWikiDoctor(root, { fix: true, today: "2026-10-13" });
    expect(fixed.actions.some((a) => a.code === "okf-normalized")).toBe(true);
    expect(fixed.okf.errors).toBe(0);
    expect(fixed.okf.conformant).toBe(fixed.okf.concepts);
    expect(fixed.index.status).toBe("current");
  });
});

test("a link whose text carries escaped brackets is still a link (titles like `[TRUST] …`)", () => {
  expect(parseWikiLinks("see [\\[TRUST\\] ECS 이식](../2_milestone/x.md) and [b](y.md)", "3_decision")).toEqual([
    "2_milestone/x.md",
    "3_decision/y.md",
  ]);
});
