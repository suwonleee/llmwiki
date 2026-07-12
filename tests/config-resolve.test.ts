// Per-repo config resolution (configs/): precedence, applies_to prefix matching, fail-safety,
// and per-repo cache isolation. Uses _resetForTests(tempCloneRoot) to point the resolver at a
// fabricated clone root, so the real engine clone's config never leaks into these tests.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { getConfig, _resetForTests, CONFIG_BASENAME, CONFIGS_DIR } from "../src/engine/config.ts";

const tmps: string[] = [];
function tmpClone(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-cfgres-"));
  tmps.push(d);
  return d;
}
function put(clone: string, rel: string, content: string): void {
  const p = join(clone, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
}
const named = (appliesTo: string[], dir = "1_goal", domain = "goal") =>
  `applies_to = [${appliesTo.map((p) => JSON.stringify(p)).join(", ")}]
[[category]]
dir = "${dir}"
domain = "${domain}"
review = "human"
guide = "goal"
[[category]]
dir = "2_lesson"
domain = "lesson"
review = "model"
guide = "lesson"
`;
const defaultToml = (topic: string) => `[topic]\ndir = "${topic}"\n`;

afterEach(() => {
  _resetForTests(); // restore the real clone root + clear caches
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("zero-config: no configs/ and no root file → built-in defaults", () => {
  _resetForTests(tmpClone());
  const c = getConfig("/some/repo");
  expect(c.source).toBe("defaults");
  expect(c.categories.map((x) => x.dir)).toEqual(["1_direction", "2_milestone", "3_decision", "4_insight"]);
  expect(c.warning).toBeUndefined();
});

test("root file only → selected (backward compat)", () => {
  const clone = tmpClone();
  put(clone, CONFIG_BASENAME, defaultToml("9_topic"));
  _resetForTests(clone);
  const c = getConfig("/some/repo");
  expect(c.topicDir).toBe("9_topic");
  expect(c.selection).toBe("root file");
});

test("configs/ default applies to any repo and shadows the root file (with warning)", () => {
  const clone = tmpClone();
  put(clone, CONFIG_BASENAME, defaultToml("9_root"));
  put(clone, join(CONFIGS_DIR, "default.toml"), defaultToml("8_dir"));
  _resetForTests(clone);
  const c = getConfig("/any/repo");
  expect(c.topicDir).toBe("8_dir");
  expect(c.selection).toBe(`${CONFIGS_DIR}/ default`);
  expect(c.warning).toContain("shadowed");
});

test("named applies_to match beats the default; unmatched repo falls back", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "default.toml"), defaultToml("8_dir"));
  put(clone, join(CONFIGS_DIR, "team-a.toml"), named(["/work/repo-a"]));
  _resetForTests(clone);
  expect(getConfig("/work/repo-a").categories[0]!.dir).toBe("1_goal");
  expect(getConfig("/work/repo-a/sub/dir").categories[0]!.dir).toBe("1_goal"); // subfolder inherits
  expect(getConfig("/work/repo-b").topicDir).toBe("8_dir"); // unmatched → configs/ default
});

test("prefix matching is segment-safe: /a/foo does not cover /a/foobar", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "foo.toml"), named(["/a/foo"]));
  _resetForTests(clone);
  expect(getConfig("/a/foo").categories[0]!.dir).toBe("1_goal");
  expect(getConfig("/a/foobar").source).toBe("defaults");
});

test("most-specific (longest) prefix wins across configs", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "broad.toml"), named(["/a"], "1_broad", "broad"));
  put(clone, join(CONFIGS_DIR, "narrow.toml"), named(["/a/b"], "1_narrow", "narrow"));
  _resetForTests(clone);
  expect(getConfig("/a/b/c").categories[0]!.dir).toBe("1_narrow");
  expect(getConfig("/a/x").categories[0]!.dir).toBe("1_broad");
});

test("~ expansion in applies_to", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "home.toml"), named(["~/cfgres-home-repo"]));
  _resetForTests(clone);
  expect(getConfig(join(homedir(), "cfgres-home-repo")).categories[0]!.dir).toBe("1_goal");
});

test("equal-specificity tie → deterministic pick + warning", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "a-team.toml"), named(["/same/repo"], "1_a", "aaa"));
  put(clone, join(CONFIGS_DIR, "b-team.toml"), named(["/same/repo"], "1_b", "bbb"));
  _resetForTests(clone);
  const c = getConfig("/same/repo");
  expect(c.categories[0]!.dir).toBe("1_a"); // first in sorted scan order
  expect(c.warning).toContain("tie");
});

test("unreadable named config is excluded, resolution falls through with a warning", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "broken.toml"), "applies_to = [)not toml");
  put(clone, join(CONFIGS_DIR, "default.toml"), defaultToml("8_dir"));
  _resetForTests(clone);
  const c = getConfig("/any/repo");
  expect(c.topicDir).toBe("8_dir");
  expect(c.warning).toContain("unreadable config broken.toml");
});

test("named config that parses but fails validation → defaults + error (hook-safe)", () => {
  const clone = tmpClone();
  put(
    clone,
    join(CONFIGS_DIR, "invalid.toml"),
    `applies_to = ["/bad/repo"]\n[[category]]\ndir = "1_x/evil"\ndomain = "x"\nreview = "model"\nguide = "g"\n`,
  );
  _resetForTests(clone);
  const c = getConfig("/bad/repo");
  expect(c.error).toContain("dir invalid");
  expect(c.categories.map((x) => x.dir)).toEqual(["1_direction", "2_milestone", "3_decision", "4_insight"]);
});

test("global getConfig() (no repo) selects the configs/ default", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "default.toml"), defaultToml("8_dir"));
  _resetForTests(clone);
  const c = getConfig(); // no repo → global resolution
  expect(c.topicDir).toBe("8_dir");
  expect(c.selection).toBe(`${CONFIGS_DIR}/ default`);
});

test("global getConfig() skips named applies_to configs (no repo to match) → defaults", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "team-a.toml"), named(["/work/repo-a"]));
  _resetForTests(clone);
  const c = getConfig(); // no repo → named configs cannot match
  expect(c.source).toBe("defaults");
  expect(c.categories.map((x) => x.dir)).toEqual(["1_direction", "2_milestone", "3_decision", "4_insight"]);
});

test("per-repo cache isolation in one process; _resetForTests clears", () => {
  const clone = tmpClone();
  put(clone, join(CONFIGS_DIR, "team-a.toml"), named(["/iso/repo-a"]));
  _resetForTests(clone);
  const a = getConfig("/iso/repo-a");
  const b = getConfig("/iso/repo-b");
  expect(a.categories[0]!.dir).toBe("1_goal");
  expect(b.source).toBe("defaults");
  expect(getConfig("/iso/repo-a")).toBe(a); // cached
  _resetForTests(clone);
  expect(getConfig("/iso/repo-a")).not.toBe(a); // cache cleared
});
