import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WIRE = join(ROOT, "src", "daemon", "wire-opencode.ts");
const COMMANDS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;

function run(home: string, configRoot: string, args: string[] = []) {
  return Bun.spawnSync(["bun", WIRE, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("OpenCode wiring", () => {
  let dir: string;
  let home: string;
  let configRoot: string;
  let opencodeRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-opencode-wire-"));
    home = join(dir, "home");
    configRoot = join(dir, "xdg config");
    opencodeRoot = join(configRoot, "opencode");
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("installs an XDG-aware plugin, four slash commands, and a user CLI idempotently", () => {
    expect(run(home, configRoot).exitCode).toBe(0);
    expect(run(home, configRoot).exitCode).toBe(0);

    const plugin = readFileSync(join(opencodeRoot, "plugin", "llmwiki.ts"), "utf8");
    expect(plugin).toContain(`llmwiki-opencode-managed root=${ROOT}`);
    expect(plugin).toContain(`process.env.LLMWIKI_ROOT ?? ${JSON.stringify(ROOT)}`);
    expect(plugin).toContain("const lastPrompt = new Map<string, string>()");

    for (const name of COMMANDS) {
      const command = readFileSync(join(opencodeRoot, "commands", `${name}.md`), "utf8");
      expect(command).toContain(`llmwiki-opencode-managed root=${ROOT}`);
      expect(command).toContain(`# /${name}`);
      expect(command).not.toContain("$CLAUDE_PROJECT_DIR");
      expect(command).not.toContain("~/llmwiki");
    }
    expect(readFileSync(join(opencodeRoot, "commands", "wiki-deep.md"), "utf8")).toContain("$ARGUMENTS");

    const launcher = join(home, ".local", "bin", "llmwiki");
    expect(readFileSync(launcher, "utf8")).toContain("# llmwiki launcher (llmwiki-managed)");
    expect(readFileSync(launcher, "utf8")).toContain(join(ROOT, "src", "cli.ts"));
    expect(statSync(launcher).mode & 0o111).not.toBe(0);

    const pluginBackups = readdirSync(join(opencodeRoot, "plugin")).filter((name) =>
      name.startsWith("llmwiki.ts.llmwiki-bak."),
    );
    expect(pluginBackups).toHaveLength(0);
  });

  test("dry-run validates and reports targets without writing", () => {
    const result = run(home, configRoot, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("DRY-RUN");
    expect(existsSync(opencodeRoot)).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("refuses to overwrite an unrelated slash command", () => {
    const command = join(opencodeRoot, "commands", "wiki-save.md");
    mkdirSync(join(opencodeRoot, "commands"), { recursive: true });
    writeFileSync(command, "---\ndescription: user-owned\n---\nDo something else.\n");

    const result = run(home, configRoot);

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("refusing to overwrite unrelated");
    expect(readFileSync(command, "utf8")).toContain("user-owned");
    expect(existsSync(join(opencodeRoot, "plugin", "llmwiki.ts"))).toBe(false);
  });

  test("migrates the known legacy plugin and bakes in this clone root", () => {
    const plugin = join(opencodeRoot, "plugin", "llmwiki.ts");
    mkdirSync(join(opencodeRoot, "plugin"), { recursive: true });
    writeFileSync(
      plugin,
      "// llmwiki OpenCode plugin\nconst ROOT = process.env.LLMWIKI_ROOT ?? '/old/root';\n// experimental.chat.system.transform\n",
    );

    expect(run(home, configRoot).exitCode).toBe(0);

    const installed = readFileSync(plugin, "utf8");
    expect(installed).toContain(`llmwiki-opencode-managed root=${ROOT}`);
    expect(installed).not.toContain("'/old/root'");
  });

  test("re-pointing and reverting restores the previous managed OpenCode install", () => {
    const otherRoot = "/opt/previous opencode llmwiki";
    const plugin = join(opencodeRoot, "plugin", "llmwiki.ts");
    mkdirSync(join(opencodeRoot, "plugin"), { recursive: true });
    mkdirSync(join(opencodeRoot, "commands"), { recursive: true });
    writeFileSync(
      plugin,
      `// llmwiki-opencode-managed root=${otherRoot} source_sha256=old\nconst ROOT = ${JSON.stringify(otherRoot)};\n`,
    );
    for (const name of COMMANDS) {
      writeFileSync(
        join(opencodeRoot, "commands", `${name}.md`),
        `---\ndescription: previous\n---\n<!-- llmwiki-opencode-managed root=${otherRoot} source_sha256=old -->\n`,
      );
    }
    const launcher = join(home, ".local", "bin", "llmwiki");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const previousLauncher =
      `#!/bin/sh\n# llmwiki launcher (llmwiki-managed)\nexec bun '${otherRoot}/src/cli.ts' "$@"\n`;
    writeFileSync(launcher, previousLauncher);
    chmodSync(launcher, 0o751);

    expect(run(home, configRoot).exitCode).toBe(0);
    expect(readFileSync(plugin, "utf8")).toContain(ROOT);

    const reverted = run(home, configRoot, ["--revert"]);
    expect(reverted.exitCode).toBe(0);
    expect(new TextDecoder().decode(reverted.stdout)).toContain("restored the previous llmwiki install");
    expect(readFileSync(plugin, "utf8")).toContain(otherRoot);
    for (const name of COMMANDS) {
      expect(readFileSync(join(opencodeRoot, "commands", `${name}.md`), "utf8")).toContain(otherRoot);
    }
    expect(readFileSync(launcher, "utf8")).toBe(previousLauncher);
    expect(statSync(launcher).mode & 0o777).toBe(0o751);
  });

  test("OpenCode revert leaves the shared CLI while Codex still uses this clone", () => {
    expect(run(home, configRoot).exitCode).toBe(0);
    const codexSkill = join(home, ".agents", "skills", "wiki-save", "SKILL.md");
    mkdirSync(join(home, ".agents", "skills", "wiki-save"), { recursive: true });
    writeFileSync(codexSkill, `<!-- llmwiki-codex-managed root=${ROOT} -->\n`);

    expect(run(home, configRoot, ["--revert"]).exitCode).toBe(0);

    expect(existsSync(join(home, ".local", "bin", "llmwiki"))).toBe(true);
    expect(existsSync(join(opencodeRoot, "plugin", "llmwiki.ts"))).toBe(false);
  });
});
