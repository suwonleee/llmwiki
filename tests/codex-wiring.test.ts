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
const WIRE = join(ROOT, "src", "daemon", "wire-codex.ts");

function run(home: string, codexHome: string, args: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync(["bun", WIRE, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("Codex wiring", () => {
  let dir: string;
  let home: string;
  let codexHome: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-codex-wire-"));
    home = join(dir, "home");
    codexHome = join(dir, "codex");
    mkdirSync(home, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("merges hooks, installs all Codex skills, and adds a user CLI", () => {
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "keep-me" }] }] } }),
    );

    const first = run(home, codexHome);
    expect(first.exitCode).toBe(0);
    const second = run(home, codexHome);
    expect(second.exitCode).toBe(0);

    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    expect(hooks.description).toContain("llmwiki");
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe("keep-me");
    for (const [event, marker] of [
      ["SessionStart", "sessionstart-inject.sh"],
      ["UserPromptSubmit", "userpromptsubmit-inject.sh"],
    ] as const) {
      const commands = hooks.hooks[event].flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
      expect(commands.filter((command: string) => command.includes(marker))).toHaveLength(1);
      expect(commands[0]).toContain(ROOT);
    }
    // Codex spills hook output above ~2,500 approx tokens to a truncated preview — the
    // SessionStart handler must opt out (0 = no spill); turn-context never gets near the limit.
    const handlerFor = (event: string, marker: string) =>
      hooks.hooks[event]
        .flatMap((group: any) => group.hooks)
        .find((hook: any) => String(hook.command).includes(marker));
    expect(handlerFor("SessionStart", "sessionstart-inject.sh").additionalContextLimit).toBe(0);
    expect(handlerFor("UserPromptSubmit", "userpromptsubmit-inject.sh").additionalContextLimit).toBeUndefined();

    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      const skill = readFileSync(join(home, ".agents", "skills", name, "SKILL.md"), "utf8");
      expect(skill).toContain(`name: ${name}`);
      expect(skill).not.toContain("$CLAUDE_PROJECT_DIR");
      expect(skill).not.toContain("~/llmwiki");
    }
    const save = readFileSync(join(home, ".agents", "skills", "wiki-save", "SKILL.md"), "utf8");
    expect(save).toContain("`## 1. <label>`"); // the installed skill carries the structure contract
    expect(save).toContain("supporting detail at `    -`");
    expect(save).toContain("noun phrases or telegraphic endings");
    const deep = readFileSync(join(home, ".agents", "skills", "wiki-deep", "SKILL.md"), "utf8");
    expect(deep).toContain("invoke `$wiki-save` before continuing");
    expect(deep).not.toContain("skill$wiki-save.md");
    expect(deep).not.toContain(`bun ${ROOT}/src/cli.ts`);
    expect(deep).not.toContain("$ARGUMENTS");

    const backups = readdirSync(codexHome).filter((name) => name.startsWith("hooks.json.llmwiki-bak."));
    expect(backups).toHaveLength(1);

    const launcher = join(home, ".local", "bin", "llmwiki");
    expect(readFileSync(launcher, "utf8")).toContain("# llmwiki launcher");
    expect(readFileSync(launcher, "utf8")).toContain(join(ROOT, "src", "cli.ts"));
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  test("dry-run reports actions without changing HOME or CODEX_HOME", () => {
    const result = run(home, codexHome, ["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("DRY-RUN");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  test("keeps foreign Codex config values and reverts config.toml to the exact bytes", () => {
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

    // The only addition is the tagged sandbox entry; every foreign line stays, in place.
    expect(run(home, codexHome).exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8").startsWith(foreignConfig)).toBe(true);
    const merged = readFileSync(configPath, "utf8");
    expect(run(home, codexHome, ["--dry-run"]).exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(merged);
    expect(run(home, codexHome, ["--revert"]).exitCode).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(foreignConfig);
  });

  test("does not overwrite an unrelated llmwiki command", () => {
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "llmwiki");
    writeFileSync(launcher, "#!/bin/sh\necho foreign\n");
    chmodSync(launcher, 0o755);

    const result = run(home, codexHome);
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(launcher, "utf8")).toBe("#!/bin/sh\necho foreign\n");
  });

  test("does not overwrite an unrelated skill", () => {
    const skillDir = join(home, ".agents", "skills", "wiki-save");
    mkdirSync(skillDir, { recursive: true });
    const skill = join(skillDir, "SKILL.md");
    writeFileSync(skill, "---\nname: wiki-save\ndescription: user-owned\n---\n");

    const result = run(home, codexHome);

    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(skill, "utf8")).toContain("user-owned");
    expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  });

  test("rejects a malformed existing hooks schema without rewriting it", () => {
    const hooksPath = join(codexHome, "hooks.json");
    const malformed = JSON.stringify({ hooks: { SessionStart: { hooks: [] } } });
    writeFileSync(hooksPath, malformed);

    const result = run(home, codexHome);

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("hooks.SessionStart must be an array");
    expect(readFileSync(hooksPath, "utf8")).toBe(malformed);
  });

  test("installs a human-invocation gate next to every skill", () => {
    expect(run(home, codexHome).exitCode).toBe(0);
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      const policy = readFileSync(join(home, ".agents", "skills", name, "agents", "openai.yaml"), "utf8");
      // Codex reads this file only; without the gate the model self-invokes the skill mid-task.
      expect(policy).toContain("allow_implicit_invocation: false");
      expect(policy).toContain(`display_name: "$${name}"`);
      expect(policy).toContain("llmwiki-codex-managed");
    }
  });

  test("revert removes the managed gate but leaves a hand-written one", () => {
    expect(run(home, codexHome).exitCode).toBe(0);
    const managed = join(home, ".agents", "skills", "wiki-save", "agents", "openai.yaml");
    const foreign = join(home, ".agents", "skills", "wiki-ask", "agents", "openai.yaml");
    expect(existsSync(managed)).toBe(true);
    writeFileSync(foreign, "policy:\n  allow_implicit_invocation: false\n");

    expect(run(home, codexHome, ["--revert"]).exitCode).toBe(0);
    expect(existsSync(managed)).toBe(false);
    expect(readFileSync(foreign, "utf8")).toContain("allow_implicit_invocation");
  });

  test("revert removes managed skill files but preserves user-added files", () => {
    expect(run(home, codexHome).exitCode).toBe(0);
    const skillDir = join(home, ".agents", "skills", "wiki-save");
    const userFile = join(skillDir, "notes.md");
    writeFileSync(userFile, "keep me\n");

    expect(run(home, codexHome, ["--revert"]).exitCode).toBe(0);
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(false);
    expect(readFileSync(userFile, "utf8")).toBe("keep me\n");
  });

  test("revert does not remove surfaces owned by another clone", () => {
    const otherRoot = "/opt/another-llmwiki";
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: `bash '${otherRoot}/hooks/sessionstart-inject.sh'` }] },
          ],
        },
      }),
    );
    const skillDir = join(home, ".agents", "skills", "wiki-save");
    mkdirSync(skillDir, { recursive: true });
    const skill = join(skillDir, "SKILL.md");
    writeFileSync(skill, `---\nname: wiki-save\ndescription: other\n---\n<!-- llmwiki-codex-managed root=${otherRoot} -->\n`);
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "llmwiki");
    writeFileSync(
      launcher,
      `#!/bin/sh\n# llmwiki launcher (llmwiki-codex-managed)\nexec bun '${otherRoot}/src/cli.ts' "$@"\n`,
    );

    expect(run(home, codexHome, ["--revert"]).exitCode).toBe(0);

    expect(readFileSync(join(codexHome, "hooks.json"), "utf8")).toContain(otherRoot);
    expect(readFileSync(skill, "utf8")).toContain(otherRoot);
    expect(readFileSync(launcher, "utf8")).toContain(otherRoot);
  });

  test("migrates managed legacy $llmwiki-* skills to the shorter $wiki-* names", () => {
    for (const name of ["llmwiki-fast", "llmwiki-ask", "llmwiki-deep", "llmwiki-quiz"]) {
      const skillDir = join(home, ".agents", "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: legacy\n---\n<!-- llmwiki-codex-managed root=${ROOT} -->\n`,
      );
    }
    const legacyDir = join(home, ".agents", "skills", "llmwiki-fast");
    writeFileSync(join(legacyDir, "notes.md"), "keep me\n");

    expect(run(home, codexHome).exitCode).toBe(0);

    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      expect(readFileSync(join(home, ".agents", "skills", name, "SKILL.md"), "utf8")).toContain(
        `name: ${name}`,
      );
    }
    for (const name of ["llmwiki-fast", "llmwiki-ask", "llmwiki-deep", "llmwiki-quiz"]) {
      expect(existsSync(join(home, ".agents", "skills", name, "SKILL.md"))).toBe(false);
    }
    expect(readFileSync(join(legacyDir, "notes.md"), "utf8")).toBe("keep me\n");
  });

  test("re-pointing to this clone and reverting restores the previous managed install", () => {
    const otherRoot = "/opt/previous llmwiki";
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        description: "existing hooks",
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "keep-me" }] }],
          SessionStart: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: `bash '${otherRoot}/hooks/sessionstart-inject.sh'`, timeout: 7 },
              ],
            },
          ],
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: `bash '${otherRoot}/hooks/userpromptsubmit-inject.sh'`, timeout: 8 },
              ],
            },
          ],
        },
      }),
    );
    for (const name of ["llmwiki-fast", "llmwiki-ask", "llmwiki-deep", "llmwiki-quiz"]) {
      const skillDir = join(home, ".agents", "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: previous\n---\n<!-- llmwiki-codex-managed root=${otherRoot} -->\n`,
      );
    }
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, "llmwiki");
    const previousLauncher =
      `#!/bin/sh\n# llmwiki launcher (llmwiki-codex-managed)\nexec bun '${otherRoot}/src/cli.ts' "$@"\n`;
    writeFileSync(launcher, previousLauncher);
    chmodSync(launcher, 0o751);

    expect(run(home, codexHome).exitCode).toBe(0);
    expect(readFileSync(hooksPath, "utf8")).toContain(ROOT);
    expect(readFileSync(launcher, "utf8")).toContain(ROOT);
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      expect(readFileSync(join(home, ".agents", "skills", name, "SKILL.md"), "utf8")).toContain(ROOT);
    }

    const reverted = run(home, codexHome, ["--revert"]);
    expect(reverted.exitCode).toBe(0);
    expect(new TextDecoder().decode(reverted.stdout)).toContain("restored the previous llmwiki install");

    const restoredHooks = readFileSync(hooksPath, "utf8");
    expect(restoredHooks).toContain(otherRoot);
    expect(restoredHooks).not.toContain(ROOT);
    expect(restoredHooks).toContain("keep-me");
    for (const name of ["llmwiki-fast", "llmwiki-ask", "llmwiki-deep", "llmwiki-quiz"]) {
      expect(readFileSync(join(home, ".agents", "skills", name, "SKILL.md"), "utf8")).toContain(otherRoot);
    }
    expect(readFileSync(launcher, "utf8")).toBe(previousLauncher);
    expect(statSync(launcher).mode & 0o777).toBe(0o751);
  });

  describe("hook positions (Codex keys /hooks trust by index)", () => {
    const hooksPath = () => join(codexHome, "hooks.json");
    const commandsOf = (event: string) =>
      JSON.parse(readFileSync(hooksPath(), "utf8")).hooks[event].map((group: any) =>
        group.hooks.map((hook: any) => hook.command),
      );

    test("re-wiring leaves a file with user groups around ours byte-identical", () => {
      expect(run(home, codexHome).exitCode).toBe(0);
      const wired = JSON.parse(readFileSync(hooksPath(), "utf8"));
      wired.hooks.SessionStart.unshift({ hooks: [{ type: "command", command: "user-first" }] });
      wired.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: "user-after" }] });
      writeFileSync(hooksPath(), JSON.stringify(wired, null, 2) + "\n");
      const before = readFileSync(hooksPath(), "utf8");

      expect(run(home, codexHome).exitCode).toBe(0);

      expect(readFileSync(hooksPath(), "utf8")).toBe(before);
      expect(readdirSync(codexHome).filter((name) => name.startsWith("hooks.json.llmwiki-bak"))).toHaveLength(0);
    });

    test("a moved clone is re-pointed where it stands and duplicates are dropped", () => {
      const old = "/opt/old llmwiki";
      writeFileSync(
        hooksPath(),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { matcher: "", hooks: [{ type: "command", command: `bash '${old}/hooks/userpromptsubmit-inject.sh'` }] },
              { matcher: "", hooks: [{ type: "command", command: "user-after" }] },
              { matcher: "", hooks: [{ type: "command", command: `bash '${old}/hooks/userpromptsubmit-inject.sh'` }] },
            ],
          },
        }),
      );

      expect(run(home, codexHome).exitCode).toBe(0);

      const turn = commandsOf("UserPromptSubmit");
      expect(turn).toHaveLength(2);
      expect(turn[0][0]).toContain(`${ROOT}/hooks/userpromptsubmit-inject.sh`);
      expect(turn[1]).toEqual(["user-after"]);
      expect(commandsOf("SessionStart")[0][0]).toContain(`${ROOT}/hooks/sessionstart-inject.sh`);
    });
  });

  describe("sandbox writable root", () => {
    const stateRoot = "/state/llmwiki";
    const withRoot = (root = stateRoot) => ({ LLMWIKI_STATE_DIR: root });
    const configPath = () => join(codexHome, "config.toml");
    const roots = () => (Bun as any).TOML.parse(readFileSync(configPath(), "utf8")).sandbox_workspace_write.writable_roots;
    const cases: Record<string, string> = {
      "no config": "",
      "no table": 'model = "x"\n\n[tui]\nfoo = 1\n',
      "table without the key": "[sandbox_workspace_write]\nnetwork_access = true\n\n[tui]\nx = 1\n",
      "multi-line user array": '[sandbox_workspace_write]\nwritable_roots = [\n  "/a", # mine\n  "/b"\n]\n',
      "single-line user array": '[sandbox_workspace_write]\nwritable_roots = ["/a"] # keep\n',
      "empty user array": "[sandbox_workspace_write]\nwritable_roots = []\n",
    };

    for (const [name, original] of Object.entries(cases)) {
      test(`${name}: merges once, keeps user values, reverts byte-exact`, () => {
        if (original) writeFileSync(configPath(), original, { mode: 0o600 });
        const before = original ? (Bun as any).TOML.parse(original) : {};
        const userRoots: string[] = before.sandbox_workspace_write?.writable_roots ?? [];

        expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
        const first = readFileSync(configPath(), "utf8");
        expect(roots()).toEqual([stateRoot, ...userRoots]);
        if (original) expect(statSync(configPath()).mode & 0o777).toBe(0o600);

        expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
        expect(readFileSync(configPath(), "utf8")).toBe(first);

        expect(run(home, codexHome, ["--revert"], withRoot()).exitCode).toBe(0);
        expect(readFileSync(configPath(), "utf8")).toBe(original);
      });
    }

    test("a moved state root is re-pointed, not duplicated", () => {
      expect(run(home, codexHome, [], withRoot("/old/root")).exitCode).toBe(0);
      expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
      expect(roots()).toEqual([stateRoot]);
    });

    test("a wired table with tables appended after it stays where it is on re-run", () => {
      expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
      // Codex itself appends `[hooks.state."…"]` trust tables after ours.
      writeFileSync(configPath(), readFileSync(configPath(), "utf8") + '\n[hooks.state."x:session_start:0:0"]\ntrusted_hash = "h"\n');
      const before = readFileSync(configPath(), "utf8");

      expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);

      expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("a root the user already lists is left alone and never removed", () => {
      const original = `[sandbox_workspace_write]\nwritable_roots = ["${stateRoot}"]\n`;
      writeFileSync(configPath(), original);
      expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
      expect(readFileSync(configPath(), "utf8")).toBe(original);
      expect(run(home, codexHome, ["--revert"], withRoot()).exitCode).toBe(0);
      expect(readFileSync(configPath(), "utf8")).toBe(original);
    });

    test("backs up config.toml before changing it", () => {
      writeFileSync(configPath(), 'model = "x"\n');
      expect(run(home, codexHome, [], withRoot()).exitCode).toBe(0);
      const backups = readdirSync(codexHome).filter((file) => file.startsWith("config.toml.llmwiki-bak."));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(codexHome, backups[0]), "utf8")).toBe('model = "x"\n');
    });

    test("a form it cannot edit is reported and left untouched; the rest of the wiring still succeeds", () => {
      for (const original of ['sandbox_workspace_write.writable_roots = ["/a"]\n', "model = \n"]) {
        writeFileSync(configPath(), original);
        const result = run(home, codexHome, [], withRoot());
        expect(result.exitCode).toBe(0);
        expect(new TextDecoder().decode(result.stdout)).toContain("sandbox not widened");
        expect(readFileSync(configPath(), "utf8")).toBe(original);
      }
    });

    test("dry-run prints the sandbox entry and writes nothing", () => {
      const result = run(home, codexHome, ["--dry-run"], withRoot());
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `[sandbox_workspace_write].writable_roots += "${stateRoot}"`,
      );
      expect(existsSync(configPath())).toBe(false);
    });
  });
});
