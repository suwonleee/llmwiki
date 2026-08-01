// Reading the capture daemon's service definition, whichever supervisor this platform installed.
//
// The E2E suites assert that the daemon carries the harness environment it was installed with —
// which profile, which database. That property is platform-independent; only the file that records
// it differs (a launchd plist on macOS, a systemd --user unit on Linux). Hardcoding the plist made
// three otherwise portable tests macOS-only, and the shortcut of stubbing `uname` does not work:
// `daemon/install.sh` branches on `uname`, but `doctor` branches on `process.platform`, so forcing
// one produces an install the following health check does not recognize.
//
// So each platform exercises its own real branch, and the assertions ask about VALUES.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DARWIN = process.platform === "darwin";

/** Where this platform's definition lives, relative to a sandboxed HOME. */
export function serviceDefinitionPath(home: string): string {
  return DARWIN
    ? join(home, "Library", "LaunchAgents", "com.llmwiki.daemon.plist")
    : join(home, ".config", "systemd", "user", "llmwiki-daemon.service");
}

export function readServiceDefinition(home: string): string {
  return readFileSync(serviceDefinitionPath(home), "utf8");
}

/**
 * The exact text that sets `key` to `value` in this platform's syntax.
 *
 * launchd's plist is XML, so a value containing `&` — which these sandboxes deliberately use, since
 * a real clone path may contain one — appears escaped. systemd's is a plain `Environment=` line.
 */
export function serviceEnvEntry(key: string, value: string): string {
  return DARWIN
    ? `<key>${key}</key><string>${value.replaceAll("&", "&amp;")}</string>`
    : `Environment="${key}=${value}"`;
}

/**
 * Supervisor stubs that make the install DETERMINISTIC on this platform, to be merged into a
 * sandbox bin alongside `inertSupervisorBin`'s inert defaults.
 *
 * macOS: launchctl reports the label, so install.sh's launchd branch succeeds instead of falling
 * through to a real `nohup`. Linux: systemctl succeeds, so install.sh writes a --user unit and
 * doctor then finds it active — and, critically, the cron fallback is never reached, so no test
 * can write into the developer's real crontab.
 */
export function supervisorStubs(): Record<string, string> {
  return DARWIN
    ? {
        launchctl: "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n",
      }
    : { systemctl: SYSTEMCTL_STUB };
}

/**
 * A `systemctl --user` that remembers whether it was told to start something.
 *
 * An always-succeeding stub is not good enough for the uninstall path, which asks `is-active`
 * BEFORE and AFTER stopping and refuses to proceed unless the answer changed — a deliberate design,
 * since deleting a unit file while the service still runs leaves a daemon nothing will ever stop.
 * The exit codes are systemd's own: 0 for active, 3 for inactive. Returning 1 (the shell's ordinary
 * failure) reads to that check as "could not verify", which is exactly the state it refuses on.
 */
const SYSTEMCTL_STUB = `#!/bin/sh
STATE="\${HOME}/.llmwiki-fake-systemd-active"
for arg in "$@"; do
  case "$arg" in
    is-active) [ -f "$STATE" ] && exit 0; exit 3 ;;
    enable|start|restart) : > "$STATE"; exit 0 ;;
    stop|disable) rm -f "$STATE"; exit 0 ;;
  esac
done
exit 0
`;
