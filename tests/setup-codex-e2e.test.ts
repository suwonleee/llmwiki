import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readServiceDefinition, serviceEnvEntry, supervisorStubs } from "./support/service-definition.ts";

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
      // Whichever supervisor THIS platform's install branch uses, so the run succeeds
      // deterministically and never reaches the cron fallback (which would write into the
      // developer's real crontab).
      ...Object.entries(supervisorStubs()),
    ] as const) {
      const file = join(bin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    path = [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("installs refreshed maintenance skills idempotently while leaving trust to /hooks", () => {
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      LLMWIKI_STATE_DIR: join(dir, "state"),
      PATH: path,
      USER: "fresh-codex-user",
    };
    const configPath = join(codexHome, "config.toml");
    const foreignConfig = [
      'model = "gpt-5.6-sol"',
      'developer_instructions = "foreign orchestrator policy"',
      "",
      "[features]",
      "multi_agent = true",
      "",
    ].join("\n");
    writeFileSync(configPath, foreignConfig);
    const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "codex"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("setup installed");
    expect(existsSync(join(dir, "state", "install-receipt.json"))).toBe(true);
    expect(output).toContain("Verify the installation anytime: llmwiki doctor --harness codex");
    expect(output).toContain("One-time Codex activation: start Codex, open /hooks, trust both llmwiki hooks.");
    expect(output).toContain("ACTION REQUIRED");
    expect(output).toContain("one-time review required");
    expect(output).toContain(`export PATH='${join(home, ".local", "bin")}'`);
    expect(readFileSync(configPath, "utf8")).toBe(foreignConfig);
    // The daemon carries the Codex home it was installed with, in this platform's syntax.
    expect(readServiceDefinition(home)).toContain(serviceEnvEntry("CODEX_HOME", codexHome));
    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toContain("sessionstart-inject.sh");
    const savePath = join(home, ".agents", "skills", "wiki-save", "SKILL.md");
    const deepPath = join(home, ".agents", "skills", "wiki-deep", "SKILL.md");
    const doctorPath = join(home, ".agents", "skills", "wiki-doctor", "SKILL.md");
    expect(readFileSync(savePath, "utf8")).toContain("name: wiki-save");
    expect(readFileSync(savePath, "utf8")).toContain("llmwiki db-health <repo> --notice");
    expect(readFileSync(deepPath, "utf8")).toContain("llmwiki compact <repo> --commit");
    expect(readFileSync(deepPath, "utf8")).not.toContain("llmwiki wiki-clean <repo> --commit");
    const doctorSkill = readFileSync(doctorPath, "utf8");
    expect(doctorSkill).toContain("name: wiki-doctor");
    expect(doctorSkill).toContain("llmwiki doctor --harness codex");
    expect(doctorSkill).toContain(`bun ${ROOT}/src/daemon/wire-codex.ts`);
    expect(doctorSkill).toContain("llmwiki wiki-doctor <repo> --fix");
    expect(doctorSkill).not.toContain("~/llmwiki");
    expect(doctorSkill.indexOf("llmwiki doctor --harness codex")).toBeLessThan(
      doctorSkill.indexOf("llmwiki wiki-doctor <repo> --fix"),
    );
    const firstSaveSkill = readFileSync(savePath, "utf8");
    const firstDeepSkill = readFileSync(deepPath, "utf8");

    const rerun = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "codex"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rerun.exitCode).toBe(0);
    expect(readFileSync(savePath, "utf8")).toBe(firstSaveSkill);
    expect(readFileSync(deepPath, "utf8")).toBe(firstDeepSkill);
    expect(readFileSync(doctorPath, "utf8")).toContain("name: wiki-doctor");
    expect(readFileSync(configPath, "utf8")).toBe(foreignConfig);

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
