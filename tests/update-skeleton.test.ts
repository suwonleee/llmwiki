// ensureSkeleton must build the wiki scaffold from the RESOLVED (per-repo) config — custom
// category dirs, queue/topic dirs, and L0/overview/log file basenames all come from the config,
// not hardcoded literals. Stock config still produces the historical structure.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkeleton } from "../src/engine/update.ts";
import { _resetForTests, CONFIGS_DIR } from "../src/engine/config.ts";

const tmps: string[] = [];
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  _resetForTests();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("ensureSkeleton (stock config) creates the historical structure", () => {
  const repo = mk("llmwiki-skel-stock-");
  ensureSkeleton(repo); // no configs/ → built-in defaults
  const w = join(repo, "docs", "wiki");
  for (const d of ["0_review", "1_direction", "2_milestone", "3_decision", "4_insight", "5_topic"]) {
    expect(existsSync(join(w, d))).toBe(true);
  }
  for (const f of ["current-state.md", "overview.md", "log.md"]) {
    expect(existsSync(join(w, f))).toBe(true);
  }
});

test("ensureSkeleton honors a per-repo configs/ config (custom dirs + file basenames)", () => {
  const clone = mk("llmwiki-skel-clone-");
  const repo = mk("llmwiki-skel-repo-");
  const cfgDir = join(clone, CONFIGS_DIR);
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "team.toml"),
    `applies_to = [${JSON.stringify(repo)}]
[[category]]
dir = "1_goal"
domain = "goal"
review = "human"
guide = "goal"
[[category]]
dir = "2_lesson"
domain = "lesson"
review = "model"
guide = "lesson"
[topic]
dir = "9_topics"
[queue]
dir = "_inbox"
[files]
l0 = "now.md"
overview = "home.md"
log = "ledger.md"
`,
    "utf-8",
  );
  _resetForTests(clone); // resolver now reads the temp clone's configs/

  ensureSkeleton(repo); // resolves getConfig(repo) → the named config
  const w = join(repo, "docs", "wiki");
  for (const d of ["1_goal", "2_lesson", "9_topics", "_inbox"]) {
    expect(existsSync(join(w, d))).toBe(true);
  }
  for (const f of ["now.md", "home.md", "ledger.md"]) {
    expect(existsSync(join(w, f))).toBe(true);
  }
  // stock structure must NOT appear under the custom config
  expect(existsSync(join(w, "1_direction"))).toBe(false);
  expect(existsSync(join(w, "current-state.md"))).toBe(false);
});
