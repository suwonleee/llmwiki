// The passive-delivery report: what reaches a session when nobody asks for it.
//
// Without /wiki-ask there are exactly two channels — the cold-start injection (unconditional,
// once per session) and the turn-context injection (conditional, once per prompt). So "how much
// does simply having llmwiki attached help?" is fully characterised by what those two deliver and
// what they cost, and that is measurable deterministically, for free, on every run.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBench, loadQueries } from "../src/engine/bench.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { buildContext } from "../src/engine/context.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

describe("passive delivery report", () => {
  let root: string;
  let wiki: string;

  function page(dir: string, name: string, title: string, body: string): void {
    const target = join(wiki, dir);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, `${name}.md`),
      `---\ntitle: ${title}\ndescription: ${title}\ndate: 2026-07-25\ntags: [topic, ops]\nstatus: ready\n---\n\n${body}\n`,
    );
  }

  beforeEach(() => {
    // The passive report measures what cold start DELIVERS, and cold start is fail-closed since
    // the enrollment gate: an unenrolled worktree yields zero bytes by design. So the fixture has
    // to be a real, enrolled git repo — otherwise this file measures the gate, not the channels.
    root = enrollRepo(makeGitRepo(join(mkdtempSync(join(tmpdir(), "llmwiki-passive-")), "repo")));
    wiki = join(root, "docs", "wiki");
    mkdirSync(join(wiki, ".bench"), { recursive: true });
    writeFileSync(
      join(wiki, "current-state.md"),
      "---\ntitle: Current State\ndescription: L0\ndate: 2026-07-25\ntags: [current-state, L0]\nstatus: ready\n---\n\nThe deployment pipeline is the current focus.\n",
    );
    page(
      "5_topic",
      "deployment-pipeline",
      "Deployment pipeline",
      "The deployment pipeline runs migrations before the release is promoted. ".repeat(10),
    );
    page(
      "5_topic",
      "batching-defect",
      "Coin expiry batching defect",
      "The coin expiry notification was sent once per user because the batch step lost its grouping. ".repeat(8),
    );
  });

  afterEach(() => {
    resetEnrollmentCache(); // enrollment is cached per process; each fixture is a fresh worktree
    rmSync(root, { recursive: true, force: true });
  });

  // bench measures the index as it stands — the same thing a reader's session sees.
  function golden(rows: string): void {
    writeFileSync(join(wiki, ".bench", "golden.toml"), rows);
    const idx = new WikiIndex(root);
    const conn = idx.connect();
    idx.indexAll(conn);
    conn.close();
  }

  test("reach and silence are reported, and silence is measured on the refusal queries", () => {
    golden(`
[[query]]
id = "q1"
question = "what does the deployment pipeline do with migrations"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]

[[query]]
id = "r1"
question = "what is the weather in the mountains tomorrow"
target_pages = []
must_refuse = true
`);
    const r = runBench(root);
    expect(r.passive.reach).toBe(1);
    expect(r.passive.silence).toBe(1);
    expect(r.n_content).toBe(1);
    expect(r.n_refusal).toBe(1);
  });

  test("the cost of the two channels is reported in bytes", () => {
    golden(`
[[query]]
id = "q1"
question = "what does the deployment pipeline do with migrations"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]
`);
    const r = runBench(root);
    // Cold start is a per-session constant, so it is reported as one number, not an average.
    expect(r.passive.coldstart_bytes).toBe(Buffer.byteLength(buildContext(root), "utf-8"));
    expect(r.passive.coldstart_bytes).toBeGreaterThan(0);
    // Turn cost is a distribution: a silent turn costs nothing and a pointer turn costs a little.
    expect(r.passive.turn_bytes_p50).toBeGreaterThan(0);
    expect(r.passive.turn_bytes_p95).toBeGreaterThanOrEqual(r.passive.turn_bytes_p50);
  });

  test("reach is broken out by the language the question was asked in", () => {
    golden(`
[[query]]
id = "en1"
lang = "en"
question = "what does the deployment pipeline do with migrations"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]

[[query]]
id = "en2"
lang = "en"
question = "why was the coin expiry notification sent once per user"
target_pages = ["docs/wiki/5_topic/batching-defect.md"]

[[query]]
id = "xx1"
lang = "xx"
question = "zzzz qqqq vvvv wwww nothing here matches at all"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]
`);
    const r = runBench(root);
    expect(r.passive.by_lang["en"]!.n).toBe(2);
    expect(r.passive.by_lang["xx"]!.n).toBe(1);
    expect(r.passive.by_lang["en"]!.reach).toBeGreaterThan(r.passive.by_lang["xx"]!.reach);
  });

  test("reach is broken out by whether the answer exists outside the wiki at all", () => {
    golden(`
[[query]]
id = "c1"
question = "what does the deployment pipeline do with migrations"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]
recoverable_from = "code"

[[query]]
id = "w1"
question = "why was the coin expiry notification sent once per user"
target_pages = ["docs/wiki/5_topic/batching-defect.md"]
recoverable_from = "wiki_only"
`);
    const r = runBench(root);
    expect(r.passive.by_recoverability["code"]!.n).toBe(1);
    expect(r.passive.by_recoverability["wiki_only"]!.n).toBe(1);
    // The headline number for "why a wiki at all": the share of questions nothing else can answer.
    expect(r.passive.irreplaceable).toBeCloseTo(0.5, 5);
  });

  test("a golden set written before these fields still loads", () => {
    golden(`
[[query]]
id = "q1"
question = "what does the deployment pipeline do with migrations"
target_pages = ["docs/wiki/5_topic/deployment-pipeline.md"]
`);
    const queries = loadQueries(root);
    expect(queries[0]!.lang).toBeUndefined();
    expect(queries[0]!.recoverable_from).toBeUndefined();
    expect(() => runBench(root)).not.toThrow();
    expect(runBench(root).passive.irreplaceable).toBe(0); // nothing labelled → claim nothing
  });
});
