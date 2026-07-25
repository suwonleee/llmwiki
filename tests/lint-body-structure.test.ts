// Advisory checks for the page-body shape a human actually scans.
//
// Real pages drifted into two habits that read fine to a model and badly to a person: a flat wall
// of twenty `-` lines with no grouping, and one line that crams a whole enumeration behind `·`
// separators. Both are ADVISORY — never an error, never a blocked close-out — but they have to be
// visible, or the format contract is only aspirational.
//
// Small pages get no ceremony: a handful of bullets with no section heading is correct.
// Language-neutral: numbers and dashes carry the structure, so ko/en/zh behave identically.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { Linter } from "../src/engine/lint.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";
import { defaults } from "../src/engine/config.ts";

function lintPage(body: string): { codes: string[]; severities: string[] } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-body-structure-"));
  try {
    const dir = join(root, "docs", "wiki", "3_decision");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8"); // the cited source exists
    writeFileSync(
      join(dir, "page.md"),
      `---\ntitle: A page\ndescription: fixture\ndate: 2026-07-25\ntags: [fixture, structure]\nstatus: ready\ndomain: decision\nsource: probe.jsonl\n---\n\n${body}`,
      "utf8",
    );
    const w = new WikiIndex(root);
    w.indexAll();
    rebuildReferenceGraph(w); // what `llmwiki index` does — materialize the citation graph
    const conn = w.connect();
    try {
      const [issues] = new Linter(w as any, conn, defaults()).run("*", "all");
      const mine = issues.filter((i) => i.path.includes("3_decision/page.md"));
      return { codes: mine.map((i) => i.code), severities: mine.map((i) => i.severity) };
    } finally {
      conn.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const bullets = (n: number, prefix = "a concrete claim") =>
  Array.from({ length: n }, (_, i) => `- ${prefix} ${i + 1} [^1]`).join("\n");
const FOOTNOTE = "\n\n[^1]: src/a.ts\n";

describe("body structure advisories", () => {
  test("a flat page at or past the contract's threshold is flagged", () => {
    expect(lintPage(`TL;DR — one line.\n\n${bullets(6)}${FOOTNOTE}`).codes).toContain("flat-body");
    const { codes, severities } = lintPage(`TL;DR — one line.\n\n${bullets(12)}${FOOTNOTE}`);
    expect(codes).toContain("flat-body");
    expect(severities.every((s) => s !== "error")).toBe(true); // advisory only
  });

  test("the same content grouped under numbered sections is not flagged", () => {
    const body = [
      "TL;DR — one line.",
      "",
      "## 1. First group",
      "",
      bullets(6),
      "",
      "## 2. Second group",
      "",
      "- a claim [^1]",
      "    - a supporting detail",
      "        - a deeper detail",
      "",
      "### 2-1. A split of the second group",
      "",
      bullets(5),
    ].join("\n");
    expect(lintPage(body + FOOTNOTE).codes).not.toContain("flat-body");
  });

  test("a short page needs no sections at all", () => {
    expect(lintPage(`TL;DR — one line.\n\n${bullets(3)}${FOOTNOTE}`).codes).not.toContain("flat-body");
    expect(lintPage(`TL;DR — one line.\n\n${bullets(5)}${FOOTNOTE}`).codes).not.toContain("flat-body"); // just under the contract's 6
  });

  test("a bullet that crams an enumeration behind separators is flagged", () => {
    const crammed =
      "- stack: Coroutines·kotlinx.serialization·MapStruct·Redisson·Bucket4j·SQS·Kafka·JJWT·scrypt·KMS·FCM·APNs·Datadog·Prometheus [^1]";
    const { codes, severities } = lintPage(`TL;DR — one line.\n\n${crammed}${FOOTNOTE}`);
    expect(codes).toContain("dense-bullet");
    expect(severities.every((s) => s !== "error")).toBe(true);
  });

  // Regression from real use: a child bullet holding a few SHORT sibling tokens is the shape the
  // contract wants, and flagging it pushed toward five needless nested lines.
  test("a compact list of short sibling tokens on one child line is not flagged", () => {
    const compact = ["- persistence — contents family [^1]", "    - `contents` · `epub` · `illust` · `emoticon` · `vod`"].join("\n");
    expect(lintPage(`TL;DR — one line.\n\n${compact}${FOOTNOTE}`).codes).not.toContain("dense-bullet");
  });

  test("the same enumeration promoted to child bullets is not flagged", () => {
    const promoted = [
      "- stack [^1]",
      "    - language: Coroutines · kotlinx.serialization",
      "    - cache: Redisson · Bucket4j",
      "    - messaging: SQS · Kafka",
    ].join("\n");
    expect(lintPage(`TL;DR — one line.\n\n${promoted}${FOOTNOTE}`).codes).not.toContain("dense-bullet");
  });

  test("the advisories read the structure, not the language", () => {
    const koFlat = lintPage(`TL;DR — 한 줄.\n\n${bullets(12, "구체적인 사실")}${FOOTNOTE}`);
    const zhFlat = lintPage(`TL;DR — 一行。\n\n${bullets(12, "具体事实")}${FOOTNOTE}`);
    expect(koFlat.codes).toContain("flat-body");
    expect(zhFlat.codes).toContain("flat-body");

    const koSectioned = `TL;DR — 한 줄.\n\n## 1. 첫 묶음\n\n${bullets(6, "구체적인 사실")}\n\n## 2. 둘째 묶음\n\n${bullets(6, "구체적인 사실")}${FOOTNOTE}`;
    const zhSectioned = `TL;DR — 一行。\n\n## 1. 第一组\n\n${bullets(6, "具体事实")}\n\n## 2. 第二组\n\n${bullets(6, "具体事实")}${FOOTNOTE}`;
    expect(lintPage(koSectioned).codes).not.toContain("flat-body");
    expect(lintPage(zhSectioned).codes).not.toContain("flat-body");
  });
});
