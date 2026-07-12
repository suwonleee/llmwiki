// End-to-end proof that cold-start (buildContext) consumes the RESOLVED per-repo config, not a
// process-global one: a repo governed by a configs/ named config must show that config's category
// dirs in its operating rules, while a stock repo shows the historical dirs — in the SAME process.
// Assert on language-invariant dir tokens so LLMWIKI_LANG doesn't matter.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContext } from "../src/engine/context.ts";
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

test("cold-start operating rules reflect a per-repo configs/ config", () => {
  const clone = mk("llmwiki-ctx-clone-");
  const repo = mk("llmwiki-ctx-repo-");
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

  ensureSkeleton(repo); // builds the custom skeleton from the resolved config
  const cs = buildContext(repo);

  expect(cs).toContain("1_goal"); // custom category surfaced in the operating rules
  expect(cs).not.toContain("1_direction"); // stock category must NOT leak in
});

test("a stock repo in the same process still shows the historical dirs (no cross-repo leak)", () => {
  const clone = mk("llmwiki-ctx-clone2-");
  const custom = mk("llmwiki-ctx-custom-");
  const stock = mk("llmwiki-ctx-stock-");
  const cfgDir = join(clone, CONFIGS_DIR);
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "team.toml"),
    `applies_to = [${JSON.stringify(custom)}]
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

  ensureSkeleton(custom);
  ensureSkeleton(stock); // unmatched repo → configs/ has no default → built-in defaults
  const customCs = buildContext(custom);
  const stockCs = buildContext(stock);

  expect(customCs).toContain("1_goal");
  expect(stockCs).toContain("1_direction");
  expect(stockCs).not.toContain("1_goal");
});
