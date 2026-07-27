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
      launchctl:
        "#!/bin/sh\n" +
        "if [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\n" +
        "exit 0\n",
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
    return Bun.spawnSync(["bash", join(ROOT, "setup.sh"), ...args], {
      cwd: ROOT,
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
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(stateRoot)).toBe(false);
  });
});
