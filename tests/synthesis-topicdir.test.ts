// The topic-layer views (buildTopicView materialized list · topicGaps coverage) must key off the
// RESOLVED cfg.topicDir, not a hardcoded "5_topic" — so a team using a custom topic folder gets
// correct materialized-vs-gap accounting. Pure/deterministic (no LLM); the config is resolved via
// a temp clone's configs/ so this exercises the real per-repo resolution path end-to-end.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTopicView, topicGaps } from "../src/engine/synthesis.ts";
import { _resetForTests, CONFIGS_DIR } from "../src/engine/config.ts";

const tmps: string[] = [];
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
function page(title: string, tags: string[]): string {
  return `---\ntitle: ${title}\ndescription: d\ndate: 2026-07-08\ntags: [${tags.join(", ")}]\nstatus: ready\nsource: x.jsonl\n---\n\nbody ${title}\n`;
}
afterEach(() => {
  _resetForTests();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A repo whose config puts the topic encyclopedia at "9_topics"; a materialized topic page lives
// there, and two log pages share a tag that IS covered by the topic page (so it is not a gap),
// plus two log pages share another tag with NO topic page (a genuine gap).
function setup(): { repo: string } {
  const clone = mk("llmwiki-td-clone-");
  const repo = mk("llmwiki-td-repo-");
  const cfgDir = join(clone, CONFIGS_DIR);
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "team.toml"),
    `applies_to = [${JSON.stringify(repo)}]
[topic]
dir = "9_topics"
`,
    "utf-8",
  );
  const wiki = join(repo, "docs", "wiki");
  for (const d of ["1_direction", "2_milestone", "9_topics"]) mkdirSync(join(wiki, d), { recursive: true });
  // materialized topic page under the CUSTOM topic dir, tagged "snowflake"
  writeFileSync(join(wiki, "9_topics", "snowflake.md"), page("Snowflake", ["snowflake", "meta"]));
  // covered concept: two log pages also tagged "snowflake" → NOT a gap
  writeFileSync(join(wiki, "2_milestone", "m1.md"), page("M1", ["snowflake", "work"]));
  writeFileSync(join(wiki, "2_milestone", "m2.md"), page("M2", ["snowflake", "work"]));
  // uncovered concept: two log pages tagged "mcp" with no topic page → a gap
  writeFileSync(join(wiki, "1_direction", "d1.md"), page("D1", ["mcp", "plan"]));
  writeFileSync(join(wiki, "2_milestone", "m3.md"), page("M3", ["mcp", "work"]));
  new WikiIndex(repo).indexAll();
  _resetForTests(clone); // resolver now sees the custom topicDir for this repo
  return { repo };
}

test("buildTopicView lists the materialized page from the custom topic dir", () => {
  const { repo } = setup();
  const view = buildTopicView(repo);
  expect(view).toContain("9_topics"); // header names the resolved topic dir
  expect(view).toContain("Snowflake"); // the materialized topic page is recognized
});

test("topicGaps counts a shared-tag concept as covered only if a page exists in the custom topic dir", () => {
  const { repo } = setup();
  const gaps = topicGaps(repo);
  const tags = gaps.map((g) => g.tag);
  expect(tags).toContain("mcp"); // recurring, no topic page → gap
  expect(tags).not.toContain("snowflake"); // covered by 9_topics/snowflake.md → not a gap
});
