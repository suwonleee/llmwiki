// Team-mode support (all additive — solo behavior unchanged):
//   • teammate transcript citations: the PRE-EXISTING self-heal (autoRegisterCitedTranscripts)
//     registers every clean cited `.jsonl` as a virtual source on index/refs rebuild, so a
//     teammate's citation NEVER lints as unresolved. The team flow depends on this — pin it.
//   • skeleton: idempotently ensures .gitignore(.llmwiki/) + .gitattributes(log.md merge=union).
//   • authorship: READ from git (contributors + a seeded .mailmap), never cached into frontmatter
//     — a stamped author goes stale the moment a teammate edits the page (decision 2026-07-10).
//   • cold-start: `owner:` on a 0_review item renders as [→ name]; behind-upstream repos get
//     one informational line.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Linter, type WikiIndexLike } from "../src/engine/lint.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { autoRegisterCitedTranscripts } from "../src/engine/refs.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { contributors } from "../src/engine/synthesis.ts";
import { buildContext } from "../src/engine/context.ts";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// ---- teammate transcript citations self-heal at index time -------------------------------

test("a teammate's clean .jsonl citation self-heals (no unresolved-citation on my machine)", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-heal-"));
  const wiki = join(repo, "docs", "wiki", "2_milestone");
  mkdirSync(wiki, { recursive: true });
  writeFileSync(
    join(wiki, "teammate-page.md"),
    "---\ntitle: T\ndescription: d\ndate: 2026-07-07\ntags: [a, b]\nstatus: ready\ndomain: milestone\nsource: x\n---\n\nfact [^1]\n\n[^1]: 99999999-aaaa-bbbb-cccc-000000000000.jsonl\n",
    "utf-8",
  );
  const idx = new WikiIndex(repo);
  idx.indexAll();
  autoRegisterCitedTranscripts(idx); // what `llmwiki index` runs on every rebuild
  const conn = idx.connect();
  const [issues] = new Linter(idx as unknown as WikiIndexLike, conn).run();
  conn.close();
  expect(issues.filter((i) => i.code === "unresolved-citation").length).toBe(0);
});

test("a malformed citation (parenthetical suffix) still errors — self-heal must not mask it", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-heal2-"));
  const wiki = join(repo, "docs", "wiki", "2_milestone");
  mkdirSync(wiki, { recursive: true });
  writeFileSync(
    join(wiki, "bad-citation.md"),
    "---\ntitle: T\ndescription: d\ndate: 2026-07-07\ntags: [a, b]\nstatus: ready\ndomain: milestone\nsource: x\n---\n\nfact [^1]\n\n[^1]: 99999999-aaaa-bbbb-cccc-000000000000.jsonl (project: foo)\n",
    "utf-8",
  );
  const idx = new WikiIndex(repo);
  idx.indexAll();
  autoRegisterCitedTranscripts(idx);
  const conn = idx.connect();
  const [issues] = new Linter(idx as unknown as WikiIndexLike, conn).run();
  conn.close();
  expect(issues.filter((i) => i.code === "unresolved-citation").length).toBe(1);
});

// ---- skeleton: team-safety files ---------------------------------------------------------

test("ensureSkeleton writes .gitignore/.gitattributes idempotently, preserving user content", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-skel-"));
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n", "utf-8");
  ensureSkeleton(repo);
  ensureSkeleton(repo); // second run must not duplicate
  const gi = readFileSync(join(repo, ".gitignore"), "utf-8");
  expect(gi).toContain("node_modules/"); // user content preserved
  expect(gi.split("\n").filter((l) => l.trim() === ".llmwiki/").length).toBe(1);
  const ga = readFileSync(join(repo, ".gitattributes"), "utf-8");
  expect(ga.split("\n").filter((l) => l.includes("log.md merge=union")).length).toBe(1);
});

// ---- authorship: read from git, never cached in frontmatter (decision 2026-07-10) ----------

test("ensureSkeleton seeds .mailmap so one person's several git identities count once", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-mailmap-"));
  ensureSkeleton(repo);
  const mm = readFileSync(join(repo, ".mailmap"), "utf-8");
  expect(mm).toContain("%aN"); // explains what the file is for

  // additive: an existing .mailmap is a team artifact and must never be rewritten
  writeFileSync(join(repo, ".mailmap"), "hand written\n", "utf-8");
  ensureSkeleton(repo);
  expect(readFileSync(join(repo, ".mailmap"), "utf-8")).toBe("hand written\n");
});

test("contributors are derived from git history, collapsing aliases via .mailmap", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-contrib-"));
  const wiki = join(repo, "docs", "wiki", "2_milestone");
  mkdirSync(wiki, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "core.hooksPath", "/dev/null"); // isolate from the developer's global hooks
  writeFileSync(join(repo, ".mailmap"), "Su Won <su@work> Suwon Lee <su@personal>\n", "utf-8");

  const commit = (name: string, email: string, file: string) => {
    writeFileSync(join(wiki, file), `---\ntitle: ${file}\n---\nbody\n`, "utf-8");
    git(repo, "add", "-A");
    // --no-verify: a developer's global commit-msg hook must not decide whether this test runs
    git(repo, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "--no-verify", "-m", file);
  };
  commit("Su Won", "su@work", "a.md");
  commit("Suwon Lee", "su@personal", "b.md"); // same human, second identity
  commit("Teammate", "mate@work", "c.md");

  const people = contributors(repo);
  expect(people.map((p) => p.name).sort()).toEqual(["Su Won", "Teammate"]); // two people, not three
  expect(people.find((p) => p.name === "Su Won")?.commits).toBe(2);
});

test("contributors degrades to empty outside a git repo instead of throwing", () => {
  expect(contributors(mkdtempSync(join(tmpdir(), "llmwiki-team-nogit-")))).toEqual([]);
});

// ---- cold-start: owner tag + behind-upstream ---------------------------------------------

test("0_review owner renders as [→ name] in cold-start", () => {
  const repo = mkdtempSync(join(tmpdir(), "llmwiki-team-owner-"));
  const review = join(repo, "docs", "wiki", "0_review");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(repo, "docs", "wiki", "overview.md"), "---\ntitle: OV\n---\nhub", "utf-8");
  writeFileSync(
    join(review, "2026-07-07-direction.md"),
    "---\ntitle: Direction?\nowner: suwon\n---\nQ. confirm?\n",
    "utf-8",
  );
  const out = buildContext(repo);
  expect(out).toContain("[→ suwon]");
});

test("behind-upstream repo gets one team line; up-to-date repo stays silent", () => {
  const base = mkdtempSync(join(tmpdir(), "llmwiki-team-git-"));
  const origin = join(base, "origin.git");
  mkdirSync(origin);
  git(base, "init", "--bare", origin);
  const a = join(base, "a"); // teammate A
  const b = join(base, "b"); // teammate B (the one starting a session)
  git(base, "clone", origin, a);
  git(base, "clone", origin, b);
  for (const c of [a, b]) {
    git(c, "config", "user.email", "t@t");
    git(c, "config", "user.name", "t");
  }
  mkdirSync(join(b, "docs", "wiki"), { recursive: true });
  writeFileSync(join(b, "docs", "wiki", "overview.md"), "---\ntitle: OV\n---\nhub", "utf-8");
  git(b, "add", "."); git(b, "commit", "-m", "docs: wiki scaffold"); git(b, "push", "origin", "HEAD:main");
  git(b, "branch", "--set-upstream-to=origin/main");
  expect(buildContext(b)).not.toMatch(/behind origin|origin보다/); // up to date → silent

  // A merges new wiki context; B fetches but hasn't pulled
  git(a, "pull", "origin", "main");
  writeFileSync(join(a, "note.md"), "x", "utf-8");
  git(a, "add", "."); git(a, "commit", "-m", "docs: teammate context"); git(a, "push", "origin", "HEAD:main");
  git(b, "fetch", "origin");
  const out = buildContext(b);
  expect(out).toMatch(/behind origin|origin보다/);
  expect(out).toMatch(/1/);
});
