// Team-convention config (llmwiki.config.toml): zero-config = stock structure, override-only,
// fail-safe on invalid files. Pins the P1 invariant: with no config file (or the defaults
// written out explicitly), routing/scan behavior is byte-identical to the historical constants.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, loadFrom, domainToDir, isHumanReviewDir, logDirs, scanDirs } from "../src/engine/config.ts";

function tmpToml(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "llmwiki-cfg-")), "llmwiki.config.toml");
  writeFileSync(p, content, "utf-8");
  return p;
}

test("no file → defaults (stock structure, source=defaults)", () => {
  const c = loadFrom("/nonexistent/llmwiki.config.toml");
  expect(c.source).toBe("defaults");
  expect(logDirs(c)).toEqual(["1_direction", "2_milestone", "3_decision", "4_insight"]);
  expect(c.topicDir).toBe("5_topic");
  expect(c.queueDir).toBe("0_review");
  expect(scanDirs(c)).toContain("milestones"); // legacy still scanned
});

test("domainToDir reproduces the historical routing exactly (default config)", () => {
  const c = defaults();
  // the exact behavior of the removed autoupdate._category switch:
  expect(domainToDir("direction", c)).toBe("1_direction");
  expect(domainToDir("decision", c)).toBe("3_decision");
  expect(domainToDir("insight", c)).toBe("4_insight");
  expect(domainToDir("lesson", c)).toBe("4_insight"); // alias preserved
  expect(domainToDir("milestone", c)).toBe("2_milestone");
  expect(domainToDir("", c)).toBe("2_milestone"); // no domain → fallback
  expect(domainToDir("unknown-thing", c)).toBe("2_milestone");
  expect(isHumanReviewDir("1_direction", c)).toBe(true); // direction requires the human queue
  expect(isHumanReviewDir("3_decision", c)).toBe(false);
});

test("explicit default config == built-in defaults (snapshot equivalence)", () => {
  const p = tmpToml(`
config_version = 1
[[category]]
dir = "1_direction"
domain = "direction"
review = "human"
guide = "g1"
[[category]]
dir = "2_milestone"
domain = "milestone"
review = "model"
guide = "g2"
[[category]]
dir = "3_decision"
domain = "decision"
review = "model"
guide = "g3"
[[category]]
dir = "4_insight"
domain = "insight"
review = "model"
guide = "g4"
aliases = ["lesson"]
`);
  const c = loadFrom(p);
  expect(c.error).toBeUndefined();
  expect(logDirs(c)).toEqual(logDirs(defaults()));
  for (const d of ["direction", "decision", "insight", "lesson", "", "milestone"]) {
    expect(domainToDir(d, c)).toBe(domainToDir(d, defaults()));
  }
});

test("custom team format (goal/lesson/adr) routes and gates accordingly", () => {
  const p = tmpToml(`
[[category]]
dir = "1_goal"
domain = "goal"
review = "human"
guide = "분기 목표"
[[category]]
dir = "2_lesson"
domain = "lesson"
review = "model"
guide = "교훈"
[[category]]
dir = "3_adr"
domain = "adr"
review = "model"
guide = "ADR"
[topic]
dir = "9_topics"
[lint.banned_terms]
"진북" = "방향성"
`);
  const c = loadFrom(p);
  expect(c.error).toBeUndefined();
  expect(domainToDir("goal", c)).toBe("1_goal");
  expect(domainToDir("adr", c)).toBe("3_adr");
  expect(domainToDir("", c)).toBe("2_lesson"); // fallback = first review:"model"
  expect(isHumanReviewDir("1_goal", c)).toBe(true);
  expect(c.topicDir).toBe("9_topics");
  expect(c.bannedTerms).toEqual([["진북", "방향성"]]);
});

test("invalid config falls back to defaults with error (fail-safe — never breaks a session)", () => {
  const dup = tmpToml(`
[[category]]
dir = "1_x"
domain = "same"
review = "model"
guide = ""
[[category]]
dir = "2_y"
domain = "same"
review = "model"
guide = ""
`);
  const c = loadFrom(dup);
  expect(c.error).toContain("duplicate category domain");
  expect(logDirs(c)).toEqual(logDirs(defaults())); // defaults in effect

  const noModel = tmpToml(`
[[category]]
dir = "1_x"
domain = "x"
review = "human"
guide = ""
`);
  expect(loadFrom(noModel).error).toContain('review = "model"');

  const garbage = tmpToml("this is [ not toml =");
  const g = loadFrom(garbage);
  expect(g.error).toContain("parse failed");
  expect(logDirs(g)).toEqual(logDirs(defaults()));
});

// ---- quiz session size ([quiz] questions; the ceiling is engine-fixed, not config) ---------

test("[quiz] questions: stock 3, toml overrides, invalid values fail-safe", () => {
  expect(defaults().quizQuestions).toBe(3);

  const c = loadFrom(tmpToml(`
[quiz]
questions = 5
`));
  expect(c.error).toBeUndefined();
  expect(c.quizQuestions).toBe(5);

  const zero = loadFrom(tmpToml(`
[quiz]
questions = 0
`));
  expect(zero.error).toContain("quiz questions");
  expect(zero.quizQuestions).toBe(3); // defaults in effect
});

// ---- models tier (env > toml [models] > builtin default) ----------------------------------
// Save/restore the model env vars so these tests are independent of the ambient environment.
function withModelEnv(light: string | undefined, heavy: string | undefined, fn: () => void): void {
  const prevL = process.env.LLMWIKI_MODEL_LIGHT;
  const prevH = process.env.LLMWIKI_MODEL_HEAVY;
  if (light === undefined) delete process.env.LLMWIKI_MODEL_LIGHT;
  else process.env.LLMWIKI_MODEL_LIGHT = light;
  if (heavy === undefined) delete process.env.LLMWIKI_MODEL_HEAVY;
  else process.env.LLMWIKI_MODEL_HEAVY = heavy;
  try {
    fn();
  } finally {
    if (prevL === undefined) delete process.env.LLMWIKI_MODEL_LIGHT;
    else process.env.LLMWIKI_MODEL_LIGHT = prevL;
    if (prevH === undefined) delete process.env.LLMWIKI_MODEL_HEAVY;
    else process.env.LLMWIKI_MODEL_HEAVY = prevH;
  }
}

// No env, no toml → UNPINNED. The engine ships no model id: a hardcoded one ages into a pass that
// breaks for a user who changed nothing (it had already aged — the old default named Opus 4.8 after
// Opus 5 shipped). Unpinned means the generative pass uses the model the session actually runs on.
test("models: unpinned when no env and no toml [models]", () => {
  withModelEnv(undefined, undefined, () => {
    const c = defaults();
    expect(c.models.light).toBeNull();
    expect(c.models.heavy).toBeNull();
  });
});

test("models: toml [models] flows into cfg.models (no env override)", () => {
  withModelEnv(undefined, undefined, () => {
    const p = tmpToml(`
config_version = 1
[models]
light = "my-light-model"
heavy = "my-heavy-model"
`);
    const c = loadFrom(p);
    expect(c.error).toBeUndefined();
    expect(c.models.light).toBe("my-light-model");
    expect(c.models.heavy).toBe("my-heavy-model");
  });
});

test("models: partial toml [models] leaves the unset tier unpinned", () => {
  withModelEnv(undefined, undefined, () => {
    const p = tmpToml(`
[models]
light = "only-light"
`);
    const c = loadFrom(p);
    expect(c.models.light).toBe("only-light");
    expect(c.models.heavy).toBeNull(); // unset → unpinned, resolved from the session
  });
});

test("models: env overrides toml [models] (env > toml > unpinned)", () => {
  withModelEnv("env-light", "env-heavy", () => {
    const p = tmpToml(`
[models]
light = "toml-light"
heavy = "toml-heavy"
`);
    const c = loadFrom(p);
    expect(c.models.light).toBe("env-light");
    expect(c.models.heavy).toBe("env-heavy");
    // defaults() (no toml) also honors env
    expect(defaults().models.light).toBe("env-light");
    expect(defaults().models.heavy).toBe("env-heavy");
  });
});

// Personal overlay ([private] dirs): additional LOCAL-ONLY wiki folders.
test("[private] dirs parses; default is empty", () => {
  expect(defaults().privateDirs).toEqual([]);
  const c = loadFrom(tmpToml('config_version = 1\n[private]\ndirs = ["9_personal", "8_scratch"]\n'));
  expect(c.privateDirs).toEqual(["9_personal", "8_scratch"]);
  expect(c.error).toBeUndefined();
});

test("a private dir colliding with a shared dir is rejected — it would gitignore a team category", () => {
  const c = loadFrom(tmpToml('config_version = 1\n[private]\ndirs = ["5_topic"]\n'));
  expect(c.error).toContain("collides");
  const d = loadFrom(tmpToml('config_version = 1\n[private]\ndirs = ["3_decision"]\n'));
  expect(d.error).toContain("collides");
});
