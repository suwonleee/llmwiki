// The enrollment marker is the whole activation boundary, so every way it can be faked,
// inherited, or moved is a test here.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MARKER_BASENAME,
  MARKER_DIR,
  canonicalWorktree,
  disable,
  enroll,
  inspectEnrollment,
  isEnrolled,
  isEnrolledFresh,
  markerBytes,
  OPT_OUT_BASENAME,
  explain,
  resetEnrollmentCache,
  worktreeGitDir,
} from "../src/engine/enrollment.ts";
import { git, makeGitRepo, tempDir } from "./support/git-repo.ts";

const dirs: string[] = [];
const POSIX = process.platform !== "win32";

function scratch(): string {
  const dir = tempDir("llmwiki-enroll-");
  dirs.push(dir);
  return dir;
}

function repo(): string {
  return makeGitRepo(join(mk(), "repo"));
}

function mk(): string {
  const base = scratch();
  mkdirSync(join(base, "repo"), { recursive: true });
  return base;
}

function markerOf(worktree: string): string {
  return join(worktreeGitDir(worktree)!, MARKER_DIR, MARKER_BASENAME);
}

afterEach(() => {
  resetEnrollmentCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("enrollment marker", () => {
  test("init writes the exact path, bytes and mode; nothing before it is enrolled", () => {
    const r = repo();
    expect(isEnrolled(r)).toBe(false);
    expect(inspectEnrollment(r).reason).toBe("no-marker");

    resetEnrollmentCache();
    const result = enroll(r);
    expect(result.ok).toBe(true);

    const marker = markerOf(r);
    expect(result.markerPath).toBe(marker);
    expect(marker).toBe(join(r, ".git", MARKER_DIR, MARKER_BASENAME));
    expect(readFileSync(marker, "utf-8")).toBe(markerBytes(canonicalWorktree(r)!));
    expect(readFileSync(marker, "utf-8")).toBe(`{"version":1,"worktree":${JSON.stringify(r)}}\n`);
    if (POSIX) {
      expect(lstatSync(marker).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(r, ".git", MARKER_DIR)).mode & 0o777).toBe(0o700);
    }
    resetEnrollmentCache();
    expect(isEnrolled(r)).toBe(true);
  });

  test("the marker is untracked — git never sees it, so no clone or commit can deliver one", () => {
    const r = repo();
    enroll(r);
    const status = spawnSync("git", ["-C", r, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf-8",
    });
    expect(status.stdout ?? "").not.toContain(MARKER_BASENAME);
  });

  test("re-running init is idempotent and replaces the marker atomically", () => {
    const r = repo();
    enroll(r);
    const first = readFileSync(markerOf(r), "utf-8");
    const again = enroll(r);
    expect(again.ok).toBe(true);
    expect(readFileSync(markerOf(r), "utf-8")).toBe(first);
    // no temp siblings survive
    expect(existsSync(join(r, ".git", MARKER_DIR))).toBe(true);
    resetEnrollmentCache();
    expect(isEnrolled(r)).toBe(true);
  });

  test("a non-git directory is never enrolled", () => {
    const plain = scratch();
    expect(isEnrolled(plain)).toBe(false);
    expect(inspectEnrollment(plain).reason).toBe("not-a-git-worktree");
    expect(enroll(plain).ok).toBe(false);
  });

  test("a copied marker does not enroll another repository", () => {
    const a = repo();
    const b = repo();
    enroll(a);
    const stolen = readFileSync(markerOf(a), "utf-8");
    mkdirSync(join(b, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(join(b, ".git", MARKER_DIR, MARKER_BASENAME), stolen, { mode: 0o600 });
    resetEnrollmentCache();
    expect(isEnrolled(b)).toBe(false);
    expect(inspectEnrollment(b).reason).toBe("marker-foreign-worktree");
  });

  test("moving the worktree invalidates enrollment until init is re-run", () => {
    const base = scratch();
    const original = makeGitRepo(join(base, "before"));
    enroll(original);
    resetEnrollmentCache();
    expect(isEnrolled(original)).toBe(true);

    const moved = join(base, "after");
    renameSync(original, moved);
    resetEnrollmentCache();
    expect(isEnrolled(moved)).toBe(false);
    expect(inspectEnrollment(moved).reason).toBe("marker-foreign-worktree");

    expect(enroll(moved).ok).toBe(true);
    resetEnrollmentCache();
    expect(isEnrolled(moved)).toBe(true);
  });

  test("malformed, extra-key, wrong-version and oversized markers all read as disabled", () => {
    const cases: [string, string][] = [
      ["marker-malformed", "not json at all\n"],
      ["marker-malformed", '{"version":1}\n'],
      ["marker-malformed", '[{"version":1,"worktree":"/tmp"}]\n'],
      ["marker-wrong-version", '{"version":2,"worktree":"__WT__"}\n'],
      ["marker-foreign-worktree", '{"version":1,"worktree":"/somewhere/else"}\n'],
    ];
    for (const [reason, body] of cases) {
      const r = repo();
      const marker = join(r, ".git", MARKER_DIR, MARKER_BASENAME);
      mkdirSync(join(r, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
      writeFileSync(marker, body.replace("__WT__", canonicalWorktree(r)!), { mode: 0o600 });
      resetEnrollmentCache();
      expect(inspectEnrollment(r).reason).toBe(reason as any);
      expect(isEnrolled(r)).toBe(false);
    }
    // extra key
    const r2 = repo();
    mkdirSync(join(r2, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(r2, ".git", MARKER_DIR, MARKER_BASENAME),
      `{"version":1,"worktree":${JSON.stringify(canonicalWorktree(r2))},"trust":"all"}\n`,
      { mode: 0o600 },
    );
    resetEnrollmentCache();
    expect(isEnrolled(r2)).toBe(false);

    // oversized
    const r3 = repo();
    mkdirSync(join(r3, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(r3, ".git", MARKER_DIR, MARKER_BASENAME),
      `{"version":1,"worktree":${JSON.stringify(canonicalWorktree(r3))},"pad":"${"x".repeat(5000)}"}\n`,
      { mode: 0o600 },
    );
    resetEnrollmentCache();
    expect(inspectEnrollment(r3).reason).toBe("marker-too-large");
  });

  test("only the canonical one-line marker bytes are accepted", () => {
    const r = repo();
    const marker = join(r, ".git", MARKER_DIR, MARKER_BASENAME);
    mkdirSync(join(r, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    writeFileSync(
      marker,
      `${JSON.stringify({ version: 1, worktree: canonicalWorktree(r) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    resetEnrollmentCache();
    expect(inspectEnrollment(r).reason).toBe("marker-malformed");
    expect(isEnrolled(r)).toBe(false);
  });

  test("fresh checks observe external disable even when the normal predicate is cached", () => {
    const r = repo();
    expect(enroll(r).ok).toBe(true);
    resetEnrollmentCache();
    expect(isEnrolled(r)).toBe(true);
    unlinkSync(markerOf(r));
    expect(isEnrolled(r)).toBe(true);
    expect(isEnrolledFresh(r)).toBe(false);
  });

  test("a symlinked marker is never followed", () => {
    const r = repo();
    const base = scratch();
    const decoy = join(base, "decoy.json");
    writeFileSync(decoy, markerBytes(canonicalWorktree(r)!), { mode: 0o600 });
    mkdirSync(join(r, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    symlinkSync(decoy, join(r, ".git", MARKER_DIR, MARKER_BASENAME));
    resetEnrollmentCache();
    expect(inspectEnrollment(r).reason).toBe("marker-not-regular-file");
    expect(isEnrolled(r)).toBe(false);
  });

  test("a symlinked marker DIRECTORY is refused instead of written through", () => {
    const r = repo();
    const base = scratch();
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(r, ".git", MARKER_DIR));
    const result = enroll(r);
    expect(result.ok).toBe(false);
    expect(existsSync(join(outside, MARKER_BASENAME))).toBe(false); // nothing written through the link
  });

  test.skipIf(!POSIX)("a group/world-readable marker reads as disabled", () => {
    const r = repo();
    enroll(r);
    chmodSync(markerOf(r), 0o644);
    resetEnrollmentCache();
    expect(inspectEnrollment(r).reason).toBe("marker-permissive-mode");
  });

  test("a linked worktree's own marker never enrolls its siblings or the primary", () => {
    const base = scratch();
    const primary = makeGitRepo(join(base, "primary"));
    const linkedA = join(base, "wt-a");
    const linkedB = join(base, "wt-b");
    git(primary, ["worktree", "add", "-q", "-b", "a", linkedA]);
    git(primary, ["worktree", "add", "-q", "-b", "b", linkedB]);

    // each worktree resolves to its OWN git dir (never the shared common dir)
    expect(worktreeGitDir(linkedA)).not.toBe(worktreeGitDir(primary));
    expect(worktreeGitDir(linkedA)).not.toBe(worktreeGitDir(linkedB));

    enroll(linkedA);
    resetEnrollmentCache();
    expect(isEnrolled(linkedA)).toBe(true);
    expect(isEnrolled(linkedB)).toBe(false);
    expect(isEnrolled(primary)).toBe(false); // enrolling a linked worktree never trusts the primary

    enroll(primary);
    resetEnrollmentCache();
    expect(isEnrolled(primary)).toBe(true);
    // …while the primary's enrollment IS inherited by its linked worktrees (same .git, same consent)
    expect(isEnrolled(linkedB)).toBe(true);
    expect(inspectEnrollment(linkedB).inheritedFrom).toBe(primary);
    expect(inspectEnrollment(linkedA).inheritedFrom).toBeUndefined(); // own marker is the answer
  });

  test("disable removes only this worktree's marker", () => {
    const base = scratch();
    const primary = makeGitRepo(join(base, "primary"));
    const linked = join(base, "wt");
    git(primary, ["worktree", "add", "-q", "-b", "wt", linked]);
    enroll(primary);
    enroll(linked);
    resetEnrollmentCache();

    disable(linked);
    resetEnrollmentCache();
    expect(isEnrolled(linked)).toBe(false);
    expect(isEnrolled(primary)).toBe(true);
    expect(existsSync(markerOf(primary))).toBe(true);

    // idempotent
    expect(disable(linked).ok).toBe(true);
  });

  test("disable unlinks a planted symlink instead of deleting its target", () => {
    const r = repo();
    const base = scratch();
    const victim = join(base, "victim.txt");
    writeFileSync(victim, "KEEP\n");
    mkdirSync(join(r, ".git", MARKER_DIR), { recursive: true, mode: 0o700 });
    symlinkSync(victim, join(r, ".git", MARKER_DIR, MARKER_BASENAME));

    disable(r);

    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, "utf-8")).toBe("KEEP\n");
  });
});

describe("linked worktree inheritance", () => {
  function primaryWithLinked(): { primary: string; linked: string } {
    const base = scratch();
    const primary = makeGitRepo(join(base, "primary"));
    const linked = join(base, "wt");
    git(primary, ["worktree", "add", "-q", "-b", "wt", linked]);
    return { primary, linked };
  }

  test("a linked worktree of an enrolled main inherits, reads its own tree, and says so", () => {
    const { primary, linked } = primaryWithLinked();
    expect(isEnrolled(linked)).toBe(false); // main not enrolled → nothing to inherit
    expect(inspectEnrollment(linked).reason).toBe("no-marker");

    enroll(primary);
    resetEnrollmentCache();
    const st = inspectEnrollment(join(linked)); // any path inside the linked worktree
    expect(st.enabled).toBe(true);
    expect(st.reason).toBe("enabled");
    expect(st.worktree).toBe(realpathSync(linked)); // reads bind to the linked checkout itself
    expect(st.inheritedFrom).toBe(primary);
    expect(st.mainWorktree).toBe(primary);
    expect(existsSync(markerOf(linked))).toBe(false); // inheritance writes nothing
    expect(explain(st)).toContain("inherited");
    expect(explain(st, true)).toContain("상속");

    // revoking the main revokes every inheriting worktree
    disable(primary);
    resetEnrollmentCache();
    expect(isEnrolled(linked)).toBe(false);
  });

  test("disable on a linked worktree opts it out and wins over inheritance; init re-enables", () => {
    const { primary, linked } = primaryWithLinked();
    enroll(primary);
    resetEnrollmentCache();
    expect(isEnrolled(linked)).toBe(true);

    expect(disable(linked).ok).toBe(true);
    resetEnrollmentCache();
    const st = inspectEnrollment(linked);
    expect(st.enabled).toBe(false);
    expect(st.reason).toBe("opted-out");
    expect(isEnrolledFresh(linked)).toBe(false);
    expect(isEnrolled(primary)).toBe(true); // the main tree is untouched
    expect(existsSync(markerOf(primary))).toBe(true);
    const optOut = join(worktreeGitDir(linked)!, MARKER_DIR, OPT_OUT_BASENAME);
    expect(existsSync(optOut)).toBe(true);
    if (POSIX) expect(lstatSync(optOut).mode & 0o777).toBe(0o600);
    expect(disable(linked).ok).toBe(true); // idempotent

    // an opt-out recorded BEFORE the main is enrolled still holds afterwards
    disable(primary);
    enroll(primary);
    resetEnrollmentCache();
    expect(isEnrolled(linked)).toBe(false);

    enroll(linked);
    resetEnrollmentCache();
    expect(isEnrolled(linked)).toBe(true);
    expect(inspectEnrollment(linked).inheritedFrom).toBeUndefined();
    expect(existsSync(optOut)).toBe(false);
  });

  test("an opt-out of any file type (a planted symlink included) reads as opted out", () => {
    const { primary, linked } = primaryWithLinked();
    enroll(primary);
    const dir = join(worktreeGitDir(linked)!, MARKER_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync("/nonexistent", join(dir, OPT_OUT_BASENAME));
    resetEnrollmentCache();
    expect(inspectEnrollment(linked).reason).toBe("opted-out");
  });

  test("a broken own marker is never papered over by inheritance", () => {
    const { primary, linked } = primaryWithLinked();
    enroll(primary);
    const dir = join(worktreeGitDir(linked)!, MARKER_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, MARKER_BASENAME), '{"version":1,"worktree":"/somewhere/else"}\n', { mode: 0o600 });
    resetEnrollmentCache();
    expect(inspectEnrollment(linked).reason).toBe("marker-foreign-worktree");
    expect(isEnrolled(linked)).toBe(false);
  });

  test("a moved main (marker names another path) gives its linked worktrees nothing to inherit", () => {
    const { primary, linked } = primaryWithLinked();
    const dir = join(primary, ".git", MARKER_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, MARKER_BASENAME), '{"version":1,"worktree":"/somewhere/else"}\n', { mode: 0o600 });
    resetEnrollmentCache();
    expect(isEnrolled(primary)).toBe(false);
    expect(isEnrolled(linked)).toBe(false);
    expect(inspectEnrollment(linked).mainWorktree).toBeNull();
  });

  test("the primary never inherits from a linked worktree", () => {
    const { primary, linked } = primaryWithLinked();
    enroll(linked);
    resetEnrollmentCache();
    expect(isEnrolled(primary)).toBe(false);
    expect(inspectEnrollment(primary).mainWorktree).toBeNull();
  });
});
