import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("fresh Claude Code setup", () => {
  let dir: string;
  let home: string;
  let profile: string;
  let bin: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-setup-&-claude-"));
    home = join(dir, "home");
    profile = join(dir, "claude profile & work");
    bin = join(dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(profile, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(profile, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "keep-session-hook" }] }],
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "keep-stop-hook" }] }],
        },
      }),
    );
    for (const [name, body] of [
      ["claude", "#!/bin/sh\nexit 0\n"],
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

  test("merges both hooks, installs all commands, and remains idempotent", () => {
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: profile,
      PATH: path,
      USER: "fresh-claude-user",
    };
    const runSetup = () =>
      Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "claude"], {
        cwd: ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

    const result = runSetup();
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("setup installed");
    expect(output).toContain("Claude Code close-out: /wiki-save");
    expect(output).toContain(`${process.execPath} ${ROOT}/src/cli.ts init <repo>`);
    expect(output).toContain(`${process.execPath} ${ROOT}/src/cli.ts doctor --harness claude`);
    expect(output).not.toContain("Initialize a project: llmwiki init <repo>");
    expect(output).toContain("read-injection hook present");
    expect(output).toContain("turn-context hook present");
    expect(output).toContain("commands present");

    const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"), "utf8");
    expect(plist).toContain(
      `<key>CLAUDE_CONFIG_DIR</key><string>${profile.replaceAll("&", "&amp;")}</string>`,
    );

    const settingsPath = join(profile, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Read"] });
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("keep-stop-hook");
    expect(settings.hooks.SessionStart.flatMap((group: any) => group.hooks.map((hook: any) => hook.command))).toEqual(
      expect.arrayContaining(["keep-session-hook", `bash ${ROOT}/hooks/sessionstart-inject.sh`]),
    );
    expect(
      settings.hooks.UserPromptSubmit.flatMap((group: any) => group.hooks.map((hook: any) => hook.command)),
    ).toContain(`bash ${ROOT}/hooks/userpromptsubmit-inject.sh`);

    const installed: Record<string, string> = {};
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      const command = join(profile, "commands", `${name}.md`);
      installed[name] = readFileSync(command, "utf8");
      expect(installed[name]).toContain(`# /${name}`);
      if (name !== "wiki-doctor") expect(installed[name]).toContain(ROOT);
      expect(installed[name]).not.toContain("~/llmwiki");
    }
    expect(installed["wiki-save"]).toContain("supporting detail at four spaces (`    -`)");
    expect(installed["wiki-save"]).toContain("noun phrases or telegraphic endings");

    const rerun = runSetup();
    expect(rerun.exitCode).toBe(0);
    const rerunSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const sessionCommands = rerunSettings.hooks.SessionStart.flatMap((group: any) =>
      group.hooks.map((hook: any) => hook.command),
    );
    const turnCommands = rerunSettings.hooks.UserPromptSubmit.flatMap((group: any) =>
      group.hooks.map((hook: any) => hook.command),
    );
    expect(sessionCommands.filter((command: string) => command.includes("sessionstart-inject.sh"))).toHaveLength(1);
    expect(turnCommands.filter((command: string) => command.includes("userpromptsubmit-inject.sh"))).toHaveLength(1);
    expect(sessionCommands).toContain("keep-session-hook");
    expect(rerunSettings.hooks.Stop[0].hooks[0].command).toBe("keep-stop-hook");
    for (const [name, content] of Object.entries(installed)) {
      expect(readFileSync(join(profile, "commands", `${name}.md`), "utf8")).toBe(content);
    }
  });
});
