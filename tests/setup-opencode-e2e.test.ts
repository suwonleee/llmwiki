import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("fresh OpenCode setup", () => {
  let dir: string;
  let home: string;
  let configRoot: string;
  let dataRoot: string;
  let dbPath: string;
  let bin: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-setup-&-opencode-"));
    home = join(dir, "home");
    configRoot = join(dir, "xdg config");
    dataRoot = join(dir, "xdg data & local");
    dbPath = join(dataRoot, "opencode", "opencode.db");
    bin = join(dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of [
      [
        "opencode",
        "#!/bin/sh\nif [ \"${1:-}\" = run ] && [ \"${2:-}\" = --help ]; then printf '%s\\n' --command; fi\nexit 0\n",
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

  test("installs refreshed maintenance commands idempotently with the plugin and capture environment", () => {
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      OPENCODE_DB: dbPath,
      LLMWIKI_STATE_DIR: join(dir, "state"),
      PATH: path,
      USER: "fresh-opencode-user",
    };
    const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "opencode"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("setup installed");
    expect(output).toContain("OpenCode close-out: /wiki-save");
    expect(output).toContain("Verify the installation anytime: llmwiki doctor --harness opencode");
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"), "utf8");
    expect(plist).toContain(`<key>XDG_DATA_HOME</key><string>${dataRoot.replaceAll("&", "&amp;")}</string>`);
    expect(plist).toContain(`<key>OPENCODE_DB</key><string>${dbPath.replaceAll("&", "&amp;")}</string>`);

    const opencodeRoot = join(configRoot, "opencode");
    expect(readFileSync(join(opencodeRoot, "plugin", "llmwiki.ts"), "utf8")).toContain(
      `llmwiki-opencode-managed root=${ROOT}`,
    );
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      expect(readFileSync(join(opencodeRoot, "commands", `${name}.md`), "utf8")).toContain(`# /${name}`);
    }
    const savePath = join(opencodeRoot, "commands", "wiki-save.md");
    const deepPath = join(opencodeRoot, "commands", "wiki-deep.md");
    expect(readFileSync(savePath, "utf8")).toContain("llmwiki db-health <repo> --notice");
    expect(readFileSync(deepPath, "utf8")).toContain("llmwiki compact <repo> --commit");
    expect(readFileSync(deepPath, "utf8")).not.toContain("llmwiki wiki-clean <repo> --commit");
    const firstSaveCommand = readFileSync(savePath, "utf8");
    const firstDeepCommand = readFileSync(deepPath, "utf8");

    const rerun = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--harness", "opencode"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rerun.exitCode).toBe(0);
    expect(readFileSync(savePath, "utf8")).toBe(firstSaveCommand);
    expect(readFileSync(deepPath, "utf8")).toBe(firstDeepCommand);
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
