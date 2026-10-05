// Progressive disclosure for the /wiki-* skills.
//
// A skill body is loaded whole on every invocation, so its size is a per-use context tax. The
// skills therefore carry only what every run needs and fetch reference detail on demand with
// `llmwiki conventions <repo> --section <name>`, printed from skill/ref/<name>.md in the engine
// clone. Three things can silently break that: the close-out body creeping back over budget, a
// skill naming a section that does not exist (the model gets an error at exactly the step that
// needed the detail), and the section files not shipping with the engine.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_COMMANDS } from "../src/engine/claude-commands.ts";
import { ENGINE_CLI_TOKEN } from "../src/engine/paths.ts";
import { isPrivate } from "../src/plugin/preflight.ts";

const ROOT = join(import.meta.dir, "..");
const REF = join(ROOT, "skill", "ref");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sectionFiles = readdirSync(REF).filter((f) => f.endsWith(".md")).sort();
const sectionNames = sectionFiles.map((f) => f.slice(0, -3));

const SECTION_CALL = /--section ([a-z0-9-]+)/g;
function referencedSections(text: string): string[] {
  return [...text.matchAll(SECTION_CALL)].map((m) => m[1]!);
}

function cli(...args: string[]) {
  const r = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LLMWIKI_LANG: "en" },
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

describe("skill size budget", () => {
  test("the every-session close-out stays at or under 15,000 bytes", () => {
    expect(statSync(join(ROOT, "skill", "wiki-save.md")).size).toBeLessThanOrEqual(15_000);
  });

  // The common path: a close-out that writes any page also fetches `writing` and `citations`.
  test("the common close-out path (wiki-save + writing + citations) stays at or under 21,000 bytes", () => {
    const bytes = ["wiki-save.md", "ref/writing.md", "ref/citations.md"]
      .map((p) => statSync(join(ROOT, "skill", p)).size)
      .reduce((a, b) => a + b, 0);
    expect(bytes).toBeLessThanOrEqual(21_000);
  });
});

// Section names are a stable API: skills already installed in harness profiles (and agents that
// learned them) call these names. A rename must fail here loudly and be made deliberately.
const STABLE_SECTIONS = [
  "citations",
  "cli",
  "consolidate",
  "distill",
  "quiz-schedule",
  "review-findings",
  "review-item",
  "save-rationale",
  "team-merge",
  "topic-page",
  "writing",
];
test("section names are stable (renaming or removing one is a breaking change)", () => {
  expect(sectionNames).toEqual(STABLE_SECTIONS);
});

describe("reference sections", () => {
  const skillSources = [
    ...CLAUDE_COMMANDS.map((f) => `skill/${f}`),
    ...CLAUDE_COMMANDS.map((f) => `skills/${f.replace(/\.md$/, "")}/SKILL.md`),
    ...sectionFiles.map((f) => `skill/ref/${f}`),
  ];

  test("every --section a skill or section names exists", () => {
    const missing: string[] = [];
    for (const p of skillSources) {
      for (const name of referencedSections(read(p))) {
        if (!sectionNames.includes(name)) missing.push(`${p} → ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every section is reached from some skill (no orphan reference material)", () => {
    const named = new Set(skillSources.flatMap((p) => referencedSections(read(p))));
    expect(sectionNames.filter((n) => !named.has(n))).toEqual([]);
  });

  test("a skill always spells the full call, so the model never has to reassemble it", () => {
    for (const f of CLAUDE_COMMANDS) {
      const text = read(`skill/${f}`);
      const prefix = "llmwiki conventions <repo> ";
      for (const m of text.matchAll(SECTION_CALL)) {
        expect(`${f}: ${text.slice(m.index! - prefix.length, m.index! + m[0].length)}`).toBe(`${f}: ${prefix}${m[0]}`);
      }
    }
  });

  test("sections ship with the engine: tracked-able, public, and free of clone-path placeholders", () => {
    expect(sectionFiles.length).toBeGreaterThan(0);
    const ignored = Bun.spawnSync(["git", "check-ignore", ...sectionFiles.map((f) => `skill/ref/${f}`)], { cwd: ROOT });
    expect(ignored.exitCode).toBe(1); // 1 = none of them is ignored
    for (const f of sectionFiles) {
      expect(isPrivate(`skill/ref/${f}`)).toBe(false);
      // sections are printed by the engine as-is — no installer substitutes a clone path into them
      const text = read(`skill/ref/${f}`);
      expect(`${f}: ${text.includes(ENGINE_CLI_TOKEN) || text.includes("~/llmwiki")}`).toBe(`${f}: false`);
    }
  });

  test("conventions --section prints the section verbatim; an unknown name fails and lists the names", () => {
    const ok = cli("conventions", ROOT, "--section", "topic-page");
    expect(ok.code).toBe(0);
    expect(ok.out).toBe(read("skill/ref/topic-page.md"));

    const bad = cli("conventions", "--section", "no-such-section");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("unknown section: no-such-section");
    for (const n of sectionNames) expect(bad.err).toContain(n);

    const traversal = cli("conventions", "--section", "../wiki-save");
    expect(traversal.code).not.toBe(0);
  });

  test("plain conventions output advertises the sections for harnesses without a skill layer", () => {
    const r = cli("conventions", ROOT);
    expect(r.code).toBe(0);
    for (const n of sectionNames) expect(r.out).toContain(n);
  });
});

// Rules that moved out of the always-loaded bodies keep their coverage in their new home.
describe("relocated rules live in their sections", () => {
  const section = (n: string) => read(`skill/ref/${n}.md`);

  test("topic-page carries the 5_topic template with per-claim v3 evidence", () => {
    const t = section("topic-page");
    expect(t).toContain("domain: topic");
    expect(t).toContain("## 1. <first group");
    expect(t).toContain("### 2-1. <only when this group has parts>");
    expect(t).toContain("[^s1]: <transcript-1>.jsonl\n    > [2026-06-29 14:02 user]");
    expect(t).toContain("> [conflict]");
  });

  test("citations carries the evidence and unresolved-citation rules", () => {
    const t = section("citations");
    expect(t).toContain("**The footnote definition line itself never changes**");
    expect(t).toContain("never repoint a decision to a code file");
    expect(t).toContain("**Never add `author:`**");
    expect(t).toContain("llmwiki excerpt <transcript.jsonl> [--kind judgment|fact]");
  });

  test("review-item carries the Q./A. format and owner resolution", () => {
    const t = section("review-item");
    expect(t).toContain("Q. This session looks like a direction shift");
    expect(t).toContain("owner: <github login>");
    expect(t).toContain("gh api user --jq .login");
  });

  test("consolidate carries the selection test and the 5-dimension rubric", () => {
    const t = section("consolidate");
    expect(t).toContain("①concept/problem ②mechanism ③approach ④files/modules ⑤operating rule");
    expect(t).toContain("`grounds`, `extends`, `contradicts`, `exemplifies`, `enables`");
    expect(t).toContain("never re-summarize other wiki pages");
  });

  test("writing carries the body-structure detail", () => {
    const t = section("writing");
    expect(t).toContain("roughly 6+ top-level bullets");
    expect(t).toContain("`dense-bullet`");
    expect(t).toContain("`방향성` over 진북/북극성");
  });

  test("review-findings, team-merge, distill, quiz-schedule, save-rationale keep their rules", () => {
    expect(section("review-findings")).toContain("prev_launch_incomplete");
    expect(section("review-findings")).toContain("Never hand-edit the queue's `<!-- gap:… -->` markers");
    expect(section("team-merge")).toContain("merge=union");
    expect(section("team-merge")).toContain("llmwiki overview --normalize <repo>");
    expect(section("distill")).toContain("**Snapshot FIRST**");
    expect(section("distill")).toContain("llmwiki distill-verify <snapshot> <page>");
    expect(section("quiz-schedule")).toContain("**1 · 3 · 7 · 16 · 35 · 60 days**");
    expect(section("quiz-schedule")).toContain("The day boundary is **UTC**");
    expect(section("save-rationale")).toContain("cleanupPeriodDays");
    expect(section("save-rationale")).toContain("SessionEnd is shell-only");
    expect(section("distill")).toContain("means the engine invocation your skill resolved");
  });

  test("every path to a 0_review item leads to review-item (owner stamp + format)", () => {
    for (const p of ["skill/ref/consolidate.md", "skill/ref/review-findings.md", "skill/wiki-deep.md", "skill/wiki-save.md"]) {
      expect(`${p}: ${read(p).includes("--section review-item")}`).toBe(`${p}: true`);
    }
    // sections print raw into every harness, so they never name one harness's command spelling
    expect(section("review-item")).not.toMatch(/\/wiki-save|\/wiki-deep/);
  });

  test("cli carries the close-out command semantics wiki-deep defers to", () => {
    const t = section("cli");
    expect(t).toContain("plain = dry-run");
    expect(t).toContain("advance the capture watermark for sessions a wiki page now cites");
    expect(t).toContain("needed only when a page was written outside that flow");
    expect(t).toContain("llmwiki digest <repo>");
    expect(t).toContain("it rebuilds the refs graph too");
    expect(read("skill/wiki-deep.md")).toContain("`llmwiki conventions <repo> --section cli`");
    expect(read("skill/wiki-deep.md")).not.toContain("the rest is listed in `/wiki-save`");
  });

  test("the hard invariants stay in the always-loaded bodies, not behind a section call", () => {
    const save = read("skill/wiki-save.md");
    for (const rule of [
      "**Never fabricate ungrounded claims — omit** them",
      "Only **direction shifts** and **unresolved contradictions** go to `0_review`",
      "**save-current fails (no exact match) → file NOTHING for this session**",
      "**never re-summarize other wiki pages**",
      "llmwiki review <repo> --commit --if-due",
      "cold-start rule 3 defers ALL mid-session page-writing",
      "**never `author:`**",
      "`status: superseded` + `superseded_by: <new page path>`",
      "**Secrets never enter a page**",
      "Every item stamps `owner:` (`gh api user --jq .login`",
      "never translate",
      "never transliterated",
      "a short single-group page stays a bare bullet list",
      "never load the full transcript into context",
      "keep only now+next in L0",
      "propose, the human confirms",
      "never fail the close-out over it",
      "with a relation word (grounds · extends · contradicts · exemplifies · enables)",
      "and in any `--section` output",
    ]) {
      expect(save).toContain(rule);
    }
    const deep = read("skill/wiki-deep.md");
    expect(deep).toContain("**snapshot FIRST**");
    expect(deep).toContain("`llmwiki distill-verify <snapshot> <page>` must pass");
    expect(read("skill/wiki-quiz.md")).toContain("**never hand-edited**");
  });
});
