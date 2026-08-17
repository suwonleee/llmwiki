import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";

const ROOT = join(import.meta.dir, "..");

describe("setup command contract", () => {
  let dir: string;
  let home: string;
  let codexHome: string;
  let stubBin: string;
  let stubPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-setup-flags-"));
    home = join(dir, "home");
    codexHome = join(dir, "codex");
    stubBin = join(dir, "stub-bin");
    mkdirSync(home, { recursive: true });
    // Inert supervisors first: if a regression ever carries a run past preflight, the child must
    // find these shims — never the machine's real launchd/systemd/cron (support/inert-supervisor.ts).
    inertSupervisorBin(stubBin);
    // stub harness CLIs: the contract must hold no matter what is installed on the developer machine
    for (const [name, body] of [
      ["claude", "#!/bin/sh\nexit 0\n"],
      [
        "codex",
        "#!/bin/sh\nif [ \"${1:-}\" = --help ]; then printf '%s\\n' --dangerously-bypass-hook-trust; fi\nif [ \"${1:-}\" = features ] && [ \"${2:-}\" = list ]; then printf 'hooks stable true\\n'; fi\nexit 0\n",
      ],
      [
        "opencode",
        "#!/bin/sh\nif [ \"${1:-}\" = run ]; then printf '%s\\n' --command; fi\nexit 0\n",
      ],
    ] as const) {
      const file = join(stubBin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    stubPath = [stubBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    return Bun.spawnSync(["bash", join(ROOT, "setup.sh"), ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        PATH: stubPath,
        // Isolation does not end at HOME: the engine resolves OpenCode surfaces XDG-first, so a
        // host that exports XDG_CONFIG_HOME (GitHub's ubuntu runners do) steers discovery away
        // from fixtures planted under the fake home. Pin the family to the fake home and blank
        // the bus handles so no child can reach a live systemd user manager.
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_RUNTIME_DIR: "",
        DBUS_SESSION_BUS_ADDRESS: "",
      },
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
    expect(output).toContain("/wiki-save");
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  // OpenCode 1.18.x prints `run --help` to stderr, so a stdout-only capture read a supported
  // CLI as unsupported and refused to install. The gate must accept help on either stream.
  test("OpenCode dry-run accepts help text emitted only on stderr", () => {
    const opencodeStub = join(stubBin, "opencode");
    writeFileSync(
      opencodeStub,
      "#!/bin/sh\nif [ \"${1:-}\" = run ] && [ \"${2:-}\" = --help ]; then printf '%s\\n' --command >&2; fi\nexit 0\n",
    );
    chmodSync(opencodeStub, 0o755);

    const result = run(["--dry-run", "--harness", "opencode"]);

    expect(result.exitCode).toBe(0);
    const output = new TextDecoder().decode(result.stdout);
    expect(output).toContain("OpenCode");
    expect(output).toContain("/wiki-save");
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, ".local", "bin", "llmwiki"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  // `--dry-run` is the documented read-only preflight, so the capability probe must not leave
  // vendor state behind either: OpenCode persists under XDG_STATE_HOME, which defaults into
  // $HOME/.local/state — a machine that only ever ran the preflight must stay untouched.
  test("the OpenCode capability probe writes no state into HOME", () => {
    const opencodeStub = join(stubBin, "opencode");
    writeFileSync(
      opencodeStub,
      "#!/bin/sh\nSTATE=\"${XDG_STATE_HOME:-$HOME/.local/state}/opencode\"\nmkdir -p \"$STATE\"\n: > \"$STATE/probe-marker\"\nif [ \"${1:-}\" = run ]; then printf '%s\\n' --command; fi\nexit 0\n",
    );
    chmodSync(opencodeStub, 0o755);

    const result = run(["--dry-run", "--harness", "opencode"]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(home, ".local", "state", "opencode"))).toBe(false);
  });

  test("unknown flags fail with usage exit 2", () => {
    const result = run(["--wat"]);
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("Usage:");
  });

  test("Bun older than 1.1 fails before any mutation", () => {
    // These tests are meant to fail BEFORE the daemon step; the inert supervisors make that a
    // property of the sandbox rather than of where the script happens to stop today.
    const bin = inertSupervisorBin(join(dir, "old-bun-bin"), {
      bun: "#!/bin/sh\nif [ \"${1:-}\" = --version ]; then printf '1.0.35\\n'; fi\nexit 0\n",
    });

    const result = Bun.spawnSync(["/bin/bash", join(ROOT, "setup.sh"), "--harness", "codex"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
        PATH: `${bin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("Bun 1.1 or newer is required");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("missing Git fails before any mutation", () => {
    const bin = inertSupervisorBin(join(dir, "missing-git-bin"), {
      bun:
        "#!/bin/sh\n" +
        "if [ \"${1:-}\" = --version ]; then printf '1.3.8\\n'; exit 0; fi\n" +
        "if [ \"${1:-}\" = \"" + ROOT + "/src/engine/tool-locate.ts\" ] && [ \"${2:-}\" = --git ]; then exit 1; fi\n" +
        "exit 99\n",
      claude: "#!/bin/sh\nexit 0\n",
    });

    const result = Bun.spawnSync(["/bin/bash", join(ROOT, "setup.sh"), "--harness", "claude"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(dir, "claude"),
        PATH: `${bin}:/usr/bin:/bin`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("git was not found");
    expect(existsSync(join(dir, "claude", "settings.json"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"))).toBe(false);
  });

  test("Codex setup fails before mutation when the Codex CLI is missing", () => {
    const bin = inertSupervisorBin(join(dir, "bun-only-bin"));
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
    const bin = inertSupervisorBin(join(dir, "bun-only-opencode-bin"));
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
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain("OpenCode CLI not found");
    expect(stderr).not.toContain("To set up only the harnesses that ARE ready");
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("multi-harness preflight names the single-harness recovery path without mutating", () => {
    rmSync(join(stubBin, "opencode"));

    const result = run(["--harness", "all"]);

    expect(result.exitCode).toBe(1);
    const stderr = new TextDecoder().decode(result.stderr);
    expect(stderr).toContain("OpenCode CLI not found");
    expect(stderr).toContain("To set up only the harnesses that ARE ready");
    expect(stderr).toContain("--harness codex|claude|opencode");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "commands"))).toBe(false);
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
    expect(existsSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"))).toBe(false);
  });

  test("Claude command conflicts fail in preflight before daemon mutation", () => {
    const profile = join(dir, "claude");
    const commandDir = join(profile, "commands");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "wiki-save.md"), "# user-owned command\n");

    const result = run(["--harness", "claude"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("Claude command conflict");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"))).toBe(false);
    expect(existsSync(join(profile, "settings.json"))).toBe(false);
    expect(existsSync(join(commandDir, "wiki-save.md"))).toBe(true);
  });

  test("Claude setup refuses a user-owned llmwiki command before daemon mutation", () => {
    const localBin = join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, "llmwiki"), "#!/bin/sh\necho user-owned\n");

    const result = run(["--harness", "claude"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("refusing to overwrite unrelated command");
    expect(readFileSync(join(localBin, "llmwiki"), "utf8")).toContain("user-owned");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"))).toBe(false);
  });

  test("Claude preflight never treats an unrelated /skill/ symlink as llmwiki-owned", () => {
    const profile = join(dir, "claude");
    const commandDir = join(profile, "commands");
    const target = join(dir, "my-tools", "skill", "wiki-save.md");
    mkdirSync(commandDir, { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "# user tool\n");
    symlinkSync(target, join(commandDir, "wiki-save.md"));

    const result = run(["--harness", "claude"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("Claude command conflict");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
  });

  test("OpenCode command conflicts fail in preflight before daemon mutation", () => {
    const commandDir = join(home, ".config", "opencode", "commands");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, "wiki-save.md"), "---\ndescription: user-owned\n---\n");

    const result = run(["--harness", "opencode"]);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("refusing to overwrite unrelated");
    expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(false);
    expect(existsSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"))).toBe(false);
  });
});
