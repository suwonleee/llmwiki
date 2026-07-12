// `llmwiki migrate <repo>` (cmdMigrate → migrate(ws) with no explicit cfg) must resolve the
// repo's per-repo configs/ config as its migration target — the default param cfg = getConfig(ws).
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/engine/migrate.ts";
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

test("migrate(repo) with no explicit cfg targets the repo's configs/ structure", () => {
  const clone = mk("llmwiki-migpr-clone-");
  const repo = mk("llmwiki-migpr-repo-");
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
`,
    "utf-8",
  );
  _resetForTests(clone);

  // stock-shaped wiki on disk; the config says it should become 1_goal / 2_lesson
  const wiki = join(repo, "docs", "wiki");
  for (const d of ["1_direction", "2_milestone"]) mkdirSync(join(wiki, d), { recursive: true });

  const r = migrate(repo); // no cfg arg → default getConfig(repo) → the named config
  expect(r.verdict).toBe("planned");
  const map = Object.fromEntries((r.pairs ?? []).map((p) => [p.from, p.to]));
  expect(map["1_direction"]).toBe("1_goal");
  expect(map["2_milestone"]).toBe("2_lesson");
});
