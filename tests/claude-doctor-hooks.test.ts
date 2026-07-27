// doctor must accept a hook wired by wire.ts VERBATIM. wire.ts registers the command
// unquoted (`bash <root>/hooks/...`); doctor's own repair path writes it shellQuoted.
// Both spellings point at the same clone, so neither may be reported as "different clone".
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("doctor accepts wire.ts hook spelling", () => {
  let dir: string;
  let home: string;
  let profile: string;
  let stubBin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-doc-hooks-"));
    home = join(dir, "home");
    profile = join(dir, "claude");
    stubBin = join(dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(profile, { recursive: true });
    mkdirSync(stubBin, { recursive: true });
    const launchctl = join(stubBin, "launchctl");
    writeFileSync(launchctl, "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n");
    chmodSync(launchctl, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function doctor(settings: object): string {
    writeFileSync(join(profile, "settings.json"), JSON.stringify(settings));
    const result = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), "doctor", "--harness", "claude"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_CONFIG_DIR: profile,
        PATH: [stubBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  }

  function settingsWith(command: (script: string) => string): object {
    return {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: command(`${ROOT}/hooks/sessionstart-inject.sh`) }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: command(`${ROOT}/hooks/userpromptsubmit-inject.sh`) }] }],
      },
    };
  }

  test("unquoted wire.ts spelling counts as wired to this clone", () => {
    const out = doctor(settingsWith((script) => `bash ${script}`));
    expect(out).toContain("read-injection hook present");
    expect(out).toContain("turn-context hook present");
    expect(out).not.toContain("different clone");
  });

  test("shellQuoted repair spelling counts as wired to this clone", () => {
    const out = doctor(settingsWith((script) => `bash '${script}'`));
    expect(out).toContain("read-injection hook present");
    expect(out).toContain("turn-context hook present");
    expect(out).not.toContain("different clone");
  });

  test("a hook pointing at another clone is still flagged", () => {
    const out = doctor(settingsWith(() => "bash /another/clone/hooks/sessionstart-inject.sh"));
    expect(out).toContain("different clone");
  });
});

// A health report earns its place by being actionable, so the instruction has to run. This one
// shipped naming `llmwiki prune` for a command that is spelled `capture-prune` — the report looked
// authoritative and sent the reader to a usage error, which is worse than saying nothing.
describe("doctor's advice is runnable", () => {
  test("every llmwiki command doctor recommends actually exists", () => {
    const doctor = readFileSync(join(ROOT, "src", "engine", "doctor.ts"), "utf-8");
    const recommended = [...new Set([...doctor.matchAll(/`llmwiki ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
    expect(recommended.length).toBeGreaterThan(0); // the extraction itself must keep working

    const usage = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts")]);
    const known = new Set(
      ((usage.stdout?.toString() ?? "") + (usage.stderr?.toString() ?? ""))
        .split("\n")
        .find((l) => l.startsWith("commands:"))
        ?.replace("commands:", "")
        .split(",")
        .map((c) => c.trim()) ?? [],
    );

    expect(recommended.filter((c) => !known.has(c))).toEqual([]);
  });
});
