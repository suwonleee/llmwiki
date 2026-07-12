// migrate (P3): restructure a wiki to a custom config with referential integrity — dry-run
// default, same-leading-number pairing + explicit --map, link/domain rewriting, .schema-version
// stamping, and two-directional drift detection for cold-start.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, detectConfigDrift, SCHEMA_VERSION_FILE } from "../src/engine/migrate.ts";
import { defaults, loadFrom, type WikiConfig } from "../src/engine/config.ts";

function teamCfg(): WikiConfig {
  const p = join(mkdtempSync(join(tmpdir(), "llmwiki-mig-cfg-")), "llmwiki.config.toml");
  writeFileSync(
    p,
    `
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
`,
    "utf-8",
  );
  const c = loadFrom(p);
  if (c.error) throw new Error(c.error);
  return c;
}

function stockWiki(): string {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-mig-"));
  const wiki = join(repo, "docs", "wiki");
  for (const d of ["0_review", "1_direction", "2_milestone", "3_decision", "4_insight", "5_topic"]) {
    mkdirSync(join(wiki, d), { recursive: true });
  }
  writeFileSync(
    join(wiki, "3_decision", "adr-1.md"),
    "---\ntitle: ADR1\ndescription: d\ndate: 2026-07-07\ntags: [a, b]\nstatus: ready\ndomain: decision\nsource: x.jsonl\n---\n\nchose X [^1]\n\n[^1]: x.jsonl\n",
    "utf-8",
  );
  writeFileSync(
    join(wiki, "2_milestone", "m1.md"),
    "---\ntitle: M1\ndescription: d\ndate: 2026-07-07\ntags: [a, b]\nstatus: ready\ndomain: milestone\nsource: x.jsonl\n---\n\nsee [[3_decision/adr-1]] and [details](3_decision/adr-1.md) under docs/wiki/3_decision/ [^1]\n\n[^1]: x.jsonl\n",
    "utf-8",
  );
  writeFileSync(join(wiki, "overview.md"), "---\ntitle: OV\n---\nhub", "utf-8");
  return repo;
}

test("dry-run pairs by leading number, reports strays, touches nothing", () => {
  const repo = stockWiki();
  const r = migrate(repo, {}, teamCfg());
  expect(r.verdict).toBe("planned");
  const map = Object.fromEntries((r.pairs ?? []).map((p) => [p.from, p.to]));
  expect(map["1_direction"]).toBe("1_goal");
  expect(map["2_milestone"]).toBe("2_lesson");
  expect(map["3_decision"]).toBe("3_adr");
  expect(r.strays).toEqual(["4_insight", "5_topic"]); // no same-number counterpart → untouched
  expect(r.linksRewritten).toBe(3); // [[…, ](…, docs/wiki/… in m1.md
  expect(existsSync(join(repo, "docs", "wiki", "3_decision"))).toBe(true); // dry-run: unchanged
});

test("commit renames dirs, rewrites links + domains, stamps schema-version; rerun conforms", () => {
  const repo = stockWiki();
  const cfg = teamCfg();
  const r = migrate(repo, { commit: true, map: { "4_insight": "2_lesson", "5_topic": "9_topics" } }, cfg);
  expect(r.verdict).toBe("migrated");
  const wiki = join(repo, "docs", "wiki");
  expect(existsSync(join(wiki, "3_adr", "adr-1.md"))).toBe(true);
  expect(existsSync(join(wiki, "3_decision"))).toBe(false);
  expect(existsSync(join(wiki, "9_topics"))).toBe(true);
  const m1 = readFileSync(join(wiki, "2_lesson", "m1.md"), "utf-8");
  expect(m1).toContain("[[3_adr/adr-1]]");
  expect(m1).toContain("](3_adr/adr-1.md)");
  expect(m1).toContain("docs/wiki/3_adr/");
  expect(m1).toContain("domain: lesson"); // frontmatter follows the new category
  const adr = readFileSync(join(wiki, "3_adr", "adr-1.md"), "utf-8");
  expect(adr).toContain("domain: adr");
  expect(existsSync(join(wiki, SCHEMA_VERSION_FILE))).toBe(true);
  expect(r.lintErrors).toBe(0);

  const again = migrate(repo, { commit: true }, cfg);
  expect(again.verdict).toBe("conforms"); // idempotent
});

test("drift detection: forward (structure vs config), clean after migrate, reverse (stale engine)", () => {
  const repo = stockWiki();
  const cfg = teamCfg();
  expect(detectConfigDrift(repo, cfg)).toContain("llmwiki migrate"); // forward drift
  expect(detectConfigDrift(repo, defaults())).toBeNull(); // stock engine sees stock wiki: clean

  migrate(repo, { commit: true, map: { "4_insight": "2_lesson", "5_topic": "9_topics" } }, cfg);
  expect(detectConfigDrift(repo, cfg)).toBeNull(); // clean after migrate

  // reverse: a teammate whose engine still runs stock defaults opens the migrated wiki
  const rev = detectConfigDrift(repo, defaults());
  expect(rev).toContain("migrate"); // structure drift seen from the stale side
  // and a pure snapshot mismatch (same dirs, different recorded version) is also caught
  const sv = join(repo, "docs", "wiki", SCHEMA_VERSION_FILE);
  const snap = JSON.parse(readFileSync(sv, "utf-8"));
  snap.config_version = 99;
  writeFileSync(sv, JSON.stringify(snap), "utf-8");
  expect(detectConfigDrift(repo, cfg)).toContain(SCHEMA_VERSION_FILE);
});
