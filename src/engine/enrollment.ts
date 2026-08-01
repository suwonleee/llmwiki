// Per-worktree enrollment — the ONE trust decision a consumer makes, and the only thing that
// turns the globally installed hooks on for a repository.
//
// The problem this closes: setup.sh installs machine-level hooks (SessionStart /
// UserPromptSubmit / an OpenCode plugin). Before this module, "is this repo mine?" was answered
// by the presence of `docs/wiki/` — a directory that arrives with ANY `git clone`. So cloning a
// stranger's repository was enough to make the installed engine read its Markdown and push it
// into the model's context, and to make the daemon queue that session's transcript. Adoption is
// not a trust decision anyone made; it came in the tarball.
//
// The marker therefore has to live somewhere a clone CANNOT deliver and a commit CANNOT carry:
//
//   <worktree-specific git dir>/llmwiki/enrollment-v1.json
//
// Three properties come from that location alone:
//   1. `git clone` never populates it — .git contents are rebuilt locally, not transferred.
//   2. No tracked file, config value, or Markdown page can create it — `llmwiki init` does.
//   3. `--absolute-git-dir` is worktree-SPECIFIC (a linked worktree resolves to
//      <common>/worktrees/<name>), so trusting one worktree never trusts its siblings. Using
//      --git-common-dir here would silently enroll every worktree of the repository at once.
//
// The marker records the canonical worktree path it was written for, so a moved or copied
// repository fails closed: the recorded path no longer equals the resolved one, and enrollment
// simply reads as disabled until the human re-runs `llmwiki init`. Every error — no git, no
// marker, a symlink where a file belongs, group/world-readable modes, unparsable JSON, an extra
// key — is disabled. There is no "probably fine" branch in this file.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { gitCommand, locateGit } from "./tool-locate.ts";

export const MARKER_DIR = "llmwiki";
export const MARKER_BASENAME = "enrollment-v1.json";
export const MARKER_VERSION = 1;
/** A marker is a single short JSON line. Anything larger is not ours — read no further. */
export const MARKER_MAX_BYTES = 4096;

const POSIX = process.platform !== "win32";
const GIT_TIMEOUT_MS = 2000;

export type EnrollmentReason =
  | "enabled"
  | "not-a-git-worktree"
  | "no-marker"
  | "marker-not-regular-file"
  | "marker-too-large"
  | "marker-unreadable"
  | "marker-malformed"
  | "marker-wrong-version"
  | "marker-foreign-worktree"
  | "marker-permissive-mode";

export interface EnrollmentStatus {
  readonly enabled: boolean;
  readonly reason: EnrollmentReason;
  /** Canonical worktree root, or null when the path is not a git worktree. */
  readonly worktree: string | null;
  /** Where the marker for this worktree would live, or null without a git dir. */
  readonly markerPath: string | null;
}

// ---- git resolution ---------------------------------------------------------------------
// argv form only (never a shell string): a repository path may contain spaces, quotes, `$(…)`,
// or a semicolon, and this runs on every cold start.

function git(cwd: string, args: string[]): string | null {
  try {
    // `gitCommand()` is the bare name whenever git is on PATH, and an absolute path when it is not
    // — which is the daemon's normal condition under launchd/systemd's minimal PATH. Without it a
    // Homebrew/Nix git is invisible to the service, every session reads as "not a git worktree",
    // and capture stops with nothing to show for it.
    const r = spawnSync(gitCommand(), ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out || null;
  } catch {
    return null; // git absent / not executable → not a worktree, fail closed
  }
}

/** Was git found anywhere — on PATH or in the package-manager locations tool-locate searches? */
export function gitAvailable(): boolean {
  return locateGit().path !== null;
}

/**
 * The one thing this engine genuinely cannot fix for the user, phrased so the caller can hand it
 * off: what was searched, and what would resolve it. Everything else about a missing git — a
 * service's truncated PATH, a non-standard install prefix — tool-locate already resolves silently.
 */
export function gitMissingDetail(): string {
  const { tried } = locateGit();
  const where = tried.length > 4 ? `${tried.slice(0, 4).join(", ")}, … (${tried.length} dirs)` : tried.join(", ");
  return `git was not found — searched: ${where}. Install git (macOS: xcode-select --install · Debian/Ubuntu: apt install git · Fedora: dnf install git), then re-run.`;
}

function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Canonical top-level of the worktree containing `candidate`, or null when there is none. */
export function canonicalWorktree(candidate: string): string | null {
  if (!candidate) return null;
  const start = realDir(candidate);
  if (!start) return null;
  const top = git(start, ["rev-parse", "--show-toplevel"]);
  return top ? realDir(top) : null;
}

/**
 * The WORKTREE-SPECIFIC metadata dir (`--absolute-git-dir`), never the common dir. For a linked
 * worktree this is <common>/worktrees/<name>, which is exactly why two worktrees of one
 * repository enroll independently.
 */
export function worktreeGitDir(worktree: string): string | null {
  const dir = git(worktree, ["rev-parse", "--absolute-git-dir"]);
  return dir ? realDir(dir) : null;
}

function markerPathFor(gitDir: string): string {
  return join(gitDir, MARKER_DIR, MARKER_BASENAME);
}

/** The exact bytes of a marker. One UTF-8 JSON line, no extra keys, no pretty-printing. */
export function markerBytes(worktree: string): string {
  return `{"version":${MARKER_VERSION},"worktree":${JSON.stringify(worktree)}}\n`;
}

// ---- validation -------------------------------------------------------------------------

function readMarkerBounded(path: string): string | null {
  // O_NOFOLLOW: a symlink planted at the marker path must fail, not resolve. The size cap is
  // enforced on the descriptor we actually read, so a swap between lstat and open cannot widen it.
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (POSIX ? fsConstants.O_NOFOLLOW : 0));
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > MARKER_MAX_BYTES) return null;
    if (POSIX && (st.mode & 0o077) !== 0) return null; // group/world bits → not ours
    const buf = Buffer.alloc(MARKER_MAX_BYTES);
    const n = readSync(fd, buf, 0, MARKER_MAX_BYTES, 0);
    return buf.toString("utf-8", 0, n);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function inspectMarker(path: string, worktree: string): EnrollmentReason {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "no-marker";
  }
  if (!st.isFile()) return "marker-not-regular-file"; // symlink, dir, fifo…
  if (st.size > MARKER_MAX_BYTES) return "marker-too-large";
  if (POSIX && (st.mode & 0o077) !== 0) return "marker-permissive-mode";
  const text = readMarkerBounded(path);
  if (text === null) return "marker-unreadable";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "marker-malformed";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "marker-malformed";
  const keys = Object.keys(parsed as Record<string, unknown>).sort();
  if (keys.length !== 2 || keys[0] !== "version" || keys[1] !== "worktree") return "marker-malformed";
  const { version, worktree: recorded } = parsed as { version: unknown; worktree: unknown };
  if (version !== MARKER_VERSION) return "marker-wrong-version";
  if (typeof recorded !== "string" || recorded !== worktree) return "marker-foreign-worktree";
  if (text !== markerBytes(worktree)) return "marker-malformed";
  return "enabled";
}

// ---- public predicate -------------------------------------------------------------------

// Enrollment is read on every cold start, every turn, and once per discovered session in a
// daemon sweep, so the answer is memoized for the life of the PROCESS only. A long-lived daemon
// re-reads on each sweep via resetEnrollmentCache(), which is how `llmwiki init` takes effect
// without a restart. No cross-process cache, no registry file: another persistent copy of the
// trust state is another thing to keep honest.
const cache = new Map<string, EnrollmentStatus>();

export function resetEnrollmentCache(): void {
  cache.clear();
}

export function inspectEnrollment(repo: string | null | undefined): EnrollmentStatus {
  if (!repo) return { enabled: false, reason: "not-a-git-worktree", worktree: null, markerPath: null };
  const cached = cache.get(repo);
  if (cached) return cached;
  const status = computeEnrollment(repo);
  cache.set(repo, status);
  return status;
}

/**
 * Both halves of the answer from ONE `git` invocation. This runs for every distinct repository a
 * daemon sweep discovers (323 on the author's machine), and two spawns per repository cost twice
 * what one does for exactly the same answer — `--show-toplevel --absolute-git-dir` prints both, and
 * the git dir stays worktree-specific.
 */
function resolveWorktree(candidate: string): { worktree: string | null; gitDir: string | null } {
  const start = realDir(candidate);
  if (!start) return { worktree: null, gitDir: null };
  const out = git(start, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  if (!out) return { worktree: null, gitDir: null };
  const [top, dir] = out.split("\n");
  const worktree = top ? realDir(top) : null;
  if (!worktree) return { worktree: null, gitDir: null };
  return { worktree, gitDir: dir ? realDir(dir) : null };
}

function computeEnrollment(repo: string): EnrollmentStatus {
  const { worktree, gitDir } = resolveWorktree(repo);
  if (!worktree) return { enabled: false, reason: "not-a-git-worktree", worktree: null, markerPath: null };
  if (!gitDir) return { enabled: false, reason: "not-a-git-worktree", worktree, markerPath: null };
  const markerPath = markerPathFor(gitDir);
  const reason = inspectMarker(markerPath, worktree);
  return { enabled: reason === "enabled", reason, worktree, markerPath };
}

/**
 * THE gate. Every automatic surface — cold start, turn context, capture enqueue, OpenCode
 * injection — asks this before it reads repository content or transcript bodies.
 */
export function isEnrolled(repo: string | null | undefined): boolean {
  return inspectEnrollment(repo).enabled;
}

/**
 * Re-read the marker for revocation-sensitive boundaries. Long-lived daemons use this
 * immediately before materializing transcript content and immediately before enqueueing it,
 * so `llmwiki disable` takes effect without waiting for the next sweep.
 */
export function isEnrolledFresh(repo: string | null | undefined): boolean {
  if (!repo) return false;
  cache.delete(repo);
  return inspectEnrollment(repo).enabled;
}

// ---- mutation ---------------------------------------------------------------------------

export interface EnrollmentChange {
  readonly ok: boolean;
  readonly worktree: string | null;
  readonly markerPath: string | null;
  readonly error?: string;
}

/**
 * Write the marker for `repo`'s worktree. Called by `llmwiki init` ONLY after the bounded
 * skeleton/index work succeeded — a half-initialized repository must not end up trusted.
 * Idempotent: re-running replaces the marker atomically and prompts for nothing.
 */
export function enroll(repo: string): EnrollmentChange {
  const worktree = canonicalWorktree(repo);
  if (!worktree) {
    return {
      ok: false,
      worktree: null,
      markerPath: null,
      error: gitAvailable()
        ? "not a git worktree — automatic integration needs git (run `git init` first)"
        : gitMissingDetail(),
    };
  }
  const gitDir = worktreeGitDir(worktree);
  if (!gitDir) return { ok: false, worktree, markerPath: null, error: "cannot resolve the worktree's git directory" };

  const dir = join(gitDir, MARKER_DIR);
  try {
    ensureMarkerDir(dir);
  } catch (e) {
    return { ok: false, worktree, markerPath: null, error: `marker directory unusable: ${msg(e)}` };
  }

  const markerPath = join(dir, MARKER_BASENAME);
  // Exclusive temp sibling → fsync → atomic rename. The rename REPLACES whatever sits at the
  // marker path (including a symlink) without following it.
  const temp = join(dir, `.${MARKER_BASENAME}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeSync(fd, markerBytes(worktree));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (POSIX) chmodSync(temp, 0o600);
    renameSync(temp, markerPath);
    if (POSIX) chmodSync(markerPath, 0o600);
  } catch (e) {
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    return { ok: false, worktree, markerPath, error: `could not write the marker: ${msg(e)}` };
  }
  resetEnrollmentCache();
  return { ok: true, worktree, markerPath };
}

function ensureMarkerDir(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    if (POSIX) chmodSync(dir, 0o700);
    return;
  }
  if (st.isSymbolicLink()) throw new Error("a symlink sits where the marker directory belongs");
  if (!st.isDirectory()) throw new Error("the marker directory path is not a directory");
  if (POSIX) chmodSync(dir, 0o700);
}

/**
 * Remove enrollment for `repo`'s worktree. Unlinks the exact marker entry (never following it)
 * and removes the marker directory only when it is empty — the git common directory and any
 * sibling worktree's marker are never touched.
 */
export function disable(repo: string): EnrollmentChange {
  const worktree = canonicalWorktree(repo);
  if (!worktree) return { ok: false, worktree: null, markerPath: null, error: "not a git worktree" };
  const gitDir = worktreeGitDir(worktree);
  if (!gitDir) return { ok: false, worktree, markerPath: null, error: "cannot resolve the worktree's git directory" };
  const dir = join(gitDir, MARKER_DIR);
  const markerPath = join(dir, MARKER_BASENAME);
  try {
    unlinkSync(markerPath); // unlink acts on the entry itself — a symlink here is removed, not followed
  } catch {
    /* already absent — disable is idempotent */
  }
  try {
    rmdirSync(dir); // only succeeds while empty; a shared/leftover dir survives untouched
  } catch {
    /* non-empty or absent → leave it */
  }
  resetEnrollmentCache();
  return { ok: true, worktree, markerPath };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One-line human explanation for `llmwiki status` / doctor. Never prints repository content. */
export function explain(status: EnrollmentStatus, ko = false): string {
  switch (status.reason) {
    case "enabled":
      return ko ? "활성 — 이 워크트리는 등록되어 있다" : "enabled — this worktree is enrolled";
    case "not-a-git-worktree":
      // Same reason code, two very different situations. "Not a worktree" is a fact about the
      // directory the user can act on; a missing git is a fact about the machine, and reporting the
      // first when the second is true has sent people looking in entirely the wrong place.
      if (!gitAvailable()) {
        return ko
          ? `비활성 — git 실행 파일을 찾지 못함 (${gitMissingDetail()})`
          : `disabled — ${gitMissingDetail()}`;
      }
      return ko
        ? "비활성 — git 워크트리가 아님 (자동 연동은 git 저장소에서만 동작)"
        : "disabled — not a git worktree (automatic integration is git-only)";
    case "no-marker":
      return ko ? "비활성 — 미등록 (`llmwiki init <repo>` 1회 실행)" : "disabled — not enrolled (run `llmwiki init <repo>` once)";
    case "marker-foreign-worktree":
      return ko
        ? "비활성 — 등록 기록이 다른 경로를 가리킴 (이동·복사된 저장소; `llmwiki init` 재실행)"
        : "disabled — the marker names a different worktree (moved/copied repo; re-run `llmwiki init`)";
    case "marker-permissive-mode":
      return ko ? "비활성 — 등록 파일 권한이 너무 개방적임" : "disabled — the marker's permissions are too permissive";
    case "marker-not-regular-file":
      return ko ? "비활성 — 등록 파일 자리에 일반 파일이 아닌 것이 있음" : "disabled — the marker path is not a regular file";
    case "marker-too-large":
      return ko ? "비활성 — 등록 파일이 너무 큼" : "disabled — the marker is too large";
    case "marker-wrong-version":
      return ko ? "비활성 — 등록 파일 스키마 버전 불일치" : "disabled — marker schema version mismatch";
    case "marker-malformed":
    case "marker-unreadable":
    default:
      return ko ? "비활성 — 등록 파일을 읽을 수 없음 (`llmwiki init` 재실행)" : "disabled — unreadable marker (re-run `llmwiki init`)";
  }
}
