import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("setup command contract", () => {
  let dir: string;
  let home: string;
  let codexHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-setup-flags-"));
    home = join(dir, "home");
    codexHome = join(dir, "codex");
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    return Bun.spawnSync(["bash", join(ROOT, "setup.sh"), ...args], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: join(dir, "claude") },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("setup.sh is executable in a fresh clone", () => {
    expect(statSync(join(ROOT, "setup.sh")).mode & 0o111).not.toBe(0);
  });

  test("--help is read-only", () => {
    const result = run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("Usage:");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });

  test("--dry-run is read-only and shows the selected harness", () => {
    const result = run(["--dry-run", "--harness", "codex"]);
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain("DRY-RUN");
    expect(output).toContain("Codex");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });

  test("OpenCode dry-run is read-only and shows slash-command targets", () => {
    const result = run(["--dry-run", "--harness", "opencode"]);
    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain("OpenCode");
    expect(output).toContain("/wiki-fast");
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("unknown flags fail with usage exit 2", () => {
    const result = run(["--wat"]);
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("Usage:");
  });

  test("Codex setup fails before mutation when the Codex CLI is missing", () => {
    const bin = join(dir, "bun-only-bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const result = Bun.spawnSync(["/bin/bash", join(ROOT, "setup.sh"), "--harness", "codex"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        PATH: `${bin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("Codex CLI not found");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("OpenCode setup fails before mutation when the OpenCode CLI is missing", () => {
    const bin = join(dir, "bun-only-opencode-bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "bun"));
    const result = Bun.spawnSync(["/bin/bash", join(ROOT, "setup.sh"), "--harness", "opencode"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PATH: `${bin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("OpenCode CLI not found");
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("Codex conflicts fail in preflight before daemon mutation", () => {
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "llmwiki"), "#!/bin/sh\necho user-owned\n");

    const result = run(["--harness", "codex"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("refusing to overwrite unrelated command");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("OpenCode command conflicts fail in preflight before daemon mutation", () => {
    const commandDir = join(home, ".config", "opencode", "commands");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "wiki-fast.md"), "---\ndescription: user-owned\n---\n");

    const result = run(["--harness", "opencode"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("refusing to overwrite unrelated");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });
});
