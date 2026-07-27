// Engine update notice — automatic CHECK, manual APPLY.
//
// The ask this answers: a consumer should not have to track releases. The line they get at
// cold start states that a newer version exists and gives the exact command. What it
// deliberately does NOT do is run that command: hooks execute this engine's code inside every
// session, so auto-applying whatever origin/main currently says would turn one compromised
// account into code execution on every consumer machine at their next session start — with
// nobody in the loop. v0.9.0 drew the boundary "a clone is not consent"; pulling new code is
// a fresh act of consent, so a human performs it. (`git fetch` itself is safe: it stores
// objects and moves a remote-tracking ref; nothing is checked out and nothing runs.)
//
// Split so neither half can hurt a session:
//   CHECK  — daemon-side, at most daily, does the network: fetch + read origin/main's
//            package.json (object read), record the answer in .state/update-check.json.
//   NOTICE — hook-side, zero network and zero writes: read the recorded answer, compare it
//            with THIS clone's live package.json, print one line only when origin is newer.
//            The live read matters: the moment the human pulls, local equals remote and the
//            line disappears — a recorded-only local version would nag for up to a day.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { effectiveStateRoot } from "./state-dir.ts";

export const UPDATE_CHECK_FILE = "update-check.json";

// A version string travels from a remote repository into every session's context — treat it as
// untrusted input. Only a plain x.y.z survives; anything else reads as "no answer".
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export interface UpdateCheck {
  checkedAt: string; // ISO timestamp of the last completed check
  localVersion: string; // this clone's package.json AT CHECK TIME (informational — see notice)
  remoteVersion: string; // origin/main's package.json
  behind: number; // commits in HEAD..origin/main at check time
}

function git(args: string[], cwd: string, timeout = 15_000): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function versionOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const v = String((JSON.parse(text) as { version?: unknown })?.version ?? "").trim();
    return VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** THIS clone's version, read live from disk (null when missing/unparsable/hostile). */
export function liveEngineVersion(clone: string = CLONE_ROOT): string | null {
  try {
    return versionOf(readFileSync(join(clone, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * Daemon-side: ask origin what the newest main is, record the answer. Never throws; any
 * failure (offline, no origin, hostile version, missing state root) answers null and records
 * nothing — the daemon retries tomorrow, and stale-but-sane beats fresh-but-wrong.
 *
 * The state root is never created here: state-bootstrap owns root creation and its ownership
 * rules; a missing root simply means "no place to record yet".
 */
export function checkEngineUpdate(clone: string = CLONE_ROOT, stateRoot: string = effectiveStateRoot()): UpdateCheck | null {
  try {
    if (!existsSync(stateRoot)) return null;
    if (git(["rev-parse", "--is-inside-work-tree"], clone) !== "true") return null;
    const fetch = spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: clone, timeout: 30_000 });
    if (fetch.status !== 0) return null;
    const local = liveEngineVersion(clone);
    const remote = versionOf(git(["show", "origin/main:package.json"], clone));
    if (local === null || remote === null) return null;
    const behindRaw = git(["rev-list", "--count", "HEAD..origin/main"], clone);
    const behind = behindRaw === null ? 0 : Number.parseInt(behindRaw, 10) || 0;
    const rec: UpdateCheck = {
      checkedAt: new Date().toISOString(),
      localVersion: local,
      remoteVersion: remote,
      behind,
    };
    writeFileSync(join(stateRoot, UPDATE_CHECK_FILE), JSON.stringify(rec));
    return rec;
  } catch {
    return null;
  }
}

/** Hook/doctor-side: the recorded answer, re-validated on read (the file is data, not trust). */
export function readUpdateCheck(stateRoot: string = effectiveStateRoot()): UpdateCheck | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateRoot, UPDATE_CHECK_FILE), "utf8")) as Record<string, unknown>;
    const local = String(raw?.localVersion ?? "");
    const remote = String(raw?.remoteVersion ?? "");
    if (!VERSION_RE.test(local) || !VERSION_RE.test(remote)) return null;
    const behind = Number(raw?.behind);
    return {
      checkedAt: String(raw?.checkedAt ?? ""),
      localVersion: local,
      remoteVersion: remote,
      behind: Number.isFinite(behind) && behind >= 0 ? behind : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Is there something worth one line? Yes only when the recorded origin/main version is
 * STRICTLY newer than this clone's live version — a local version ahead of origin (author
 * machines, forks) is not "an update", and equal versions right after a pull go silent
 * immediately without waiting for the next daily check.
 */
export function updateAvailable(
  clone: string = CLONE_ROOT,
  stateRoot: string = effectiveStateRoot(),
): { localVersion: string; remoteVersion: string; checkedAt: string } | null {
  const rec = readUpdateCheck(stateRoot);
  if (rec === null) return null;
  const live = liveEngineVersion(clone);
  if (live === null) return null;
  if (cmpSemver(rec.remoteVersion, live) <= 0) return null;
  return { localVersion: live, remoteVersion: rec.remoteVersion, checkedAt: rec.checkedAt };
}
