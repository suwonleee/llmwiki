// The one documented uninstall path is best-effort, but it must not turn partial cleanup into
// a success-looking exit. This exercises the real shell entry point with isolated user dirs.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";

const ROOT = join(import.meta.dir, "..");
let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

test("uninstall continues after a wiring failure and exits nonzero with an incomplete summary", () => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-setup-uninstall-"));
  const home = join(scratch, "home");
  const claude = join(scratch, "claude");
  const state = join(scratch, "state");
  mkdirSync(join(claude, "commands"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(claude, "settings.json"), "{ malformed\n");
  writeFileSync(
    join(claude, "commands", "wiki-save.md"),
    "<!-- installed by llmwiki (owned; removed by uninstall) -->\n",
  );

  const bin = inertSupervisorBin(join(scratch, "bin"), {
    bun: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  });

  const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--uninstall"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(scratch, "codex"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_DATA_HOME: join(scratch, "data"),
      LLMWIKI_STATE_DIR: state,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("--- 4) OpenCode plugin + commands + launcher ---");
  expect(output).toContain("uninstall incomplete");
  expect(readFileSync(join(claude, "settings.json"), "utf-8")).toBe("{ malformed\n");
  expect(existsSync(join(claude, "commands", "wiki-save.md"))).toBe(false);
});

test("purge is skipped when the supervised daemon cannot be confirmed stopped", () => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-setup-stop-failure-"));
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(state);
  mkdirSync(bin);
  writeFileSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"), "owned service");
  writeFileSync(join(state, "sentinel"), "must survive");

  // Overrides on top of the inert set: this test's subject is a supervised daemon that refuses to
  // confirm it stopped, so launchctl must list the label and fail the unload.
  inertSupervisorBin(bin, {
    bun: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    launchctl:
      "#!/bin/sh\n" +
      "if [ \"${1:-}\" = unload ]; then exit 1; fi\n" +
      "if [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; exit 0; fi\n" +
      "exit 1\n",
    pgrep: "#!/bin/sh\nexit 0\n",
    pkill: "#!/bin/sh\nexit 1\n",
  });

  const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--uninstall", "--purge-data"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(scratch, "codex"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_DATA_HOME: join(scratch, "data"),
      LLMWIKI_STATE_DIR: state,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("background service was not confirmed stopped");
  expect(existsSync(join(state, "sentinel"))).toBe(true);
  expect(existsSync(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist"))).toBe(true);
});

test("a definitionless loaded launchd job blocks purge when it cannot be stopped", () => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-setup-definitionless-"));
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(state);
  mkdirSync(bin);
  writeFileSync(join(state, "sentinel"), "must survive");
  inertSupervisorBin(bin, {
    bun: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    launchctl:
      "#!/bin/sh\n" +
      "if [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; exit 0; fi\n" +
      "if [ \"${1:-}\" = remove ]; then exit 1; fi\n" +
      "exit 1\n",
  });

  const result = Bun.spawnSync(["bash", join(ROOT, "setup.sh"), "--uninstall", "--purge-data"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(scratch, "codex"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_DATA_HOME: join(scratch, "data"),
      LLMWIKI_STATE_DIR: state,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(output).toContain("definitionless launchd");
  expect(output).toContain("purge skipped");
  expect(existsSync(join(state, "sentinel"))).toBe(true);
});

test("a failed launchd status check blocks shutdown even when the plist is absent", () => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-launchd-unknown-"));
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  inertSupervisorBin(bin, {
    bun: `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    launchctl: "#!/bin/sh\nexit 1\n",
  });

  const result = Bun.spawnSync(["bash", join(ROOT, "daemon", "install.sh"), "--uninstall"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("launchd status could not be verified");
});

test("daemon uninstall matches a watch path containing regex metacharacters literally", async () => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-stop-literal-"));
  const clone = join(scratch, "clone[consumer]");
  const daemonDir = join(clone, "daemon");
  const sourceDir = join(clone, "src", "daemon");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  mkdirSync(daemonDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  copyFileSync(join(ROOT, "daemon", "install.sh"), join(daemonDir, "install.sh"));
  chmodSync(join(daemonDir, "install.sh"), 0o755);
  const watch = join(sourceDir, "watch.ts");
  writeFileSync(watch, "await Bun.sleep(10_000);\n");
  const bunShim = join(bin, "bun");
  writeFileSync(bunShim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
  chmodSync(bunShim, 0o755);
  // This test needs the REAL `ps` — matching the process table literally is its whole subject — so
  // it cannot use the inert set. It still must not reach the real launchd: the label is per-user,
  // so `launchctl remove com.llmwiki.daemon` would delete the developer's own job even though this
  // run is scoped to a scratch clone. crontab is silenced for the same reason.
  for (const [name, body] of Object.entries({
    launchctl: "#!/bin/sh\nexit 0\n",
    crontab: "#!/bin/sh\ncat >/dev/null 2>&1 || true\nexit 0\n",
  })) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  const child = Bun.spawn([process.execPath, realpathSync(watch)], { stdout: "ignore", stderr: "ignore" });
  const decoy = Bun.spawn([process.execPath, "-e", "await Bun.sleep(10_000)", realpathSync(watch)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.sleep(100); // let ps observe the final Bun argv, not the short-lived exec transition

  const result = Bun.spawnSync(["bash", join(daemonDir, "install.sh"), "--uninstall"], {
    cwd: clone,
    env: {
      ...process.env,
      HOME: home,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.exited;

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("stopped running watch.ts");
  expect(decoy.exitCode).toBeNull();
  decoy.kill();
  await decoy.exited;
});
