// `doctor --fix` is a REPAIR path, so whatever it writes has to be indistinguishable from what
// the installer writes. It used to plain-copy the skill file, and a plain copy is a different
// file in the two ways every downstream decision reads:
//
//   - no ownership mark → uninstall's ownership check skips it, so it survives forever, and
//     setup's preflight reads it as a file the USER wrote and refuses to wire ANY profile —
//     blocking the `git pull && ./setup.sh` the update notice tells people to run;
//   - `~/llmwiki` placeholder left intact → the command sends the agent to a path that only
//     exists for someone who happened to clone into ~/llmwiki.
//
// A clean-room install reproduced all three. These pin them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CLAUDE_COMMANDS, OWNED_MARK } from "../src/engine/claude-commands.ts";

const ROOT = join(import.meta.dir, "..");

describe("doctor --fix writes installer-identical command files", () => {
  let dir: string;
  let home: string;
  let profile: string;
  let env: Record<string, string>;

  function run(argv: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(argv, { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    return {
      code: r.exitCode ?? 1,
      out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
    };
  }
  const doctorFix = () => run(["bun", join(ROOT, "src", "cli.ts"), "doctor", "--harness", "claude", "--fix"]);
  const wire = (...args: string[]) => run(["bun", join(ROOT, "src", "daemon", "wire.ts"), ...args]);
  const commandsLeft = () => CLAUDE_COMMANDS.filter((c) => existsSync(join(profile, "commands", c)));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-doctor-fix-"));
    home = join(dir, "home");
    profile = join(dir, "profile");
    mkdirSync(home, { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "settings.json"), JSON.stringify({ model: "opus" }));
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // The supervisor tools doctor probes are per-USER, not per-HOME (tests/support/inert-supervisor.ts).
    for (const [name, body] of Object.entries({
      claude: "#!/bin/sh\nexit 0\n",
      launchctl: "#!/bin/sh\nexit 0\n",
      systemctl: "#!/bin/sh\nexit 1\n",
      ps: "#!/bin/sh\nexit 0\n",
      pgrep: "#!/bin/sh\nexit 1\n",
      pkill: "#!/bin/sh\nexit 1\n",
    })) {
      const file = join(bin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    env = {
      ...process.env,
      HOME: home,
      // Pinned, never inherited: an inherited profile root survives HOME sandboxing and these
      // commands would then rewrite the developer's own Claude wiring.
      CLAUDE_CONFIG_DIR: profile,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    } as Record<string, string>;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("repaired commands carry the ownership mark and this clone's path", () => {
    doctorFix();

    expect(commandsLeft()).toEqual([...CLAUDE_COMMANDS]);
    for (const c of CLAUDE_COMMANDS) {
      const body = readFileSync(join(profile, "commands", c), "utf-8");
      expect(body).toContain(OWNED_MARK);
      expect(body).not.toContain("~/llmwiki");
      expect(body).not.toContain("$HOME/llmwiki");
    }
  });

  test("repaired commands are byte-identical to the installer's", () => {
    doctorFix();
    const repaired = CLAUDE_COMMANDS.map((c) => readFileSync(join(profile, "commands", c), "utf-8"));

    for (const c of CLAUDE_COMMANDS) rmSync(join(profile, "commands", c), { force: true });
    expect(wire().code).toBe(0);

    const installed = CLAUDE_COMMANDS.map((c) => readFileSync(join(profile, "commands", c), "utf-8"));
    expect(repaired).toEqual(installed);
  });

  test("uninstall removes what doctor --fix installed", () => {
    doctorFix();
    expect(commandsLeft().length).toBe(CLAUDE_COMMANDS.length);

    expect(wire("--revert").code).toBe(0);

    expect(commandsLeft()).toEqual([]);
  });

  test("setup's preflight does not read doctor --fix output as a user file", () => {
    doctorFix();

    const preflight = wire("--dry-run");

    expect(preflight.code).toBe(0);
    expect(preflight.out).toContain("no command conflicts");
    expect(preflight.out).not.toContain("left every profile untouched");
  });

  test("doctor --fix never follows a dangling command-file symlink", () => {
    const victim = join(dir, "victim.md");
    const commandDir = join(profile, "commands");
    const planted = join(commandDir, "wiki-save.md");
    mkdirSync(commandDir);
    symlinkSync(victim, planted);

    const result = doctorFix();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("unsafe command destination");
    expect(lstatSync(planted).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(false);
  });

  test("doctor --fix never writes through a symlinked commands directory", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(profile, "commands"));

    const result = doctorFix();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("unsafe command directory");
    expect(CLAUDE_COMMANDS.some((name) => existsSync(join(outside, name)))).toBe(false);
  });

  test("installer preflight rejects a symlinked commands directory before changing settings", () => {
    const outside = join(dir, "outside");
    const settings = join(profile, "settings.json");
    const original = readFileSync(settings, "utf-8");
    mkdirSync(outside);
    symlinkSync(outside, join(profile, "commands"));

    const result = wire();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("command conflict");
    expect(readFileSync(settings, "utf-8")).toBe(original);
    expect(CLAUDE_COMMANDS.some((name) => existsSync(join(outside, name)))).toBe(false);
  });
});
