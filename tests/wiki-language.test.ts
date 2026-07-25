// `lang` opens up beyond ko/en — but only where the engine WRITES INTO YOUR REPOSITORY.
//
// Page prose always follows the session's own language (that rule lives in the WRITE prompt and is
// deliberately untouched here). What `lang` controls is the text the engine itself authors: the
// skeleton pages it seeds, the pointer it collapses `overview.md` to, and the headers of the two
// machine-managed ledgers. Those are committed into the user's repo, so a Japanese or Chinese team
// should not find Korean or English scaffolding in their own wiki.
//
// Surfaces that still have only en/ko catalogs (cold-start rules, CLI, lint messages) must fall
// back to ENGLISH for any other language — a half-translated cold-start is worse than a consistent
// English one. An unknown code (`fr`) must also land on English rather than crash.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTests, resolveLang, effectiveKo } from "../src/engine/config.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { recentPointer } from "../src/engine/overview.ts";
import { renderQueue } from "../src/engine/gaps.ts";
import { buildContext } from "../src/engine/context.ts";

const roots: string[] = [];
let langBefore: string | undefined;

function skeletonFor(lang: string): { l0: string; overview: string; log: string } {
  process.env.LLMWIKI_LANG = lang;
  _resetForTests();
  const root = mkdtempSync(join(tmpdir(), `llmwiki-lang-${lang}-`));
  roots.push(root);
  ensureSkeleton(root);
  const read = (name: string) => readFileSync(join(root, "docs", "wiki", name), "utf8");
  return { l0: read("current-state.md"), overview: read("overview.md"), log: read("log.md") };
}

beforeEach(() => {
  langBefore = process.env.LLMWIKI_LANG;
});

afterEach(() => {
  if (langBefore === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = langBefore;
  _resetForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("wiki language resolution", () => {
  test("a language code normalizes to its catalog, unknown codes to English", () => {
    delete process.env.LLMWIKI_LANG; // config-only resolution; the env override is asserted below
    expect(resolveLang({ lang: "ko" })).toBe("ko");
    expect(resolveLang({ lang: "ko-KR" })).toBe("ko");
    expect(resolveLang({ lang: "JA" })).toBe("ja");
    expect(resolveLang({ lang: "zh-Hans" })).toBe("zh");
    expect(resolveLang({ lang: "en" })).toBe("en");
    expect(resolveLang({ lang: "fr" })).toBe("en"); // no catalog → English, never a crash
    expect(resolveLang({ lang: "" })).toBe("en");
  });

  test("the env override still wins over the config, for every language", () => {
    process.env.LLMWIKI_LANG = "zh";
    expect(resolveLang({ lang: "ko" })).toBe("zh");
    expect(effectiveKo({ lang: "ko" } as never)).toBe(false); // the ko/en helper agrees
  });

  test("the seeded skeleton is written in the configured language", () => {
    const ja = skeletonFor("ja");
    expect(ja.l0).toContain("## 方向性");
    expect(ja.l0).toContain("## 現在");
    expect(ja.log).toContain("記録");

    const zh = skeletonFor("zh");
    expect(zh.l0).toContain("## 方向");
    expect(zh.l0).toContain("## 现在");
    expect(zh.log).toContain("记录");

    // and the hierarchy the format contract teaches survives translation
    for (const skeleton of [ja, zh]) {
      expect(skeleton.l0).toMatch(/^- /m);
      expect(skeleton.l0).toMatch(/^    - /m);
    }
  });

  test("an unknown language gets the English skeleton, not a broken one", () => {
    const fr = skeletonFor("fr");
    expect(fr.l0).toContain("## Direction (human-confirmed)");
    expect(fr.l0).toContain("## Now (TL;DR)");
  });

  test("the overview pointer and the gap-queue header follow the same language", () => {
    expect(recentPointer("ja")).toMatch(/[ぁ-んァ-ヶ一-龯]/);
    expect(recentPointer("zh")).toMatch(/[一-龯]/);
    expect(recentPointer("en")).toContain("See [[log.md]]");
    expect(recentPointer("ko")).toContain("세션별 변경 이력");

    const gap = {
      hash: "abc123",
      type: "missing-concept" as const,
      text: "a gap",
      status: "open" as const,
      absent: 0,
      firstSeen: "2026-07-25",
      lastSeen: "2026-07-25",
    };
    for (const lang of ["ja", "zh"] as const) {
      const queue = renderQueue([gap], "2026-07-25", lang);
      expect(queue).toContain("## Open (1)"); // machine-managed headings stay language-invariant
      expect(queue).toMatch(/[ぁ-んァ-ヶ一-龯]/); // the human-facing header is translated
    }
  });

  test("cold-start falls back to English for a language with no rules catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-lang-cold-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
    writeFileSync(join(root, "docs", "wiki", "overview.md"), "---\ntitle: OV\n---\n\nhub\n", "utf8");

    process.env.LLMWIKI_LANG = "zh";
    _resetForTests();
    const out = buildContext(root);

    expect(out).toContain("[llmwiki operating rules]"); // consistent English, not a mix
    expect(out).not.toContain("[llmwiki 운영 규칙]");
  });
});
