// A shared wiki arrives from someone else's commit — including its symlinks.
//
// git stores a symlink as its target path, so a teammate (or a pull from a fork) can put
// `docs/wiki/overview.md` -> /absolute/path/outside/the/repo into MY checkout. Every engine write
// used plain writeFileSync/appendFileSync, which FOLLOWS that link: a close-out then overwrites a
// file outside the project with wiki text, and an append would first read the victim's content and
// could copy it into a committed page.
//
// The engine owns these paths, so the rule is: never follow, never read the target — replace the
// link with a regular file holding our own content, atomically.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, ensureSkeleton } from "../src/engine/update.ts";
import { normalizeOverview } from "../src/engine/overview.ts";
import { refreshGapQueue } from "../src/engine/gaps.ts";
import {
  RepoBoundaryError,
  appendRepoFile,
  ensureRepoDir,
  readRepoFile,
  readRepoFileBytes,
  repoFileExists,
  repoFileMetadata,
  repoRelative,
  writeRepoFile,
} from "../src/engine/repo-write.ts";

const dirs: string[] = [];
const VICTIM_BODY = "PRIVATE-CONTENT-DO-NOT-TOUCH\n";

function sandbox(): { repo: string; victim: string } {
  const base = mkdtempSync(join(tmpdir(), "llmwiki-symlink-"));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(join(repo, "docs", "wiki", "0_review"), { recursive: true });
  const victim = join(base, "outside-the-repo.txt");
  writeFileSync(victim, VICTIM_BODY, "utf8");
  return { repo, victim };
}

function expectReplaced(path: string, victim: string): void {
  expect(readFileSync(victim, "utf8")).toBe(VICTIM_BODY); // the target is never written
  expect(lstatSync(path).isSymbolicLink()).toBe(false); // the link itself is gone
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repository writes never follow a symlink", () => {
  test("overview normalization never imports a symlink target into the repository", () => {
    const { repo, victim } = sandbox();
    const overview = join(repo, "docs", "wiki", "overview.md");
    writeFileSync(victim, "---\ntitle: Overview\n---\n\n## Recent Updates\n- one\n- two\n", "utf8");
    symlinkSync(victim, overview);

    const result = normalizeOverview(repo);

    expect(result.verdict).toBe("skip");
    expect(lstatSync(overview).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toContain("- one");
    expect(readFileSync(victim, "utf8")).not.toContain("[[log.md]]");
  });

  test("the gap queue replaces a symlinked gap-queue.md", () => {
    const { repo, victim } = sandbox();
    writeFileSync(
      join(repo, "docs", "wiki", "0_review", "semantic-review-2026-07-25.md"),
      "---\ntitle: Semantic review\ndate: 2026-07-25\ntags: [review, meta]\nstatus: draft\n---\n\n## Missing concept page\n\n- amount parsing has no page [[3_decision/d]]\n",
      "utf8",
    );
    const queue = join(repo, "docs", "wiki", "0_review", "gap-queue.md");
    symlinkSync(victim, queue);

    const result = refreshGapQueue(repo, "2026-07-25");

    expect(result.verdict).toBe("refreshed");
    expectReplaced(queue, victim);
    expect(readFileSync(queue, "utf8")).toContain("## Open (1)");
  });

  test("a log append replaces a symlinked log.md without copying the target's content", () => {
    const { repo, victim } = sandbox();
    const log = join(repo, "docs", "wiki", "log.md");
    symlinkSync(victim, log);

    appendLog(repo, "review", "a session", ["one bullet"], "2026-07-25");

    expectReplaced(log, victim);
    const written = readFileSync(log, "utf8");
    expect(written).toContain("## [2026-07-25] review | a session");
    expect(written).not.toContain("PRIVATE-CONTENT"); // the victim's body never enters the repo
  });

  test("skeleton creation replaces a symlinked current-state.md", () => {
    const { repo, victim } = sandbox();
    const l0 = join(repo, "docs", "wiki", "current-state.md");
    symlinkSync(victim, l0);

    ensureSkeleton(repo);

    expectReplaced(l0, victim);
    expect(readFileSync(l0, "utf8")).toContain("Current State");
  });

  test("readRepoFile reports a symlinked path as absent instead of returning its target", () => {
    const { repo, victim } = sandbox();
    const page = join(repo, "docs", "wiki", "page.md");
    symlinkSync(victim, page);

    expect(readRepoFile(repo, "docs/wiki/page.md")).toBeNull();
    expect(readRepoFileBytes(repo, "docs/wiki/page.md")).toBeNull();
    expect(repoFileMetadata(repo, "docs/wiki/page.md")).toBeNull();
    writeFileSync(join(repo, "docs", "wiki", "real.md"), VICTIM_BODY, "utf8");
    expect(readRepoFile(repo, "docs/wiki/real.md")).toBe(VICTIM_BODY); // a regular file still reads normally
  });
});

// The leaf check above is only half the boundary. `docs/wiki -> /somewhere/else` makes every leaf
// under it a perfectly ordinary regular file — the escape already happened one level up — so the
// path has to be verified component by component, and a repository-relative path may not be
// absolute or carry `..` in the first place.
describe("the repository boundary contains every component of a path", () => {
  test("an ancestor symlink makes reads absent and refuses writes", () => {
    const { repo, victim } = sandbox();
    const outside = join(repo, "..", "outside-tree");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), VICTIM_BODY, "utf8");
    rmSync(join(repo, "docs", "wiki"), { recursive: true, force: true });
    symlinkSync(outside, join(repo, "docs", "wiki")); // the classic: swap the whole wiki dir

    expect(readRepoFile(repo, "docs/wiki/secret.md")).toBeNull();
    expect(repoFileExists(repo, "docs/wiki/secret.md")).toBe(false);
    expect(() => writeRepoFile(repo, "docs/wiki/secret.md", "OURS\n")).toThrow(RepoBoundaryError);
    expect(() => ensureRepoDir(repo, "docs/wiki/3_decision")).toThrow(RepoBoundaryError);

    // the sentinel outside the repository is untouched in content and topology
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe(VICTIM_BODY);
    expect(existsSync(join(outside, "3_decision"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_BODY);
  });

  test("absolute paths, traversal, NUL and empty components are refused", () => {
    const { repo } = sandbox();
    const cases = [
      "/etc/passwd",
      "../escape.md",
      "docs/../../escape.md",
      "docs/wiki/../../../escape.md",
      "docs//wiki/page.md",
      "docs/./wiki/page.md",
      "docs/wiki/pa\0ge.md",
      "",
    ];
    for (const bad of cases) {
      expect(() => writeRepoFile(repo, bad, "x")).toThrow(RepoBoundaryError);
      expect(() => ensureRepoDir(repo, bad)).toThrow(RepoBoundaryError);
      expect(readRepoFile(repo, bad)).toBeNull();
      expect(repoFileExists(repo, bad)).toBe(false);
    }
    expect(existsSync(join(repo, "..", "escape.md"))).toBe(false);
  });

  test("repoRelative refuses a path that only looks contained", () => {
    const { repo } = sandbox();
    expect(repoRelative(repo, join(repo, "docs", "wiki", "a.md"))).toBe(join("docs", "wiki", "a.md"));
    expect(() => repoRelative(repo, join(repo, "..", "sibling", "a.md"))).toThrow(RepoBoundaryError);
    expect(() => repoRelative(repo, `${repo}-suffix/a.md`)).toThrow(RepoBoundaryError); // prefix ≠ containment
  });

  test("an atomic write leaves no temp sibling behind", () => {
    const { repo } = sandbox();
    writeRepoFile(repo, "docs/wiki/page.md", "one\n");
    writeRepoFile(repo, "docs/wiki/page.md", "two\n");
    expect(readRepoFile(repo, "docs/wiki/page.md")).toBe("two\n");
    const leftovers = readdirSync(join(repo, "docs", "wiki")).filter((f) => f.includes("llmwiki-tmp"));
    expect(leftovers).toEqual([]);
  });

  test("an append never reads through a symlink before rewriting it", () => {
    const { repo, victim } = sandbox();
    symlinkSync(victim, join(repo, "docs", "wiki", "log.md"));
    appendRepoFile(repo, "docs/wiki/log.md", "ours\n");
    expect(readFileSync(victim, "utf8")).toBe(VICTIM_BODY);
    expect(readFileSync(join(repo, "docs", "wiki", "log.md"), "utf8")).toBe("ours\n");
  });
});
