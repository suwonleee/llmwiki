// OKF v0.2 helpers: the frontmatter, link, index and log forms every wiki page is written in.
import { describe, expect, test } from "bun:test";
import {
  checkConcept,
  checkIndex,
  checkLog,
  convertWikilinks,
  declaredOkfVersion,
  footnoteDefinitions,
  insertLogEntry,
  isIsoDateTime,
  isLegacyLog,
  isStale,
  isoFromDate,
  linkLabel,
  linkTextOnly,
  mergeSources,
  normalizeVerified,
  okfStatus,
  parseLegacyBlock,
  logContentLines,
  logIntro,
  parseLog,
  parseYamlBlock,
  relativeHref,
  renderDocument,
  renderIndex,
  renderLog,
  renderYaml,
  splitFrontmatter,
  trustTier,
  typeNameFor,
} from "../src/engine/okf.ts";

describe("frontmatter YAML", () => {
  test("a runtime without YAML cannot silently certify or convert a bundle", () => {
    const runtime = Bun as unknown as { YAML: unknown };
    const previous = runtime.YAML;
    try {
      runtime.YAML = undefined;
      expect(() => parseYamlBlock("type: Decision\ntitle: a: b")).toThrow("Bun 1.2.21 or newer");
    } finally {
      runtime.YAML = previous;
    }
  });
  test("parses OKF nested fields and keeps timestamps as text", () => {
    const { data, error } = parseYamlBlock(
      "type: Decision\ngenerated: { by: claude-code/opus, at: 2026-10-13T14:00:00+09:00 }\n" +
        "sources:\n  - { id: s1, resource: a.jsonl }\ndate: 2026-10-13",
    );
    expect(error).toBeNull();
    expect(data.generated).toEqual({ by: "claude-code/opus", at: "2026-10-13T14:00:00+09:00" });
    expect(data.sources).toEqual([{ id: "s1", resource: "a.jsonl" }]);
    expect(data.date).toBe("2026-10-13");
  });

  test("an invalid block reports the error and still yields every value verbatim", () => {
    // Shapes measured in real pre-OKF pages: a quote that does not span the value, a second colon.
    const block = 'title: "PASS 정확도가 높다"는 착각\ndescription: 결론: 이렇다\ntags: [a, b]';
    const { data, error } = parseYamlBlock(block);
    expect(error).not.toBeNull();
    expect(data.title).toBe('"PASS 정확도가 높다"는 착각');
    expect(data.description).toBe("결론: 이렇다");
    expect(data.tags).toEqual(["a", "b"]);
  });

  test("the legacy reader handles block lists of mappings", () => {
    const data = parseLegacyBlock("sources:\n  - id: s1\n    resource: a.jsonl\n  - id: s2\n    resource: b.md\ntags:\n  - x\n  - y");
    expect(data.sources).toEqual([
      { id: "s1", resource: "a.jsonl" },
      { id: "s2", resource: "b.md" },
    ]);
    expect(data.tags).toEqual(["x", "y"]);
  });

  test("rendered YAML round-trips through a strict parser, values that need quoting included", () => {
    const data = {
      title: '"PASS"는 착각: 정정',
      type: "Insight",
      tags: ["a,b", "yes", "2026"],
      status: "stable",
      generated: { by: "llmwiki/legacy", at: "2026-07-11T00:00:00+09:00" },
      sources: [{ id: "1", resource: "x.jsonl" }],
      superseded_by: "3_decision/new.md",
    };
    const yaml = renderYaml(data);
    expect(yaml.split("\n")[0]).toBe("type: Insight"); // OKF core keys lead
    expect(yaml.split("\n").at(-2)).toBe("sources:");
    const back = parseYamlBlock(yaml);
    expect(back.error).toBeNull();
    expect(back.data).toEqual(data);
  });

  test("splitFrontmatter separates block and body, CRLF included", () => {
    expect(splitFrontmatter("---\r\ntitle: x\r\n---\r\nbody")).toEqual({ block: "title: x", body: "body" });
    expect(splitFrontmatter("no frontmatter")).toEqual({ block: null, body: "no frontmatter" });
    expect(renderDocument({ type: "Note" }, "\n# H\n")).toBe("---\ntype: Note\n---\n\n# H\n");
  });
});

describe("types, lifecycle, trust", () => {
  test("type names and status synonyms", () => {
    expect(typeNameFor("direction")).toBe("Direction");
    expect(typeNameFor("current-state")).toBe("Current State");
    expect(okfStatus("ready")).toBe("stable");
    expect(okfStatus("superseded")).toBe("deprecated");
    expect(okfStatus("pending")).toBe("draft");
    expect(okfStatus("executed-f1")).toBeNull();
  });

  test("timestamps carry an explicit offset", () => {
    expect(isIsoDateTime("2026-06-30T14:00:00Z")).toBe(true);
    expect(isIsoDateTime("2026-06-30T14:00:00+09:00")).toBe(true);
    expect(isIsoDateTime("2026-06-30T14:00:00")).toBe(false);
    expect(isIsoDateTime("2026-06-30")).toBe(false);
    expect(isoFromDate("2026-02-30")).toBeNull();
    expect(isIsoDateTime(isoFromDate("2026-06-30"))).toBe(true);
  });

  test("trust tiers follow §5.3, a bare verified mapping is a one-element list", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: { by: "process:nightly", at: "2026-01-01T00:00:00Z" } })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "process:n" }, { by: "human:kim" }] })).toBe("human-reviewed");
    expect(normalizeVerified({ by: "human:kim", at: "2026-01-01T00:00:00Z" })).toHaveLength(1);
  });

  test("stale_after is a plain comparison; an offset-less value is never stale", () => {
    const now = new Date("2026-10-13T00:00:00Z");
    expect(isStale({ stale_after: "2026-10-01T00:00:00Z" }, now)).toBe(true);
    expect(isStale({ stale_after: "2026-12-01T00:00:00Z" }, now)).toBe(false);
    expect(isStale({ stale_after: "2026-10-01" }, now)).toBe(false);
  });
});

describe("sources keyed to footnotes", () => {
  const body = "Claim.[^s1] Other.[^2]\n\n[^s1]: abc.jsonl\n    > [2026-10-13 10:00 user] \"quote\"\n[^2]: src/x.ts:12\n\n```\n[^fake]: not.md\n```\n";

  test("footnote definitions outside code, locators dropped", () => {
    expect(footnoteDefinitions(body)).toEqual([
      { id: "s1", resource: "abc.jsonl" },
      { id: "2", resource: "src/x.ts:12" },
    ]);
  });

  test("merge keeps declared sources, adds missing labels, folds a legacy source", () => {
    const merged = mergeSources([{ id: "s1", resource: "abc.jsonl", title: "Session" }], body, "semantic-lint");
    expect(merged).toEqual([
      { id: "s1", resource: "abc.jsonl", title: "Session" },
      { id: "2", resource: "src/x.ts:12" },
      { resource: "semantic-lint" },
    ]);
    // A legacy source already named by a footnote is not duplicated.
    expect(mergeSources(undefined, body, "abc.jsonl")).toHaveLength(2);
  });
});

describe("links", () => {
  const pages: Record<string, string> = {
    "5_topic/언어-설정.md": "언어 설정 — 세션 언어를 따른다",
    "3_decision/2026-07-11-x.md": "X 결정",
    "log.md": "Log",
  };
  const resolve = (t: string) => {
    const k = t.replace(/\.md$/, "");
    const rel = Object.keys(pages).find((p) => p.replace(/\.md$/, "") === k || p.endsWith(`/${k}.md`));
    return rel ? { rel, title: pages[rel]! } : null;
  };

  test("wikilinks become relative markdown links; code and unknown targets are untouched", () => {
    const body = "See [[5_topic/언어-설정]] and [[2026-07-11-x|the call]] and [[log.md]].\n`[[5_topic/언어-설정]]` [[nowhere]]\n";
    const r = convertWikilinks(body, "3_decision/a.md", resolve);
    expect(r.body).toBe(
      "See [언어 설정](../5_topic/언어-설정.md) and [the call](2026-07-11-x.md) and [Log](../log.md).\n`[[5_topic/언어-설정]]` [[nowhere]]\n",
    );
    expect(r.converted).toBe(3);
    expect(r.unresolved).toEqual(["nowhere"]);
  });

  test("heading anchors, labels and hrefs", () => {
    const r = convertWikilinks("[[5_topic/언어-설정#Why It Matters]]", "current-state.md", resolve);
    expect(r.body).toBe("[언어 설정](5_topic/언어-설정.md#why-it-matters)");
    expect(linkLabel("운영 자율성 — 판단불가 영역만")).toBe("운영 자율성");
    expect(relativeHref("1_direction/a.md", "1_direction/b c.md")).toBe("b%20c.md");
  });
});

describe("reserved files", () => {
  test("index.md renders §8 sections, root declares okf_version", () => {
    const text = renderIndex(
      [
        { heading: "Decision", entries: [{ title: "A [x]", href: "a.md", description: "one\nline" }] },
        { heading: "Empty", entries: [] },
      ],
      true,
    );
    expect(text).toBe('---\nokf_version: "0.2"\n---\n\n# Decision\n\n* [A \\[x\\]](a.md) - one line\n');
    expect(declaredOkfVersion(text)).toBe("0.2");
    expect(checkIndex("index.md", text, true)).toEqual([]);
    expect(checkIndex("3_decision/index.md", text, false).map((i) => i.rule)).toEqual(["okf-index-frontmatter"]);
  });

  test("a legacy log converts to dated groups, newest first, details kept", () => {
    const legacy =
      "---\ntitle: Log\n---\n\nappend-only.\n\n## [2026-06-18] update | first\n- a\n\n## [2026-06-20] autoupdate | second\n" +
      "- rejected — verify failed:\n\n- **TL;DR**: nested bold\n\n## [2026-06-18] update | third\n";
    expect(isLegacyLog(legacy)).toBe(true);
    const entries = parseLog(legacy);
    expect(entries.map((e) => e.title)).toEqual(["first", "second", "third"]);
    expect(entries[1]!.detail).toEqual(["- rejected — verify failed:", "- **TL;DR**: nested bold"]);
    const okf = renderLog(entries, "Log", "History.");
    expect(okf).toBe(
      "---\ntype: Log\ntitle: Log\ndescription: History.\n---\n\n# Log\n\n## 2026-06-20\n\n* **Autoupdate**: second\n  - rejected — verify failed:\n  - **TL;DR**: nested bold\n\n" +
        "## 2026-06-18\n\n* **Update**: third\n* **Update**: first\n  - a\n",
    );
    expect(checkLog("log.md", okf)).toEqual([]);
    expect(parseLog(okf).map((e) => e.title)).toEqual(["second", "third", "first"]);
    expect(checkLog("log.md", legacy).map((i) => i.rule)).toEqual(["okf-log-content"]);
  });

  test("an entry lands under today's group, or opens a new group on top", () => {
    const H = "---\ntype: Log\ntitle: Log\ndescription: History.\n---\n\n# Log\n\n";
    const base = H + "## 2026-10-12\n\n* **Update**: old\n";
    const same = insertLogEntry(base.replace("2026-10-12", "2026-10-13"), { date: "2026-10-13", kind: "update", title: "new", detail: ["- d"] }, "Log", "History.");
    expect(same).toBe(H + "## 2026-10-13\n\n* **Update**: new\n  - d\n* **Update**: old\n");
    const next = insertLogEntry(base, { date: "2026-10-13", kind: "quiz", title: "q", detail: [] }, "Log", "History.");
    expect(next).toBe(H + "## 2026-10-13\n\n* **Quiz**: q\n\n## 2026-10-12\n\n* **Update**: old\n");
    expect(checkLog("log.md", next)).toEqual([]);
    const fresh = insertLogEntry(H, { date: "2026-10-13", kind: "update", title: "t", detail: [] }, "Log", "History.");
    expect(fresh).toBe(H + "## 2026-10-13\n\n* **Update**: t\n");
    });

  test("an intro in the body is not §9; it moves to frontmatter description", () => {
    const old = "# Log\n\nHistory.\n\n## 2026-10-12\n\n* **Update**: old\n";
    expect(checkLog("log.md", old).map((i) => i.rule)).toEqual(["okf-log-content"]);
    expect(logIntro(old)).toBe("History.");
    const okf = renderLog(parseLog(old), "Log", logIntro(old));
    expect(okf).toBe("---\ntype: Log\ntitle: Log\ndescription: History.\n---\n\n# Log\n\n## 2026-10-12\n\n* **Update**: old\n");
    expect(checkLog("log.md", okf)).toEqual([]);
    expect(logIntro(okf)).toBe("History.");
    expect(renderLog(parseLog(okf), "Log", logIntro(okf))).toBe(okf);
});
});

describe("concept conformance", () => {
  test("a minimal concept is conformant; soft guidance stays warnings", () => {
    expect(checkConcept("a.md", "---\ntype: Note\n---\nbody")).toEqual([]);
    const issues = checkConcept(
      "b.md",
      "---\ntype: Note\nstatus: ready\ngenerated: { by: x, at: 2026-01-01 }\n---\nClaim.[^1] [[old]]\n\n[^1]: a.jsonl\n",
    );
    expect(issues.map((i) => `${i.severity}:${i.rule}`).sort()).toEqual([
      "warn:okf-footnote-source",
      "warn:okf-status",
      "warn:okf-timestamp",
      "warn:okf-wikilink",
    ]);
  });

  test("missing frontmatter, invalid YAML and a missing type are errors", () => {
    expect(checkConcept("a.md", "# no fm").map((i) => i.rule)).toEqual(["okf-frontmatter-missing"]);
    expect(checkConcept("b.md", "---\ntitle: a: b\n---\n").map((i) => i.rule)).toEqual(["okf-frontmatter-invalid", "okf-type-missing"]);
  });
});

test("linkTextOnly measures prose as read: links count as their text", () => {
  expect(linkTextOnly("a [\\[T\\] x](../5_topic/y.md) · [b](c.md) ![img](p.png)")).toBe("a \\[T\\] x · b ![img](p.png)");
});

describe("review regressions", () => {
  test("an unquoted ` #` in free text is kept, not read as a YAML comment", () => {
    expect(parseYamlBlock("title: #2 false-PASS 원인").data.title).toBe("#2 false-PASS 원인");
    const { data } = parseYamlBlock("title: PR #15 merged\ndescription: 공백 #정리\nstatus: ready # note");
    expect(data.title).toBe("PR #15 merged");
    expect(data.description).toBe("공백 #정리");
    expect(data.status).toBe("ready");
    expect(parseYamlBlock(renderYaml(data)).data).toEqual(data);
  });

  test("values a YAML 1.1 reader would turn into numbers stay quoted", () => {
    expect(renderYaml({ a: "9:30", b: "0b11", c: "=", d: "0o17" })).toBe('a: "9:30"\nb: "0b11"\nc: "="\nd: "0o17"');
  });

  test("a log re-render keeps lines under unknown headings and an OKF day's order", () => {
    const text = "# Log\n\nIntro.\n\n## 2026-10-13\n\n* **Update**: newest\n* **Update**: older\n\n## Notes\n\n- keep me\n";
    const entries = parseLog(text);
    expect(entries.map((e) => e.title)).toEqual(["newest", "older", "Notes"]);
    const out = renderLog(entries, "Log", "Intro.");
    expect(out.indexOf("newest")).toBeLessThan(out.indexOf("older"));
    expect(out).toContain("- keep me");
    expect(logContentLines(out)).toBeGreaterThanOrEqual(logContentLines(text));
  });

  test("duplicate date groups from a union merge are flagged", () => {
    const merged = "# Log\n\n## 2026-10-13\n\n* **Update**: a\n\n## 2026-10-13\n\n* **Update**: b\n";
    expect(checkLog("log.md", merged).map((i) => i.rule)).toEqual(["okf-log-duplicate-date"]);
  });
});
