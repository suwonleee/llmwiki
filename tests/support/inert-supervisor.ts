// Supervisor tools a test must never reach for real.
//
// A test can redirect HOME. It cannot redirect the developer's launchd session, their crontab, or
// the machine's process table. And `daemon/install.sh --uninstall` is CORRECT to stop the daemon
// belonging to the clone it ships with — except that in a test, that clone IS the developer's
// checkout. An unstubbed run therefore does exactly what it promises: it removes the per-user
// launchd job (`com.llmwiki.daemon` is per-user, not per-HOME) and kills the running watch.ts.
// The suite still passes. Every session after it goes uncaptured, and the next `doctor` blames a
// dead daemon on nothing in particular — the silent-failure shape this engine exists to avoid.
//
// So every test that runs setup.sh or daemon/install.sh installs these inert shims first, and
// overrides only the one tool whose behavior it is actually asserting on.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INERT: Record<string, string> = {
  launchctl: "#!/bin/sh\nexit 0\n", // never lists the label → nothing to unload or remove
  systemctl: "#!/bin/sh\nexit 1\n", // no user manager → the systemd branch is skipped
  crontab: "#!/bin/sh\ncat >/dev/null 2>&1 || true\nexit 0\n", // swallow the @reboot registration
  ps: "#!/bin/sh\nexit 0\n", // empty process table → watch_pids matches nothing
  pgrep: "#!/bin/sh\nexit 1\n",
  pkill: "#!/bin/sh\nexit 1\n",
};

/** Write inert supervisor shims into `bin` (created if needed) and return it. */
export function inertSupervisorBin(bin: string, overrides: Record<string, string> = {}): string {
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries({ ...INERT, ...overrides })) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return bin;
}
