// What the RUNNING daemon actually resolved its harness locations to.
//
// The daemon and an interactive `llmwiki` command are different processes with different
// environments, and nothing used to reconcile them. The daemon's service definition freezes
// CODEX_HOME / CLAUDE_CONFIG_DIR / OPENCODE_DB / XDG_DATA_HOME at install time
// (daemon/install.sh writes them into the launchd plist, the systemd unit and the cron line),
// while a shell inherits whatever launched it. When Codex Desktop relocated CODEX_HOME, the two
// silently disagreed: `llmwiki locate codex` reported the app's account home (188 rollouts) and
// the daemon kept sweeping the frozen ~/.codex (149, none new since the migration).
//
// Doctor could not see that, because it only ever asked its OWN environment. It reported the
// symptom — "nothing captured in 11 days" — and left the cause to be found by hand.
//
// So the daemon records what it resolved, and doctor compares. This is deliberately a plain file
// rather than plist/unit/crontab parsing: there are three service formats across four platforms,
// they say what was CONFIGURED rather than what the process resolved, and none of them would
// notice a home that appeared after install.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveStateRoot } from "./state-dir.ts";

export const DAEMON_RESOLVED_FILE = "daemon-resolved.json";

export interface DaemonResolved {
  /** ISO timestamp of the sweep that wrote this. */
  readonly at: string;
  readonly pid: number;
  readonly codexHomes: readonly string[];
  readonly claudeDirs: readonly string[];
  readonly opencodeDbs: readonly string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];

/**
 * Record this process's resolved locations. Best-effort by construction: a daemon that cannot
 * write its own breadcrumb must still capture, so every failure is swallowed.
 */
export function writeDaemonResolved(
  resolved: Omit<DaemonResolved, "at" | "pid">,
  stateRoot: string = effectiveStateRoot(),
): void {
  try {
    const record: DaemonResolved = {
      at: new Date().toISOString(),
      pid: process.pid,
      codexHomes: [...resolved.codexHomes],
      claudeDirs: [...resolved.claudeDirs],
      opencodeDbs: [...resolved.opencodeDbs],
    };
    writeFileSync(join(stateRoot, DAEMON_RESOLVED_FILE), JSON.stringify(record), { mode: 0o600 });
  } catch {
    /* a breadcrumb is never worth failing a sweep over */
  }
}

/** The recorded answer, re-validated on read (the file is data, not trust). */
export function readDaemonResolved(stateRoot: string = effectiveStateRoot()): DaemonResolved | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateRoot, DAEMON_RESOLVED_FILE), "utf8")) as Record<string, unknown>;
    const at = typeof raw?.at === "string" ? raw.at : "";
    const pid = Number(raw?.pid);
    if (!at) return null;
    return {
      at,
      pid: Number.isFinite(pid) && pid > 0 ? pid : 0,
      codexHomes: strings(raw?.codexHomes),
      claudeDirs: strings(raw?.claudeDirs),
      opencodeDbs: strings(raw?.opencodeDbs),
    };
  } catch {
    return null;
  }
}

/**
 * Locations this process can see that the daemon did not — the direction that actually loses
 * data. The reverse (the daemon seeing more) is normal: it runs with the service environment and
 * may legitimately reach homes an interactive shell does not.
 */
export function missedByDaemon(mine: readonly string[], daemons: readonly string[]): string[] {
  const known = new Set(daemons);
  return mine.filter((dir) => !known.has(dir));
}
