// Talking to the capture daemon: is it running, and can this process restart it?
//
// Two things live here that used to be spread across cli.ts and doctor.ts as platform assumptions:
//
//   1. "Is watch.ts running?" was `pgrep -f daemon/watch.ts`. pgrep is absent from BusyBox and from
//      a plain Debian container, and `-f` matches a REGEX, so a clone path containing `[` never
//      matched its own daemon. procfs answers both objections: no subprocess, and argv compared
//      NUL-by-NUL is an exact match.
//   2. "Restart it" was a launchctl command line printed for the user to copy — on every platform,
//      including the ones where that command does not exist. The engine knows which supervisor it
//      installed; it can just do it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";

const HOME = process.env.HOME?.trim() || homedir();
export const DAEMON_LABEL = "com.llmwiki.daemon";
export const DAEMON_UNIT = "llmwiki-daemon.service";
export const DAEMON_PLIST = join(HOME, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`);
export const DAEMON_SYSTEMD_UNIT = join(HOME, ".config", "systemd", "user", DAEMON_UNIT);

const RUN_TIMEOUT_MS = 5000;

interface RunResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
}

function run(argv: string[]): RunResult {
  try {
    const r = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "ignore",
      timeout: RUN_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return { ok: true, code: r.exitCode ?? 1, stdout: r.stdout.toString() };
  } catch {
    return { ok: false, code: 1, stdout: "" };
  }
}

/** The watch.ts this clone would run. Matching on it keeps sibling clones independent. */
function watchScript(): string {
  return join(CLONE_ROOT, "src", "daemon", "watch.ts");
}

/** PIDs running THIS clone's watch.ts, read from procfs. Null when there is no procfs to read. */
function watchPidsFromProc(script: string): number[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null; // macOS/BSD
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(join("/proc", entry, "cmdline"), "utf-8");
    } catch {
      continue; // exited between readdir and read, or belongs to another user
    }
    // argv entries are NUL-separated; an exact element match is the whole point.
    if (cmdline.split("\0").some((arg) => arg === script)) pids.push(pid);
  }
  return pids;
}

/**
 * Is this clone's capture daemon process alive?
 *
 * `ps` first, procfs last — the same order daemon/install.sh uses, and for the same reason: the
 * test suite replaces `ps`/`pgrep` with inert shims so a test cannot observe or act on the
 * developer's real process table, and reading procfs first would walk past those shims on Linux.
 * A `ps` that runs is an answer; procfs covers the BusyBox case where `ps -axo` is not one.
 */
export function watchProcessRunning(): boolean {
  const script = watchScript();
  const ps = run(["ps", "-axo", "pid=,command="]);
  // Exit 0 alone is not an answer: a partial `-o` implementation (some BusyBox builds) exits 0
  // while printing a format with no per-process rows at all. A real listing always contains at
  // least one "<pid> <command>" line — this very process. No parseable rows → keep falling.
  if (ps.ok && ps.code === 0 && /^\s*\d+\s+\S/m.test(ps.stdout)) return ps.stdout.includes(script);
  const pgrep = run(["pgrep", "-f", "daemon/watch.ts"]);
  if (pgrep.ok && pgrep.code === 0) return true;
  const fromProc = watchPidsFromProc(script);
  return fromProc !== null && fromProc.length > 0;
}

export type DaemonMechanism = "launchd" | "systemd" | "unsupervised" | "absent";

/**
 * Which supervisor is holding the daemon — as installed on THIS machine, not as guessed from
 * `process.platform`. A macOS box whose launchd refused the plist runs the same unsupervised
 * process a minimal container does.
 */
export function daemonMechanism(): DaemonMechanism {
  if (existsSync(DAEMON_PLIST) && Bun.which("launchctl")) return "launchd";
  if (existsSync(DAEMON_SYSTEMD_UNIT) && Bun.which("systemctl")) return "systemd";
  return watchProcessRunning() ? "unsupervised" : "absent";
}

export interface RestartResult {
  readonly mechanism: DaemonMechanism;
  /** True only when a supervisor confirmed it acted. */
  readonly restarted: boolean;
  /** One line, already phrased for a human or an installing agent. */
  readonly detail: string;
}

/**
 * Restart the capture daemon if a supervisor will bring it back.
 *
 * Deliberately does NOT kill an unsupervised process: nothing would restart it, and losing the
 * capture loop is a worse outcome than the one a restart fixes. That is affordable because a
 * restart is an optimization, not a correctness requirement — every sweep re-reads the persisted
 * harness locations (harness-locate.ts caches on mtime), so a new location is picked up within one
 * poll interval either way. What the restart buys is the filesystem WATCH list, which is built once
 * at daemon start, i.e. immediacy rather than eventual effect.
 */
export function restartDaemon(): RestartResult {
  const mechanism = daemonMechanism();
  if (mechanism === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null) {
      const kick = run(["launchctl", "kickstart", "-k", `gui/${uid}/${DAEMON_LABEL}`]);
      if (kick.ok && kick.code === 0) {
        return { mechanism, restarted: true, detail: "launchd restarted the capture daemon" };
      }
    }
    run(["launchctl", "unload", DAEMON_PLIST]);
    const load = run(["launchctl", "load", DAEMON_PLIST]);
    if (load.ok && load.code === 0) {
      return { mechanism, restarted: true, detail: "launchd reloaded the capture daemon" };
    }
    // The unload above may have SUCCEEDED while the load failed — the daemon is then stopped, and
    // "takes effect within one sweep" would be false because nothing is sweeping. Probe before
    // promising anything.
    return watchProcessRunning()
      ? {
          mechanism,
          restarted: false,
          detail: `launchd would not restart it, but the daemon is still running — the change takes effect within one sweep (~30s); to force it: launchctl kickstart -k gui/${uid ?? "$UID"}/${DAEMON_LABEL}`,
        }
      : {
          mechanism,
          restarted: false,
          detail: "launchd would not reload the capture daemon and it is NOT running — re-run ./setup.sh to reinstall it",
        };
  }
  if (mechanism === "systemd") {
    const r = run(["systemctl", "--user", "restart", DAEMON_UNIT]);
    return r.ok && r.code === 0
      ? { mechanism, restarted: true, detail: "systemd restarted the capture daemon" }
      : {
          mechanism,
          restarted: false,
          detail: `systemd would not restart it — the change still takes effect within one sweep (~30s); to force it: systemctl --user restart ${DAEMON_UNIT}`,
        };
  }
  if (mechanism === "unsupervised") {
    return {
      mechanism,
      restarted: false,
      detail:
        "the daemon is running unsupervised, so it is left alone (nothing would restart it) — " +
        "the change takes effect within one sweep (~30s)",
    };
  }
  return {
    mechanism,
    restarted: false,
    detail: "no capture daemon is running — run ./setup.sh to install it",
  };
}
