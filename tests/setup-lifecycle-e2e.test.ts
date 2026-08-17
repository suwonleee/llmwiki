// Public-consumer lifecycle: one setup path must survive reinstall and then remove every surface
// it owns without rolling back user configuration. Run against isolated harness homes/state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";
import { serviceDefinitionPath, supervisorStubs } from "./support/service-definition.ts";

const ROOT = join(import.meta.dir, "..");

describe("setup lifecycle across every harness", () => {
  let scratch = "";
  let home = "";
  let claude = "";
  let codexHome = "";
  let configRoot = "";
  let stateRoot = "";
  let env: Record<string, string>;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "llmwiki-lifecycle-all-"));
    home = join(scratch, "home");
    claude = join(scratch, "claude");
    codexHome = join(scratch, "codex");
    configRoot = join(scratch, "config");
    stateRoot = join(scratch, "state");
    const bin = join(scratch, "bin");
    for (const dir of [home, claude, codexHome, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(claude, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "keep-session-hook" }] }],
        },
      }),
    );
    const binaries: Record<string, string> = {
      claude: "#!/bin/sh\nexit 0\n",
      codex:
        "#!/bin/sh\n" +
        "if [ \"${1:-}\" = --help ]; then printf '%s\\n' --dangerously-bypass-hook-trust; fi\n" +
        "if [ \"${1:-}\" = features ] && [ \"${2:-}\" = list ]; then printf 'hooks stable true\\n'; fi\n" +
        "exit 0\n",
      opencode:
        "#!/bin/sh\n" +
        "if [ \"${1:-}\" = run ] && [ \"${2:-}\" = --help ]; then printf '%s\\n' --command; fi\n" +
        "exit 0\n",
      // The supervisor THIS platform's install branch uses, so the run succeeds deterministically
      // here rather than falling through to the cron path.
      ...supervisorStubs(),
    };
    // Inert supervisors first, this suite's harness stubs on top — an uninstall run here would
    // otherwise reach the developer's own launchd job and running daemon.
    inertSupervisorBin(bin, binaries);
    env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: join(scratch, "data"),
      OPENCODE_DB: join(scratch, "data", "opencode", "opencode.db"),
      LLMWIKI_STATE_DIR: stateRoot,
      PATH: [bin, join(home, ".local", "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      USER: "llmwiki-lifecycle-user",
    } as Record<string, string>;
  });

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  function setup(...args: string[]) {
    return setupAt(ROOT, ...args);
  }

  function setupAt(root: string, ...args: string[]) {
    return Bun.spawnSync(["bash", join(root, "setup.sh"), ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("install → user edit → reinstall → unified purge uninstall is complete and narrow", () => {
    expect(setup("--harness", "all").exitCode).toBe(0);

    const settingsPath = join(claude, "settings.json");
    const edited = JSON.parse(readFileSync(settingsPath, "utf-8"));
    edited.hooks.Stop = [{ matcher: "", hooks: [{ type: "command", command: "added-between-installs" }] }];
    writeFileSync(settingsPath, JSON.stringify(edited, null, 2) + "\n");

    expect(setup("--harness", "all").exitCode).toBe(0);
    const removed = setup("--uninstall", "--purge-data");
    const output = (removed.stdout?.toString() ?? "") + (removed.stderr?.toString() ?? "");

    expect(removed.exitCode).toBe(0);
    expect(output).toContain("=== uninstall complete ===");
    const finalSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(finalSettings.permissions).toEqual({ allow: ["Read"] });
    expect(JSON.stringify(finalSettings)).not.toContain("llmwiki");
    expect(finalSettings.hooks.SessionStart[0].hooks[0].command).toBe("keep-session-hook");
    expect(finalSettings.hooks.Stop[0].hooks[0].command).toBe("added-between-installs");

    expect(existsSync(join(claude, "commands", "wiki-save.md"))).toBe(false);
    expect(readFileSync(join(codexHome, "hooks.json"), "utf-8")).not.toContain("llmwiki");
    expect(existsSync(join(home, ".agents", "skills", "wiki-save", "SKILL.md"))).toBe(false);
    expect(existsSync(join(configRoot, "opencode", "plugin", "llmwiki.ts"))).toBe(false);
    expect(existsSync(join(configRoot, "opencode", "commands", "wiki-save.md"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "llmwiki"))).toBe(false);
    // Whichever supervisor this platform installed, its definition is gone too.
    expect(existsSync(serviceDefinitionPath(home))).toBe(false);
    expect(existsSync(stateRoot)).toBe(false);
  });

  test("a second public clone re-points every managed runtime surface without manual cleanup", () => {
    const cloneA = join(scratch, "public clone A");
    const cloneB = join(scratch, "public clone B");
    for (const clone of [cloneA, cloneB]) {
      const result = Bun.spawnSync(["git", "clone", "--quiet", ROOT, clone], {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    }

    expect(setupAt(cloneA, "--harness", "all").exitCode).toBe(0);
    const moved = setupAt(cloneB, "--harness", "all");
    const output = (moved.stdout?.toString() ?? "") + (moved.stderr?.toString() ?? "");
    expect(moved.exitCode, output).toBe(0);

    const managed = [
      readFileSync(join(claude, "settings.json"), "utf-8"),
      readFileSync(join(codexHome, "hooks.json"), "utf-8"),
      readFileSync(join(configRoot, "opencode", "plugin", "llmwiki.ts"), "utf-8"),
      readFileSync(join(home, ".local", "bin", "llmwiki"), "utf-8"),
      readFileSync(join(home, ".agents", "skills", "wiki-save", "SKILL.md"), "utf-8"),
      readFileSync(serviceDefinitionPath(home), "utf-8"),
    ];
    for (const content of managed) {
      expect(content).toContain(cloneB);
      expect(content).not.toContain(cloneA);
    }

    const launcher = Bun.spawnSync([join(home, ".local", "bin", "llmwiki"), "--version"], {
      cwd: cloneB,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(launcher.exitCode).toBe(0);
  });
});
