// The service definitions must carry a PATH (daemon/install.sh).
//
// launchd hands an agent `/usr/bin:/bin:/usr/sbin:/sbin`; a systemd --user unit and a cron @reboot
// line get little more. The daemon shells out to `git` on every enrollment check, so a Homebrew,
// Nix or MacPorts git that the installing shell found perfectly well is invisible to the service
// that does the work — and the failure is silent by construction: enrollment.ts cannot distinguish
// "git is missing" from "not a git worktree", so every session routes to skipped, the queue fills
// with nothing, and doctor stays green.
//
// All three branches are exercised here, on any host, by stubbing `uname` and the supervisors.
// Linux's two branches otherwise have no test at all — the only OS-gated daemon test is macOS's.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** What the stubbed `bun … tool-locate.ts --service-path` reports back to the installer. */
const FAKE_SERVICE_PATH = "/fixture/git/bin:/fixture/bun/bin:/usr/bin:/bin";

let scratch = "";
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

interface Sandbox {
  readonly out: string;
  readonly code: number | null;
  readonly plist: string | null;
  readonly unit: string | null;
  readonly crontab: string | null;
}

interface Options {
  /** What the stubbed `uname` prints — "Darwin" or "Linux". */
  readonly kernel: string;
  readonly launchctl?: boolean;
  readonly launchctlList?: string;
  readonly systemd?: boolean;
  readonly crontab?: boolean;
  /** Omit the --service-path answer, as an older engine or a failed probe would. */
  readonly serviceLocator?: boolean;
}

/**
 * Run daemon/install.sh fully sandboxed: isolated HOME and state, every supervisor stubbed, and a
 * COPY of the script inside a scratch clone.
 *
 * The isolation has to include the script itself. install.sh derives ROOT from its own location and
 * its fallback stops any process whose command line names that ROOT's watch.ts — running the
 * repository's own copy would therefore match, and kill, the developer's real capture daemon.
 */
function runInstall(opts: Options): Sandbox {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-service-path-"));
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  const sysbin = join(scratch, "sysbin");
  const cronFile = join(scratch, "crontab.txt");
  for (const dir of [home, bin, sysbin]) mkdirSync(dir, { recursive: true });

  // An explicit tool list, never the inherited PATH: `launchctl` lives in /bin, so "pretend it is
  // absent" would otherwise run the REAL one and load a temp-dir plist into the developer's launchd
  // under the shared label.
  const tools =
    "bash sh env mkdir rm ls cat grep sed awk tr head tail sort wc chmod cp mv find ps sleep kill basename dirname date nohup id";
  for (const tool of tools.split(" ")) {
    for (const dir of ["/bin", "/usr/bin"]) {
      if (!existsSync(join(dir, tool))) continue;
      try {
        symlinkSync(join(dir, tool), join(sysbin, tool));
      } catch {
        /* already linked */
      }
      break;
    }
  }

  const stub = (name: string, body: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };

  // `uname` is stubbed so the Linux branches are reachable from a macOS developer machine — and the
  // macOS branch from a Linux CI runner. Neither platform can otherwise test the other's install.
  stub("uname", `printf '%s\\n' ${JSON.stringify(opts.kernel)}`);

  // `bun` shim: answers the two calls install.sh makes of it, and exits immediately when asked to
  // launch watch.ts so the fallback's background start leaves no process behind.
  stub(
    "bun",
    "case \"$*\" in\n" +
      `  *state-bootstrap.ts*) mkdir -p ${JSON.stringify(state)}; echo ${JSON.stringify(state)};;\n` +
      (opts.serviceLocator === false
        ? "  *tool-locate.ts*) exit 1;;\n"
        : `  *tool-locate.ts*) printf '%s\\n' ${JSON.stringify(FAKE_SERVICE_PATH)};;\n`) +
      "  *) exit 0;;\n" +
      "esac",
  );

  if (opts.launchctl) {
    stub("launchctl", `[ "$1" = "list" ] && printf '%s' ${JSON.stringify(opts.launchctlList ?? "")}\nexit 0`);
  }
  if (opts.systemd) {
    // `show-environment` is the probe install.sh uses to decide a user manager is really there.
    stub("systemctl", "exit 0");
  }
  if (opts.crontab !== false) {
    // Capture what would be installed instead of touching the developer's real crontab.
    stub("crontab", `if [ "$1" = "-l" ]; then cat ${JSON.stringify(cronFile)} 2>/dev/null; else cat > ${JSON.stringify(cronFile)}; fi\nexit 0`);
  }

  const clone = join(scratch, "clone");
  mkdirSync(join(clone, "daemon"), { recursive: true });
  mkdirSync(join(clone, "src", "daemon"), { recursive: true });
  mkdirSync(join(clone, "src", "engine"), { recursive: true });
  copyFileSync(join(ROOT, "daemon", "install.sh"), join(clone, "daemon", "install.sh"));
  writeFileSync(join(clone, "src", "daemon", "watch.ts"), "// never executed: bun is stubbed\n");
  writeFileSync(join(clone, "src", "engine", "tool-locate.ts"), "// never executed: bun is stubbed\n");

  const r = Bun.spawnSync(["/bin/bash", join(clone, "daemon", "install.sh")], {
    env: { HOME: home, PATH: `${bin}:${sysbin}`, LLMWIKI_STATE_DIR: state },
  });
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  };
  return {
    out: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""),
    code: r.exitCode,
    plist: read(join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist")),
    unit: read(join(home, ".config", "systemd", "user", "llmwiki-daemon.service")),
    crontab: read(cronFile),
  };
}

describe("every supervisor branch bakes a PATH into its service definition", () => {
  test("launchd: the plist carries PATH alongside the other environment keys", () => {
    const { plist } = runInstall({ kernel: "Darwin", launchctl: true, launchctlList: "1\t0\tcom.llmwiki.daemon\n" });

    expect(plist).not.toBeNull();
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(`<string>${FAKE_SERVICE_PATH}</string>`);
    // The git directory is the reason this exists at all.
    expect(plist).toContain("/fixture/git/bin");
  });

  test("systemd: the unit sets Environment=PATH", () => {
    const { unit } = runInstall({ kernel: "Linux", systemd: true });

    expect(unit).not.toBeNull();
    expect(unit).toContain(`Environment="PATH=${FAKE_SERVICE_PATH}"`);
    expect(unit).toContain("ExecStart=");
  });

  test("cron: the @reboot line starts with PATH", () => {
    const { crontab, out } = runInstall({ kernel: "Linux", systemd: false });

    expect(out).toContain("registered cron @reboot line");
    expect(crontab).not.toBeNull();
    expect(crontab).toContain("@reboot PATH=");
    expect(crontab).toContain("/fixture/git/bin");
    // The environment the daemon needs must survive alongside PATH, not be replaced by it.
    expect(crontab).toContain("LLMWIKI_STATE_DIR=");
  });

  test("a PATH that cannot be computed degrades to the installer's own, never to empty", () => {
    // An install must not produce a service with `PATH=` set to nothing: that is strictly worse
    // than inheriting the supervisor's minimal default, because it breaks even /usr/bin.
    const { unit } = runInstall({ kernel: "Linux", systemd: true, serviceLocator: false });

    expect(unit).not.toBeNull();
    expect(unit).toContain('Environment="PATH=');
    expect(unit).not.toContain('Environment="PATH="');
  });
});

/**
 * The unattended-update scheduler, which had no non-macOS branch at all: on Linux it wrote a plist
 * into a directory launchd does not read there, printed "scheduled", and nothing ever ran. The
 * "fully autonomous" switch simply did not exist off macOS, and no document said so.
 */
function runSchedule(opts: { kernel: string; systemd: boolean; crontab?: boolean; args?: string[] }): Sandbox {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-autoupdate-schedule-"));
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  const sysbin = join(scratch, "sysbin");
  const cronFile = join(scratch, "crontab.txt");
  for (const dir of [home, bin, sysbin]) mkdirSync(dir, { recursive: true });

  for (const tool of "bash sh env mkdir rm ls cat grep sed awk tr head tail sort wc chmod cp mv dirname basename printf".split(" ")) {
    for (const dir of ["/bin", "/usr/bin"]) {
      if (!existsSync(join(dir, tool))) continue;
      try {
        symlinkSync(join(dir, tool), join(sysbin, tool));
      } catch {
        /* already linked */
      }
      break;
    }
  }
  const stub = (name: string, body: string): void => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("uname", `printf '%s\\n' ${JSON.stringify(opts.kernel)}`);
  stub(
    "bun",
    "case \"$*\" in\n" +
      `  *state-bootstrap.ts*) mkdir -p ${JSON.stringify(state)}; echo ${JSON.stringify(state)};;\n` +
      `  *tool-locate.ts*) printf '%s\\n' ${JSON.stringify(FAKE_SERVICE_PATH)};;\n` +
      "  *) exit 0;;\n" +
      "esac",
  );
  if (opts.systemd) stub("systemctl", "exit 0");
  if (opts.crontab !== false) {
    stub("crontab", `if [ "$1" = "-l" ]; then cat ${JSON.stringify(cronFile)} 2>/dev/null; else cat > ${JSON.stringify(cronFile)}; fi\nexit 0`);
  }

  const clone = join(scratch, "clone");
  mkdirSync(join(clone, "daemon"), { recursive: true });
  mkdirSync(join(clone, "src", "engine"), { recursive: true });
  copyFileSync(join(ROOT, "daemon", "autoupdate-schedule.sh"), join(clone, "daemon", "autoupdate-schedule.sh"));
  writeFileSync(join(clone, "daemon", "autoupdate-all.sh"), "# never executed by this test\n");
  writeFileSync(join(clone, "src", "engine", "tool-locate.ts"), "// never executed: bun is stubbed\n");

  const r = Bun.spawnSync(["/bin/bash", join(clone, "daemon", "autoupdate-schedule.sh"), ...(opts.args ?? [])], {
    env: { HOME: home, PATH: `${bin}:${sysbin}`, LLMWIKI_STATE_DIR: state },
  });
  const read = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  };
  return {
    out: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""),
    code: r.exitCode,
    plist: read(join(home, "Library", "LaunchAgents", "com.llmwiki.autoupdate.plist")),
    unit: read(join(home, ".config", "systemd", "user", "llmwiki-autoupdate.timer")),
    crontab: read(cronFile),
  };
}

describe("the unattended-update switch exists on every platform", () => {
  test("systemd: a --user timer is written and enabled", () => {
    const { unit, out, code } = runSchedule({ kernel: "Linux", systemd: true, args: ["--at-hours", "8,14"] });

    expect(code).toBe(0);
    expect(out).toContain("systemd --user");
    expect(unit).toContain("OnCalendar=*-*-* 8,14:00:00");
    // Persistent: a machine asleep at 08:00 must still run the missed job, as launchd coalesces.
    expect(unit).toContain("Persistent=true");
  });

  test("systemd: an interval schedule becomes a recurring timer, not a calendar one", () => {
    const { unit } = runSchedule({ kernel: "Linux", systemd: true, args: ["--interval-hours", "6"] });

    expect(unit).toContain("OnUnitActiveSec=6h");
    expect(unit).not.toContain("OnCalendar");
  });

  test("cron: the entry carries PATH and the state dir, so `claude` resolves when it fires", () => {
    const { crontab, out, code } = runSchedule({
      kernel: "Linux",
      systemd: false,
      args: ["--at-hours", "9", "--per-repo", "2"],
    });

    expect(code).toBe(0);
    expect(out).toContain("via cron");
    expect(crontab).toContain("0 9 * * *");
    expect(crontab).toContain("PATH=");
    expect(crontab).toContain("--per-repo 2");
  });

  test("with no scheduler at all it refuses instead of claiming success", () => {
    const { out, code } = runSchedule({ kernel: "Linux", systemd: false, crontab: false });

    expect(code).not.toBe(0);
    expect(out).toContain("nothing to schedule with");
    // The manual command is the honest fallback — silence here used to read as "it is running".
    expect(out).toContain("autoupdate-all.sh");
  });

  test("uninstall is safe to run when nothing was ever scheduled", () => {
    const { out, code } = runSchedule({ kernel: "Linux", systemd: true, args: ["--uninstall"] });

    expect(code).toBe(0);
    expect(out.toLowerCase()).toContain("off");
  });
});

describe("the Linux branches report what they actually did", () => {
  test("systemd install names the unit and the runtime", () => {
    const { out, code } = runInstall({ kernel: "Linux", systemd: true });

    expect(out).toContain("installed + started systemd --user");
    expect(out).toContain("llmwiki-daemon.service");
    expect(code).toBe(0);
  });

  test("without a supervisor it still starts capture and says it will not survive a reboot", () => {
    const { out, code } = runInstall({ kernel: "Linux", systemd: false, crontab: false });

    expect(out).toContain("started watch.ts in background");
    expect(out).toContain("will NOT auto-restart on reboot");
    expect(code).toBe(0);
  });
});
