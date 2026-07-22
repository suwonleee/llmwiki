import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("fresh Codex setup", () => {
  let dir: string;
  let home: string;
  let codexHome: string;
  let bin: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-setup-&-codex-"));
    home = join(dir, "home");
    codexHome = join(dir, "codex");
    bin = join(dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const unrelatedClaude = join(home, ".claude");
    mkdirSync(unrelatedClaude, { recursive: true });
    writeFileSync(
      join(unrelatedClaude, "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash /another/clone/hooks/sessionstart-inject.sh" }] }] } }),
    );
    for (const [name, body] of [
      [
        "codex",
        "#!/bin/sh\nif [ \"${1:-}\" = --help ]; then printf '%s\\n' --dangerously-bypass-hook-trust; fi\nif [ \"${1:-}\" = features ] && [ \"${2:-}\" = list ]; then printf 'hooks stable true\\n'; fi\nexit 0\n",
      ],
      [
        "launchctl",
        "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n",
      ],
    ] as const) {
      const file = join(bin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    path = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("installs a usable CLI, hooks, and skills while leaving trust to /hooks", () => {
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      PATH: path,
      USER: "fresh-codex-user",
    };
    const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "codex"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("setup installed");
    expect(output).toContain("ACTION REQUIRED");
    expect(output).toContain("one-time review required");
    expect(output).toContain(`export PATH='${join(home, ".local", "bin")}'`);
    expect(readFileSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"), "utf8")).toContain(
      `<key>CODEX_HOME</key><string>${codexHome.replaceAll("&", "&amp;")}</string>`,
    );
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toContain("sessionstart-inject.sh");
    expect(readFileSync(join(home, ".agents", "skills", "wiki-save", "SKILL.md"), "utf8")).toContain(
      "name: wiki-save",
    );

    const cli = Bun.spawnSync([join(home, ".local", "bin", "llmwiki"), "--help"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(new TextDecoder().decode(cli.stdout)).toContain("usage: llmwiki");
  });
});
