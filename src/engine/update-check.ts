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
//            with THIS clone's live package.json and the last successful setup receipt. A pull
//            narrows the line to setup-only; successful setup is what clears it.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { effectiveStateRoot } from "./state-dir.ts";

export const UPDATE_CHECK_FILE = "update-check.json";
export const INSTALL_RECEIPT_FILE = "install-receipt.json";
const INSTALL_RECEIPT_VERSION = 1;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UNKNOWN_INSTALL_HEAD = "unknown";
const POSIX = process.platform !== "win32";
export const INSTALL_COMPONENTS = ["common", "claude", "codex", "opencode"] as const;
export type InstallComponent = (typeof INSTALL_COMPONENTS)[number];

// A version string travels from a remote repository into every session's context — treat it as
// untrusted input. Only a plain x.y.z survives; anything else reads as "no answer".
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export interface UpdateCheck {
  checkedAt: string; // ISO timestamp of the last completed check
  localVersion: string; // this clone's package.json AT CHECK TIME (informational — see notice)
  remoteVersion: string; // origin/main's package.json
  behind: number; // commits in HEAD..origin/main at check time
}

interface InstallReceipt {
  version: typeof INSTALL_RECEIPT_VERSION;
  cloneRoot: string;
  components: Partial<Record<InstallComponent, string>>;
  recordedAt: string;
}

export type EngineUpdateNotice =
  | { kind: "update"; localVersion: string; remoteVersion: string; checkedAt: string }
  | { kind: "setup-required"; localVersion: string; remoteVersion: string; checkedAt: string };

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
 * Record the exact clone revision whose copied surfaces and daemon setup just installed.
 * setup.sh calls this only after its post-install doctor succeeds. A malformed/torn receipt never
 * certifies the install; it simply leaves the setup reminder active until the next successful run.
 */
export function recordInstallReceipt(
  clone: string = CLONE_ROOT,
  stateRoot: string = effectiveStateRoot(),
  installed: readonly InstallComponent[] = INSTALL_COMPONENTS,
  previouslyManaged: readonly InstallComponent[] = [],
): boolean {
  try {
    if (!existsSync(stateRoot)) return false;
    const cloneRoot = realpathSync(clone);
    const head = git(["rev-parse", "--verify", "HEAD"], cloneRoot);
    if (head === null || !GIT_OID_RE.test(head)) return false;
    if (installed.length === 0 || installed.some((component) => !INSTALL_COMPONENTS.includes(component))) return false;
    const previous = readInstallReceipt(stateRoot);
    const components = previous?.cloneRoot === cloneRoot ? { ...previous.components } : {};
    if (previous === null || previous.cloneRoot !== cloneRoot) {
      for (const component of previouslyManaged) {
        if (!installed.includes(component)) components[component] = UNKNOWN_INSTALL_HEAD;
      }
    }
    for (const component of installed) components[component] = head;
    const receipt: InstallReceipt = {
      version: INSTALL_RECEIPT_VERSION,
      cloneRoot,
      components,
      recordedAt: new Date().toISOString(),
    };
    const target = join(stateRoot, INSTALL_RECEIPT_FILE);
    try {
      const existing = lstatSync(target);
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    // A torn direct write is intentionally fail-safe: the reader rejects malformed JSON and keeps
    // the setup reminder visible. The stable owned filename also cannot strand an unrecognized
    // temp artifact that would make the state root refuse its next bootstrap.
    writeFileSync(target, JSON.stringify(receipt), { mode: 0o600 });
    if (POSIX) chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}

function readInstallReceipt(stateRoot: string): InstallReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateRoot, INSTALL_RECEIPT_FILE), "utf8")) as Record<string, unknown>;
    if (raw.version !== INSTALL_RECEIPT_VERSION) return null;
    const cloneRoot = String(raw.cloneRoot ?? "");
    if (!isAbsolute(cloneRoot) || raw.components === null || typeof raw.components !== "object") return null;
    const entries = Object.entries(raw.components as Record<string, unknown>);
    if (entries.length === 0) return null;
    const components: Partial<Record<InstallComponent, string>> = {};
    for (const [component, value] of entries) {
      if (!INSTALL_COMPONENTS.includes(component as InstallComponent)) return null;
      const head = String(value ?? "");
      if (!GIT_OID_RE.test(head) && head !== UNKNOWN_INSTALL_HEAD) return null;
      components[component as InstallComponent] = head;
    }
    if (components.common === undefined) return null;
    return {
      version: INSTALL_RECEIPT_VERSION,
      cloneRoot,
      components,
      recordedAt: String(raw.recordedAt ?? ""),
    };
  } catch {
    return null;
  }
}

function installReceiptMatches(clone: string, stateRoot: string): boolean {
  try {
    const receipt = readInstallReceipt(stateRoot);
    if (receipt === null) return false;
    const liveRoot = realpathSync(clone);
    const liveHead = git(["rev-parse", "--verify", "HEAD"], liveRoot);
    return (
      liveHead !== null &&
      GIT_OID_RE.test(liveHead) &&
      receipt.cloneRoot === liveRoot &&
      Object.values(receipt.components).every((head) => head === liveHead)
    );
  } catch {
    return false;
  }
}

/**
 * Is there something worth one line? A newer origin needs the full pull+setup instruction. Once
 * the clone catches up, a mismatched install receipt keeps the shorter setup-only reminder alive
 * until copied harness surfaces and the daemon have actually been refreshed.
 */
export function updateAvailable(
  clone: string = CLONE_ROOT,
  stateRoot: string = effectiveStateRoot(),
): EngineUpdateNotice | null {
  const rec = readUpdateCheck(stateRoot);
  const live = liveEngineVersion(clone);
  if (live === null) return null;
  if (rec !== null && cmpSemver(rec.remoteVersion, live) > 0) {
    return { kind: "update", localVersion: live, remoteVersion: rec.remoteVersion, checkedAt: rec.checkedAt };
  }
  if (!installReceiptMatches(clone, stateRoot)) {
    return {
      kind: "setup-required",
      localVersion: live,
      remoteVersion: rec?.remoteVersion ?? live,
      checkedAt: rec?.checkedAt ?? "",
    };
  }
  return null;
}
