// Team-mode support (all additive — solo behavior unchanged):
//   • teammate transcript citations: the PRE-EXISTING self-heal (autoRegisterCitedTranscripts)
//     registers every clean cited `.jsonl` as a virtual source on index/refs rebuild, so a
//     teammate's citation NEVER lints as unresolved. The team flow depends on this — pin it.
//   • skeleton: idempotently ensures .gitignore(.llmwiki/) + .gitattributes(log.md merge=union).
//   • ensureAuthor: stamps `author:` into frontmatter (no-op without git identity/frontmatter).
//   • cold-start: `owner:` on a 0_review item renders as [→ name]; behind-upstream repos get
//     one informational line.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Linter, type WikiIndexLike } from "../src/engine/lint.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { autoRegisterCitedTranscripts } from "../src/engine/refs.ts";
import { ensureSkeleton, ensureAuthor, gitUserName } from "../src/engine/update.ts";
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

// ---- ensureAuthor -------------------------------------------------------------------------

test("ensureAuthor stamps author into frontmatter once (or no-ops without git identity)", () => {
  const page = "---\ntitle: T\ndate: 2026-07-07\n---\n\nbody";
  const out = ensureAuthor(page);
  if (gitUserName()) {
    expect(out).toContain(`author: ${gitUserName()}`);
    expect(ensureAuthor(out)).toBe(out); // idempotent
  } else {
    expect(out).toBe(page);
  }
  expect(ensureAuthor("no frontmatter body")).toBe("no frontmatter body");
  const withAuthor = "---\ntitle: T\nauthor: someone-else\n---\nbody";
  expect(ensureAuthor(withAuthor)).toBe(withAuthor); // declared author wins
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
