// `llmwiki okf`: a pre-OKF wiki converts to an OKF v0.2 bundle on an explicit commit, the result
// passes the conformance check, a second pass is a no-op, and the close-out pass (`--if-okf`)
// re-stamps only pages whose body changed. A fresh skeleton starts OKF-native.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { _resetForTests } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { parseFrontmatter } from "../src/engine/frontmatter.ts";
import { checkLog, parseYamlBlock, splitFrontmatter } from "../src/engine/okf.ts";
import { checkBundle, isOkfBundle, okfApply } from "../src/engine/okf-bundle.ts";
import { appendLog, ensureSkeleton } from "../src/engine/update.ts";

const tmps: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "user.email=kim@example.com", "-c", "user.name=Kim", ...args], {
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

function write(repo: string, rel: string, content: string): void {
  const p = join(repo, "docs", "wiki", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function read(repo: string, rel: string): string {
  return readFileSync(join(repo, "docs", "wiki", rel), "utf-8");
}

function fm(repo: string, rel: string) {
  return parseYamlBlock(splitFrontmatter(read(repo, rel)).block!).data;
}

/** A small wiki in the pre-OKF form, committed, the way every existing wiki looks today. */
function legacyWiki(): string {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-okf-"));
  tmps.push(repo);
  git(repo, "init", "-q");
  write(repo, "current-state.md", "---\ntitle: Current State — demo (L0)\nupdated: 2026-08-18\ntags: [current-state, L0]\n---\n\n## Now\n\n- see [[3_decision/2026-07-01-pick-x]]\n");
  write(repo, "overview.md", "---\ntitle: Overview\ndescription: front page\ndate: 2026-06-18\ntags: [overview, meta]\n---\n\nRecent: [[log.md]]\n");
  write(
    repo,
    "1_direction/2026-07-11-autonomy.md",
    "---\ntitle: 운영 자율성 — 판단불가 영역만\ndescription: d\ndate: 2026-07-11\ntags: [a, b]\nstatus: ready\ndomain: direction\nsource: s-dir.jsonl\n---\n\n## 1. 확정\n\n- 결정.[^1]\n\n[^1]: s-dir.jsonl\n",
  );
  write(
    repo,
    "3_decision/2026-07-01-pick-x.md",
    '---\ntitle: "X"를 고른다: 이유\ndescription: d\ndate: 2026-07-01\ntags: [a, b]\nstatus: superseded\nsuperseded_by: 3_decision/2026-08-01-pick-y.md\ndomain: decision\nsource: s1.jsonl\n---\n\n- 고름.[^1] 관련 [[5_topic/x-topic]].\n\n[^1]: s1.jsonl\n    > [2026-07-01 10:00 user] "x로 하자"\n',
  );
  write(
    repo,
    "4_insight/2026-07-02-gotcha.md",
    "---\ntitle: Gotcha\ndescription: d\ndate: 2026-07-02\ntags: [a, b]\nstatus: ready\ndomain: insight\nsource: s2.jsonl\n---\n\n- 함정.[^1]\n\n[^1]: s2.jsonl\n",
  );
  write(repo, "5_topic/x-topic.md", "---\ntitle: X topic\ndescription: d\nupdated: 2026-07-03\ntags: [a, b]\nstatus: ready\ndomain: topic\n---\n\n- 사실.[^s1]\n\n[^s1]: s1.jsonl\n");
  write(repo, "cold-index.md", "---\ntitle: Cold Page Index\ntier: protected\n---\n\n# Cold Page Index\n");
  write(
    repo,
    "log.md",
    "---\ntitle: Log\ndate: 2026-06-18\ntags: [log, meta]\n---\n\nappend-only.\n\n## [2026-07-02] autoupdate | gotcha\n- 4_insight/2026-07-02-gotcha.md (strong-model confirmed·ready)\n- source: s2.jsonl\n\n## [2026-07-11] update | autonomy\n- pages: [[1_direction/2026-07-11-autonomy]]\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}

describe("llmwiki okf on a pre-OKF wiki", () => {
  test("dry run plans without writing; the close-out form skips a legacy wiki", () => {
    const repo = legacyWiki();
    const before = read(repo, "3_decision/2026-07-01-pick-x.md");
    const plan = okfApply(repo);
    expect(plan.verdict).toBe("planned");
    expect(plan.pages).toBe(6);
    expect(plan.linksConverted).toBe(4); // three in pages, one in log.md
    expect(plan.logConverted).toBe(true);
    expect(read(repo, "3_decision/2026-07-01-pick-x.md")).toBe(before);
    expect(isOkfBundle(repo)).toBe(false);
    const skip = okfApply(repo, { commit: true, ifOkf: true });
    expect(skip.verdict).toBe("legacy-skip");
    expect(read(repo, "3_decision/2026-07-01-pick-x.md")).toBe(before);
  });

  test("--commit yields a conformant bundle, and a second pass changes nothing", () => {
    const repo = legacyWiki();
    const r = okfApply(repo, { commit: true });
    expect(r.verdict).toBe("applied");
    expect(r.changes["yaml-repaired"]).toBe(1);
    expect(isOkfBundle(repo)).toBe(true);

    const report = checkBundle(join(repo, "docs", "wiki"));
    expect(report.okfVersion).toBe("0.2");
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.conformant).toBe(report.concepts);
    expect(report.brokenEdges).toBe(0);
    expect(report.edges).toBeGreaterThanOrEqual(3);

    // Frontmatter: type replaces domain, sources replace source, generated replaces updated.
    const pick = fm(repo, "3_decision/2026-07-01-pick-x.md");
    expect(pick.type).toBe("Decision");
    expect(pick.title).toBe('"X"를 고른다: 이유');
    expect(pick.status).toBe("deprecated");
    expect(pick.superseded_by).toBe("3_decision/2026-08-01-pick-y.md");
    expect(pick.domain).toBeUndefined();
    expect(pick.source).toBeUndefined();
    expect(pick.sources).toEqual([{ id: "1", resource: "s1.jsonl" }]);
    expect(pick.generated).toEqual({ by: "llmwiki/legacy", at: expect.stringMatching(/^2026-07-01T00:00:00[+-]\d\d:\d\d$/) });
    expect(read(repo, "3_decision/2026-07-01-pick-x.md")).toContain("관련 [X topic](../5_topic/x-topic.md).");
    expect(read(repo, "3_decision/2026-07-01-pick-x.md")).toContain('    > [2026-07-01 10:00 user] "x로 하자"');
    expect(fm(repo, "5_topic/x-topic.md").type).toBe("Topic");
    expect(fm(repo, "current-state.md").type).toBe("Current State");
    expect(fm(repo, "current-state.md").updated).toBeUndefined();

    // Trust: a confirmed direction is human-reviewed by whoever added it; the unattended pass's
    // strong-model VERIFY is a machine confirmation; everything else stays unverified.
    expect(fm(repo, "1_direction/2026-07-11-autonomy.md").verified).toEqual({ by: "human:kim", at: expect.any(String) });
    expect(fm(repo, "4_insight/2026-07-02-gotcha.md").verified).toEqual({ by: "process:llmwiki-autoupdate-verify", at: expect.any(String) });
    expect(fm(repo, "5_topic/x-topic.md").verified).toBeUndefined();

    // Reserved files.
    const log = read(repo, "log.md");
    expect(log.startsWith("---\ntype: Log\ntitle: Log\n")).toBe(true);
    expect(log).toContain("\n# Log\n\n## ");
    expect(checkLog("log.md", log)).toEqual([]);
    expect(log.indexOf("## 2026-07-11")).toBeLessThan(log.indexOf("## 2026-07-02"));
    expect(log).toContain("  - pages: [운영 자율성](1_direction/2026-07-11-autonomy.md)");
    expect(existsSync(join(repo, "docs", "wiki", "cold-index.md"))).toBe(false);
    expect(read(repo, "index.md")).toContain("* [3_decision](3_decision/index.md)");
    expect(read(repo, "3_decision/index.md")).toBe('# Decision\n\n* ["X"를 고른다: 이유](2026-07-01-pick-x.md) - d\n');
    expect(readFileSync(join(repo, ".gitattributes"), "utf-8")).toContain("docs/wiki/**/index.md merge=union");

    // The engine still reads its own semantics off the OKF spelling.
    const meta = parseFrontmatter(read(repo, "3_decision/2026-07-01-pick-x.md"));
    expect(meta.status).toBe("superseded");
    expect(meta.date).toBe("2026-07-01");
    expect(parseFrontmatter(read(repo, "current-state.md")).date).toBe("2026-08-18");

    expect(okfApply(repo, { commit: true }).verdict).toBe("conforms");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "okf");
    expect(okfApply(repo, { commit: true, ifOkf: true }).verdict).toBe("conforms");
  });

  test("close-out pass: a body edit re-stamps generated.at; a frontmatter-only edit does not", () => {
    const repo = legacyWiki();
    okfApply(repo, { commit: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "okf");

    const rel = "4_insight/2026-07-02-gotcha.md";
    const path = join(repo, "docs", "wiki", rel);
    writeFileSync(path, read(repo, rel).replace("- 함정.[^1]", "- 함정.[^1] 새 사실.[^s9]\n\n[^s9]: s9.jsonl"));
    const later = new Date("2026-10-13T05:00:00Z");
    utimesSync(path, later, later);
    const touched = "5_topic/x-topic.md";
    writeFileSync(join(repo, "docs", "wiki", touched), read(repo, touched).replace("tags: [a, b]", "tags: [a, b, c]"));

    const r = okfApply(repo, { commit: true, ifOkf: true, actor: "claude-code/opus" });
    expect(r.verdict).toBe("applied");
    const g = fm(repo, rel).generated as { by: string; at: string };
    expect(g.at).not.toMatch(/^2026-07-02/);
    expect(Date.parse(g.at)).toBe(later.getTime());
    expect(fm(repo, rel).sources).toEqual([
      { id: "1", resource: "s2.jsonl" },
      { id: "s9", resource: "s9.jsonl" },
    ]);
    expect((fm(repo, touched).generated as { at: string }).at).toMatch(/^2026-07-03/);
  });
});

describe("fresh wikis start as OKF bundles", () => {
  test("skeleton is conformant; appendLog writes the OKF form", () => {
    const repo = mkdtempSync(join(tmpdir(), "llmwiki-okf-fresh-"));
    tmps.push(repo);
    ensureSkeleton(repo);
    expect(isOkfBundle(repo)).toBe(true);
    appendLog(repo, "update", "first session", ["pages: none"], "2026-10-13");
    appendLog(repo, "quiz", "3 asked", [], "2026-10-13");
    const log = read(repo, "log.md");
    expect(log).toContain("## 2026-10-13\n\n* **Quiz**: 3 asked\n* **Update**: first session\n  - pages: none\n");
    const report = checkBundle(join(repo, "docs", "wiki"));
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.concepts).toBe(2);
    expect(report.types).toEqual({ "Current State": 1, Overview: 1 });
  });

  test("a legacy log keeps its append-only form until converted", () => {
    const repo = legacyWiki();
    appendLog(repo, "update", "later", ["x"], "2026-10-13");
    expect(read(repo, "log.md").trimEnd().endsWith("## [2026-10-13] update | later\n- x")).toBe(true);
  });

  test("the indexer never indexes index.md and keeps listings current on an OKF bundle", () => {
    const repo = legacyWiki();
    okfApply(repo, { commit: true });
    write(repo, "2_milestone/2026-10-13-new.md", "---\ntype: Milestone\ntitle: New\ndescription: fresh\ndate: 2026-10-13\ntags: [a, b]\n---\n\n- x\n");
    const idx = new WikiIndex(repo);
    idx.indexAll();
    const conn = idx.connect();
    const paths = (conn.query("SELECT relative_path FROM documents").all() as { relative_path: string }[]).map((r) => r.relative_path);
    conn.close();
    expect(paths.some((p) => p.endsWith("index.md"))).toBe(false);
    expect(read(repo, "2_milestone/index.md")).toBe("# Milestone\n\n* [New](2026-10-13-new.md) - fresh\n");
    expect(read(repo, "index.md")).toContain("* [2_milestone](2_milestone/index.md)");
    expect(existsSync(join(repo, "docs", "wiki", "cold-index.md"))).toBe(false);
  });
});

describe("reading a foreign OKF bundle", () => {
  test("permissive conformance: unknown types, bare verified, deprecated, broken links", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-okf-foreign-"));
    tmps.push(dir);
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    put("index.md", "# Subdirectories\n\n* [metrics](metrics/index.md) - numbers\n");
    put("metrics/revenue.md", "---\ntype: Metric\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\nstale_after: 2026-01-01T00:00:00Z\n---\n\nSee [margin](./margin.md) and [missing](../tables/none.md).\n");
    put("metrics/margin.md", "---\ntype: Metric\nstatus: deprecated\nverified:\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n---\n\nOld.\n");
    put("log.md", "# Directory Update Log\n\n## 2026-05-22\n* **Update**: x\n\n## 2026-05-15\n* **Initialization**: y\n");
    const r = checkBundle(dir);
    expect(r.conformant).toBe(2);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.tiers).toEqual({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 1 });
    expect(r.stale).toBe(1);
    expect(r.deprecated).toBe(1);
    expect(r.edges).toBe(2);
    expect(r.brokenEdges).toBe(1);
    expect(r.types).toEqual({ Metric: 2 });
  });
});

test("conversion keeps each page's mtime, so recency rankings survive the rewrite", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-okf-mtime-"));
  tmps.push(repo);
  git(repo, "init", "-q");
  write(repo, "2_milestone/a.md", "---\ntitle: A\ndate: 2026-07-01\ntags: [a, b]\nstatus: ready\ndomain: milestone\n---\n\n- x\n");
  const path = join(repo, "docs", "wiki", "2_milestone", "a.md");
  const old = new Date("2026-07-01T09:00:00Z");
  utimesSync(path, old, old);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  okfApply(repo, { commit: true });
  expect(read(repo, "2_milestone/a.md")).toContain("type: Milestone");
  expect(Math.round(statSync(path).mtimeMs)).toBe(old.getTime());
});

describe("review regressions (bundle)", () => {
  test("a hand-written index.md survives conversion as index-original.md; ` #` titles survive", () => {
    const repo = legacyWiki();
    write(repo, "5_topic/index.md", "---\ntitle: My topics\n---\n\nhand-written map\n");
    write(repo, "2_milestone/2026-07-27-pr.md", "---\ntitle: PR #15 merged\ndescription: branch #3 cleanup\ndate: 2026-07-27\ntags: [a, b]\nstatus: ready\n---\n\n- x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "more");
    expect(okfApply(repo).indexesPreserved).toEqual(["5_topic/index-original.md"]);
    const r = okfApply(repo, { commit: true });
    expect(r.indexesPreserved).toEqual(["5_topic/index-original.md"]);
    expect(read(repo, "5_topic/index-original.md")).toContain("hand-written map");
    expect(fm(repo, "5_topic/index-original.md").type).toBe("Topic");
    expect(read(repo, "5_topic/index.md")).toContain("* [My topics](index-original.md)");
    expect(fm(repo, "2_milestone/2026-07-27-pr.md").title).toBe("PR #15 merged");
    expect(fm(repo, "2_milestone/2026-07-27-pr.md").description).toBe("branch #3 cleanup");
  });

  test("re-stamping a body edit names the current writer; a future stamp is pulled back", () => {
    const repo = legacyWiki();
    okfApply(repo, { commit: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "okf");
    const rel = "4_insight/2026-07-02-gotcha.md";
    const path = join(repo, "docs", "wiki", rel);
    writeFileSync(path, read(repo, rel).replace("- 함정.[^1]", "- 함정 수정.[^1]"));
    const edited = new Date("2026-10-13T05:00:00Z");
    utimesSync(path, edited, edited);
    const topic = "5_topic/x-topic.md";
    writeFileSync(
      join(repo, "docs", "wiki", topic),
      read(repo, topic).replace(/generated: \{[^}]*\}/, "generated: { by: claude-code/opus, at: 2099-01-01T00:00:00Z }"),
    );
    okfApply(repo, { commit: true, ifOkf: true, actor: "codex/gpt" });
    expect(fm(repo, rel).generated).toEqual({ by: "codex/gpt", at: expect.any(String) });
    const topicStamp = fm(repo, topic).generated as { by: string; at: string };
    expect(topicStamp.by).toBe("claude-code/opus");
    expect(Date.parse(topicStamp.at)).toBeLessThan(Date.parse("2099-01-01T00:00:00Z"));
    // Stable afterwards: the second pass changes nothing.
    expect(okfApply(repo, { commit: true, ifOkf: true, actor: "codex/gpt" }).verdict).toBe("conforms");
  });
});

describe("verifier regressions", () => {
  test("a log with no dated group is kept as is, and a second pass is a no-op", () => {
    const repo = legacyWiki();
    okfApply(repo, { commit: true });
    write(repo, "log.md", "# Log\n\nintro\n\n## Notes\n\nkeep me\n");
    const first = okfApply(repo, { commit: true, ifOkf: true });
    expect(first.logKept).toBe(true);
    expect(read(repo, "log.md")).toBe("# Log\n\nintro\n\n## Notes\n\nkeep me\n");
    expect(okfApply(repo, { commit: true, ifOkf: true }).logConverted).toBe(false);
  });

  test("a configured log filename is a reserved log for the bundle check", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-okf-logname-"));
    tmps.push(dir);
    writeFileSync(join(dir, "history.md"), "# Log\n\n## 2026-10-13\n\n* **Update**: x\n");
    writeFileSync(join(dir, "a.md"), "---\ntype: Note\n---\n");
    expect(checkBundle(dir, { logName: "history.md" }).concepts).toBe(1);
    expect(checkBundle(dir).issues.map((i) => i.rule)).toContain("okf-frontmatter-missing");
  });

  test("a wiki inside a git subfolder still sees its body edits", () => {
    const top = mkdtempSync(join(tmpdir(), "llmwiki-okf-mono-"));
    tmps.push(top);
    git(top, "init", "-q");
    const repo = join(top, "packages", "app");
    write(repo, "2_milestone/a.md", "---\ntype: Milestone\ntitle: A\ngenerated: { by: x/1, at: 2026-07-01T00:00:00+09:00 }\n---\n\n- one\n");
    write(repo, "current-state.md", "---\ntype: Current State\ntitle: L0\n---\n\n- now\n");
    git(top, "add", "-A");
    git(top, "commit", "-qm", "init");
    okfApply(repo, { commit: true });
    git(top, "add", "-A");
    git(top, "commit", "-qm", "okf");
    const path = join(repo, "docs", "wiki", "2_milestone", "a.md");
    writeFileSync(path, read(repo, "2_milestone/a.md").replace("- one", "- two"));
    const edited = new Date("2026-10-13T05:00:00Z");
    utimesSync(path, edited, edited);
    okfApply(repo, { commit: true, ifOkf: true, actor: "y/2" });
    expect(fm(repo, "2_milestone/a.md").generated).toEqual({ by: "y/2", at: expect.any(String) });
    expect(Date.parse((fm(repo, "2_milestone/a.md").generated as { at: string }).at)).toBe(edited.getTime());
  });
});
