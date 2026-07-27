// autoupdate._category maps a page's declared `domain:` frontmatter to a category folder using
// the RESOLVED config. Pure (no LLM) — the config is injected directly, mirroring how updateOne
// passes its per-repo cfg. Locks: frontmatter extraction, custom-config routing, unknown/missing
// domain fallback (first review:"model" category), and stock routing preserved.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _category, _lintCandidate } from "../src/engine/autoupdate.ts";
import { defaults, loadFrom, type WikiConfig } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";

function customCfg(): WikiConfig {
  const p = join(mkdtempSync(join(tmpdir(), "llmwiki-cat-cfg-")), "llmwiki.config.toml");
  writeFileSync(
    p,
    `[[category]]
dir = "1_goal"
domain = "goal"
review = "human"
guide = "goal"
[[category]]
dir = "2_lesson"
domain = "lesson"
review = "model"
guide = "lesson"
`,
    "utf-8",
  );
  return loadFrom(p);
}
const page = (domain?: string) =>
  `---\ntitle: T\ndescription: d\ndate: 2026-07-08\ntags: [a, b]\nstatus: ready\n${domain ? `domain: ${domain}\n` : ""}source: x.jsonl\n---\n\nbody [^1]\n\n[^1]: x.jsonl\n`;

test("_category routes a page's domain to the custom config's folder", () => {
  const c = customCfg();
  expect(_category(page("goal"), c)).toBe("1_goal");
  expect(_category(page("lesson"), c)).toBe("2_lesson");
});

test("_category falls back to the first review:'model' category for unknown/missing domain", () => {
  const c = customCfg();
  expect(_category(page("nonsense"), c)).toBe("2_lesson"); // unknown domain
  expect(_category(page(undefined), c)).toBe("2_lesson"); // no domain: line at all
});

test("_category preserves the historical routing under the stock config", () => {
  const c = defaults();
  expect(_category(page("direction"), c)).toBe("1_direction");
  expect(_category(page("decision"), c)).toBe("3_decision");
  expect(_category(page("milestone"), c)).toBe("2_milestone");
  expect(_category(page(undefined), c)).toBe("2_milestone"); // fallback = 2_milestone
});

test("direction candidates receive ordinary lint without ever being written to the repo", () => {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-direction-lint-"));
  try {
    const idx = new WikiIndex(root);
    idx.init();
    const relative = "docs/wiki/1_direction/2026-07-25-unsafe.md";
    const candidate =
      "---\ndescription: missing a title\ndate: 2026-07-25\ntags: [a, b]\nstatus: ready\ndomain: direction\nsource: note.jsonl\n---\n\n## TL;DR\n\nA direction draft.\n";

    const issues = _lintCandidate(idx, defaults(), relative, candidate);

    expect(issues.some((issue) => issue.severity === "error" && issue.code === "missing-title")).toBe(true);
    expect(existsSync(join(root, relative))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
