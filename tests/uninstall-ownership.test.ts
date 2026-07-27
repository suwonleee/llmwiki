// Uninstall has to be provably complete AND provably narrow.
//
// The old revert restored the newest `settings.json.llmwiki-bak.*`, which is wrong twice over:
// after a second install that backup already CONTAINS llmwiki's hooks (so "revert" reinstalls
// them), and any unrelated hook the user added between the two installs is rolled back with it.
// Removal now works off ownership marks, so these tests pin both halves: everything of ours is
// gone, and everything that is not ours is exactly as it was.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("Claude uninstall removes only what llmwiki owns", () => {
  let dir: string;
  let home: string;
  let profile: string;
  let env: Record<string, string>;

  const settings = () => JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  const commands = (event: string): string[] =>
    (settings().hooks?.[event] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));

  function run(args: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(["bun", join(ROOT, "src", "daemon", "wire.ts"), ...args], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode ?? 1, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-uninstall-"));
    home = join(dir, "home");
    profile = join(dir, "profile");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(profile, "commands"), { recursive: true });
    writeFileSync(
      join(profile, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read", "Bash(ls:*)"] },
        model: "opus",
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "someone-elses-session-hook" }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "someone-elses-turn-hook" }] }],
        },
      }),
    );
    // a command file that is NOT ours must survive, including one with a colliding name shape
    writeFileSync(join(profile, "commands", "my-own-command.md"), "# mine\n");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["claude"]) {
      const file = join(bin, name);
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      chmodSync(file, 0o755);
    }
    env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: profile,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    } as Record<string, string>;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("install → uninstall leaves unrelated configuration byte-for-byte equivalent", () => {
    const before = settings();

    expect(run([]).code).toBe(0);
    expect(commands("SessionStart").some((c) => c.includes("sessionstart-inject.sh"))).toBe(true);
    expect(existsSync(join(profile, "commands", "wiki-save.md"))).toBe(true);

    expect(run(["--revert"]).code).toBe(0);

    const after = settings();
    expect(after.permissions).toEqual(before.permissions);
    expect(after.model).toBe(before.model);
    expect(commands("SessionStart")).toEqual(["someone-elses-session-hook"]);
    expect(commands("UserPromptSubmit")).toEqual(["someone-elses-turn-hook"]);
    for (const name of ["wiki-save.md", "wiki-deep.md", "wiki-ask.md", "wiki-quiz.md", "wiki-doctor.md"]) {
      expect(existsSync(join(profile, "commands", name))).toBe(false);
    }
    expect(readFileSync(join(profile, "commands", "my-own-command.md"), "utf-8")).toBe("# mine\n");
  });

  test("a REPEATED install still uninstalls cleanly (the backup-chronology bug)", () => {
    run([]);
    // between the two installs the user adds a hook of their own
    const s = settings();
    s.hooks.Stop = [{ matcher: "", hooks: [{ type: "command", command: "added-between-installs" }] }];
    writeFileSync(join(profile, "settings.json"), JSON.stringify(s, null, 2));
    run([]);

    expect(run(["--revert"]).code).toBe(0);

    // ours is gone…
    expect(JSON.stringify(settings())).not.toContain("sessionstart-inject.sh");
    expect(JSON.stringify(settings())).not.toContain("userpromptsubmit-inject.sh");
    // …and the hook added between the installs was NOT rolled back with it
    expect(commands("Stop")).toEqual(["added-between-installs"]);
  });

  test("uninstalling twice is a no-op, not an error", () => {
    run([]);
    expect(run(["--revert"]).code).toBe(0);
    const after = JSON.stringify(settings());
    expect(run(["--revert"]).code).toBe(0);
    expect(JSON.stringify(settings())).toBe(after);
  });

  test("a hook installed from ANOTHER clone path is still recognized as ours", () => {
    const s = settings();
    s.hooks.SessionStart.push({
      matcher: "",
      hooks: [{ type: "command", command: "bash '/somewhere/else/hooks/sessionstart-inject.sh'" }],
    });
    writeFileSync(join(profile, "settings.json"), JSON.stringify(s, null, 2));

    run(["--revert"]);

    expect(commands("SessionStart")).toEqual(["someone-elses-session-hook"]);
  });

  test("malformed settings are preserved, owned commands are still removed, and revert fails visibly", () => {
    writeFileSync(join(profile, "commands", "wiki-save.md"), "<!-- installed by llmwiki (owned; removed by uninstall) -->\n");
    writeFileSync(join(profile, "settings.json"), "{ definitely not json\n");

    const result = run(["--revert"]);

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("parse failed");
    expect(result.out).toContain("removal step(s) failed");
    expect(readFileSync(join(profile, "settings.json"), "utf-8")).toBe("{ definitely not json\n");
    expect(existsSync(join(profile, "commands", "wiki-save.md"))).toBe(false);
  });
});
