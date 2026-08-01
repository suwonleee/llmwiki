// Under `--harness all`, "this harness is here" means its CLI is on PATH — not that some
// directory with its name survives in $HOME.
//
// Found by the fresh-public-clone E2E: on a machine holding a leftover `$CODEX_HOME` whose CLI
// is gone, `./setup.sh --harness auto` SKIPS Codex (correctly — no CLI to wire), then runs the
// post-install doctor as `all`, which counted that directory's missing wiring as required
// issues. A complete, working Claude+OpenCode install therefore ended in "setup incomplete;
// setup exits 1" plus a repair command for a harness the person does not run. A red line over a
// fine install is the same defect as a green line over a dead one, so the directory is reported
// as information and the install passes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("doctor harness presence (--harness all)", () => {
  let dir: string;
  let home: string;
  let bin: string;

  const runDoctor = (harness: string) => {
    const result = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli.ts"), "doctor", "--harness", harness], {
      cwd: ROOT,
      env: {
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        LLMWIKI_STATE_DIR: join(dir, "state"),
        LLMWIKI_LANG: "en",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
    };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-doctor-presence-"));
    home = join(dir, "home");
    bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // A daemon this sandbox can see as healthy, on either platform.
    //
    // The assertion below is about HARNESS issues, and the exit code is the total count — so the
    // daemon has to be accounted for or the test is really asking "does the developer happen to
    // have a capture daemon running right now?". It used to pass for exactly that reason: doctor
    // matched any clone's watch.ts, so an unrelated daemon on the developer's machine stood in for
    // this sandbox's. It is clone-specific now (and was always absent in CI), so the sandbox
    // supplies its own supervisor instead of borrowing one.
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"), "<plist/>\n");
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "llmwiki-daemon.service"), "[Service]\n");
    for (const [name, body] of [
      ["launchctl", "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n"],
      ["systemctl", "#!/bin/sh\nexit 0\n"], // `is-active --quiet` succeeds → the unit is running
    ] as const) {
      const file = join(bin, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
    }
    // A Codex home the person left behind, with no llmwiki wiring in it at all.
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    // …and an OpenCode global config in the same state.
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a leftover harness dir without its CLI is reported, not counted as a defect", () => {
    const { code, out } = runDoctor("all");
    expect(out).toContain("[codex] • ");
    expect(out).toContain("not inspected");
    expect(out).toContain("[opencode] • ");
    // No wiring issue is attributed to either harness…
    expect(out).not.toContain("[codex] ⚠️ hooks incomplete");
    expect(out).not.toContain("[opencode] ⚠️ OpenCode CLI not found");
    // …and the install as a whole passes (exit code IS the issue count).
    expect(code).toBe(0);
  });

  test("with the CLI present, `all` inspects that harness and reports its missing wiring", () => {
    const codex = join(bin, "codex");
    writeFileSync(codex, "#!/bin/sh\nexit 0\n");
    chmodSync(codex, 0o755);
    const { code, out } = runDoctor("all");
    expect(out).toContain("[codex] ⚠️");
    expect(code).toBeGreaterThan(0);
  });

  test("naming a harness explicitly always inspects it, CLI present or not", () => {
    const { code, out } = runDoctor("codex");
    expect(out).toContain("[codex] ⚠️");
    expect(out).not.toContain("not inspected");
    expect(code).toBeGreaterThan(0);
  });
});
