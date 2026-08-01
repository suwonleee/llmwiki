// Finding `git` when PATH does not have it (src/engine/tool-locate.ts).
//
// This is the engine's single hard dependency: enrollment.ts asks git whether a path is a worktree,
// and "git is missing" is indistinguishable from "not a worktree" — so a daemon that cannot see git
// reports every session as unenrolled and captures nothing, with no error anywhere. launchd hands
// an agent /usr/bin:/bin:/usr/sbin:/sbin, which is exactly how a Homebrew or Nix git goes missing.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gitCommand, locateGit, resetToolCache, serviceSearchPath } from "../src/engine/tool-locate.ts";

const POSIX = process.platform !== "win32";

/** Run a snippet in a child bun with a controlled environment. */
function inChild(env: Record<string, string | undefined>, snippet: string): string {
  const module = join(import.meta.dir, "..", "src", "engine", "tool-locate.ts");
  const script = join(mkdtempSync(join(tmpdir(), "llmwiki-tool-locate-")), "probe.ts");
  writeFileSync(script, `import * as tool from ${JSON.stringify(module)};\n${snippet}\n`);
  try {
    const r = Bun.spawnSync([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env } as Record<string, string>,
    });
    return r.stdout.toString().trim();
  } finally {
    rmSync(dirname(script), { recursive: true, force: true });
  }
}

describe("locateGit", () => {
  test("finds the git this machine actually has", () => {
    resetToolCache();
    const { path } = locateGit();
    expect(path).not.toBeNull();
    expect(path!.endsWith("git")).toBe(true);
    // gitCommand feeds spawn directly, so it must be the resolved path or the bare fallback.
    expect([path, "git"]).toContain(gitCommand());
  });

  test.if(POSIX)("finds git in a package-manager location even with an empty PATH", () => {
    const out = inChild({ PATH: "" }, "console.log(JSON.stringify(tool.locateGit().path))");
    // The well-known list covers /usr/bin, Homebrew, MacPorts, Nix and ~/.local/bin. On any machine
    // that has git at all, at least one of those answers — that is the whole point of the search.
    expect(JSON.parse(out)).not.toBeNull();
  });

  test.if(POSIX)("rejects a candidate that is not really git", () => {
    // A directory full of impostors: the right NAME, the wrong `--version`. A path that merely
    // exists has never been enough for this engine, and it is not enough here either.
    const fake = mkdtempSync(join(tmpdir(), "llmwiki-fakegit-"));
    try {
      const impostor = join(fake, "git");
      writeFileSync(impostor, "#!/bin/sh\necho 'not git at all'\n");
      chmodSync(impostor, 0o755);
      const out = inChild({ PATH: fake }, "console.log(JSON.stringify(tool.locateGit().path))");
      const found = JSON.parse(out);
      expect(found).not.toBe(impostor);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("reports the directories it examined, so a handoff can quote them", () => {
    resetToolCache();
    expect(locateGit().tried.length).toBeGreaterThan(0);
  });
});

describe("serviceSearchPath", () => {
  test("carries the runtime and git directories, so a supervised daemon resolves both", () => {
    resetToolCache();
    const dirs = serviceSearchPath().split(delimiter);
    expect(dirs).toContain(dirname(process.execPath));
    const git = locateGit().path;
    if (git) expect(dirs).toContain(dirname(git));
  });

  test("has no duplicate entries", () => {
    const dirs = serviceSearchPath().split(delimiter);
    expect(dirs.length).toBe(new Set(dirs).size);
  });

  test.if(POSIX)("still finds git when the installing shell's PATH would not", () => {
    // The launchd case, reproduced: the process that writes the service definition has a PATH that
    // cannot see git, and the definition it writes must not inherit that blindness.
    const out = inChild({ PATH: "/nonexistent-for-this-test" }, "console.log(tool.serviceSearchPath())");
    const dirs = out.split(delimiter);
    const git = locateGit().path;
    if (git) expect(dirs).toContain(dirname(git));
  });

  test.if(POSIX)("skips well-known directories that do not exist on this machine", () => {
    const absent = join(tmpdir(), "llmwiki-definitely-absent-bin");
    rmSync(absent, { recursive: true, force: true });
    expect(serviceSearchPath().split(delimiter)).not.toContain(absent);
  });
});

describe("the CLI the installer calls", () => {
  test("--service-path prints one usable PATH line", () => {
    const r = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "engine", "tool-locate.ts"), "--service-path"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(0);
    const printed = r.stdout.toString().trim();
    expect(printed.split(delimiter).length).toBeGreaterThan(1);
    expect(printed).not.toContain("\n");
  });

  test("--git prints the resolved executable", () => {
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "engine", "tool-locate.ts"), "--git"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim().endsWith("git")).toBe(true);
  });

  test("an unknown flag is a usage error, not a silent success", () => {
    const r = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "engine", "tool-locate.ts"), "--what"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode).toBe(2);
  });
});

// A directory that exists but holds no git must not be mistaken for a hit.
test.if(POSIX)("an empty bin directory contributes nothing", () => {
  const empty = mkdtempSync(join(tmpdir(), "llmwiki-emptybin-"));
  mkdirSync(join(empty, "subdir"), { recursive: true });
  try {
    const out = inChild({ PATH: empty }, "console.log(JSON.stringify(tool.locateGit().tried))");
    expect(JSON.parse(out)).toContain(empty);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
