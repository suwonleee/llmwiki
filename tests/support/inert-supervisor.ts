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
//
// ONE TRAP, for whoever writes the next such test. The base `launchctl` shim prints nothing, so
// `launchctl list | grep LABEL` finds no job and daemon/install.sh correctly concludes launchd
// refused it — then falls through to its supervisor-less path and `nohup`s a REAL watch.ts. The
// `ps`/`pgrep` shims are inert too, so its "is one already running?" guard sees an empty process
// table and starts another every run. The test then deletes its temp dir, leaving a daemon
// polling a state root that no longer exists. This is the same silent-leak family the shims
// exist to prevent, and it bit the nonstandard-local E2E for llmwiki locate (seven strays).
// A test whose setup.sh run is EXPECTED TO SUCCEED must therefore override launchctl to report
// the label, exactly as tests/setup-lifecycle-e2e.test.ts does:
//   launchctl: "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n"
// Tests that assert setup FAILS before the daemon step need no override — install.sh never runs.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INERT: Record<string, string> = {
  launchctl: "#!/bin/sh\nexit 0\n", // never lists the label → nothing to unload or remove
  systemctl: "#!/bin/sh\nexit 1\n", // no user manager → the systemd branch is skipped
  crontab: "#!/bin/sh\ncat >/dev/null 2>&1 || true\nexit 0\n", // swallow the @reboot registration
  // One parseable dummy row, not empty output: the callers treat "exit 0 but no `<pid> <command>`
  // rows at all" as an unverifiable ps (the BusyBox partial `-o` shape) and FALL THROUGH to procfs
  // — which on Linux is the developer's real process table, the exact thing these shims exist to
  // keep tests away from. A row that matches nothing keeps the shim authoritative.
  ps: "#!/bin/sh\nprintf '1 /sbin/init\\n'\nexit 0\n",
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
