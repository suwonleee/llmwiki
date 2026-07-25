// User-visible engine text must follow the WIKI's language, not the author's.
//
// Four surfaces were Korean-only regardless of `lang`: the pointer written into `overview.md`,
// the entry appended to `log.md` after a review, and three skip reasons printed on the terminal.
// On an English wiki that is Korean prose committed into someone else's repository, so each
// surface is pinned per language here. Cross-language idempotency matters too: an existing
// Korean wiki must not be rewritten into English just because the reader's shell says `en`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECENT_POINTER_EN, RECENT_POINTER_KO, normalizeOverview, normalizeOverviewText } from "../src/engine/overview.ts";
import { parseQueue, refreshGapQueue, renderQueue } from "../src/engine/gaps.ts";
import { _reviewLogEntry, review } from "../src/engine/review.ts";
import { _resetForTests } from "../src/engine/config.ts";

const HANGUL = /[가-힣]/;
const ROOT = join(import.meta.dir, "..");
const roots: string[] = [];
let langBefore: string | undefined;

function mkRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-output-lang-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "wiki", "0_review"), { recursive: true });
  return root;
}

function withLang(lang: string): void {
  process.env.LLMWIKI_LANG = lang;
  _resetForTests();
}

const BLOATED_OVERVIEW = [
  "---",
  "title: Overview",
  "---",
  "",
  "## Recent Updates",
  "- 2026-07-01 — one long session paragraph",
  "- 2026-06-30 — another long session paragraph",
  "",
].join("\n");

beforeEach(() => {
  langBefore = process.env.LLMWIKI_LANG;
});

afterEach(() => {
  if (langBefore === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = langBefore;
  _resetForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engine output follows the wiki language", () => {
  test("the overview pointer is written in the wiki's language", () => {
    const en = normalizeOverviewText(BLOATED_OVERVIEW, "en");
    expect(en.collapsed).toBe(true);
    expect(en.text).toContain(RECENT_POINTER_EN);
    expect(en.text).not.toMatch(HANGUL);

    const ko = normalizeOverviewText(BLOATED_OVERVIEW, "ko");
    expect(ko.collapsed).toBe(true);
    expect(ko.text).toContain(RECENT_POINTER_KO);
  });

  test("either language's canonical pointer counts as normalized — no cross-language churn", () => {
    const koPage = `---\ntitle: Overview\n---\n\n## Recent Updates\n\n${RECENT_POINTER_KO}\n`;
    const enPage = `---\ntitle: Overview\n---\n\n## Recent Updates\n\n${RECENT_POINTER_EN}\n`;
    expect(normalizeOverviewText(koPage, "en").collapsed).toBe(false);
    expect(normalizeOverviewText(koPage, "en").text).toBe(koPage);
    expect(normalizeOverviewText(enPage, "ko").collapsed).toBe(false);
    expect(normalizeOverviewText(enPage, "ko").text).toBe(enPage);
  });

  test("the missing-overview skip reason follows the wiki language", () => {
    const root = mkRepo();
    withLang("en");
    const en = normalizeOverview(root);
    expect(en.verdict).toBe("skip");
    expect(en.reason ?? "").not.toMatch(HANGUL);

    withLang("ko");
    expect(normalizeOverview(root).reason ?? "").toMatch(HANGUL);
  });

  test("the gap-queue skip reason follows the wiki language", () => {
    const root = mkRepo();
    withLang("en");
    const en = refreshGapQueue(root, "2026-07-25");
    expect(en.verdict).toBe("skip");
    expect(en.reason ?? "").not.toMatch(HANGUL);

    withLang("ko");
    expect(refreshGapQueue(root, "2026-07-25").reason ?? "").toMatch(HANGUL);
  });

  test("the too-few-pages review skip reason follows the wiki language", async () => {
    const root = mkRepo();
    withLang("en");
    const en = await review(root, { date: "2026-07-25" });
    expect(en.verdict).toBe("skip");
    expect(String(en.reason ?? "")).not.toMatch(HANGUL);

    withLang("ko");
    const ko = await review(root, { date: "2026-07-25" });
    expect(String(ko.reason ?? "")).toMatch(HANGUL);
  });

  test("the generated gap queue page follows the wiki language and still parses", () => {
    const gap = {
      hash: "abc123",
      type: "missing-concept" as const,
      text: "amount parsing has no page of its own",
      status: "open" as const,
      absent: 0,
      firstSeen: "2026-07-25",
      lastSeen: "2026-07-25",
    };
    const en = renderQueue([gap], "2026-07-25", "en");
    expect(en).not.toMatch(HANGUL);
    expect(en).toContain("## Open (1)");
    // the header language must never break the machine-managed rows
    expect(parseQueue(en).map((g) => g.hash)).toEqual(["abc123"]);

    const ko = renderQueue([gap], "2026-07-25", "ko");
    expect(ko).toMatch(HANGUL);
    expect(parseQueue(ko).map((g) => g.hash)).toEqual(["abc123"]);
  });

  test("the review entry appended to log.md follows the wiki language", () => {
    const dest = "docs/wiki/0_review/semantic-review-2026-07-25.md";
    expect(_reviewLogEntry(dest, 3, 9, true, false).join("\n")).not.toMatch(HANGUL);
    expect(_reviewLogEntry(dest, 9, 9, false, false).join("\n")).not.toMatch(HANGUL);
    expect(_reviewLogEntry(dest, 3, 9, true, true).join("\n")).toMatch(HANGUL);
  });

  test("`overview --normalize` prints no Korean on an English wiki", () => {
    const root = mkRepo();
    writeFileSync(join(root, "docs", "wiki", "overview.md"), BLOATED_OVERVIEW, "utf8");
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", "overview", root, "--normalize"], {
      cwd: ROOT,
      env: { ...process.env, LLMWIKI_LANG: "en" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0);
    expect(output).not.toMatch(HANGUL);
  });
});
