// Deterministic resolution of the external executables this engine shells out to.
//
// `git` is the one hard dependency of the capture loop: enrollment.ts asks git whether a path is a
// worktree, and a negative answer is indistinguishable from "git is not installed". Fail-closed is
// the right stance there — but only AFTER looking properly. A daemon started by launchd or systemd
// inherits a minimal PATH (`/usr/bin:/bin` on macOS), so a Homebrew, Nix, or MacPorts git that the
// installing shell found perfectly well is invisible to the service that actually does the work.
// The symptom is silence: every session routes to "not a git worktree", the queue fills with
// skipped rows, and doctor stays green because nothing errored.
//
// So: PATH first, then the places package managers actually install to, and a candidate is
// accepted only when `--version` proves it is the tool we wanted. The result is memoized per
// process (a daemon sweep asks once per repository) and deliberately NOT persisted — a stale
// absolute path in a state file would outlive the install it described, and re-running four
// stat() calls is cheaper than being wrong.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

const PROBE_TIMEOUT_MS = 2000;

/** Where package managers put binaries when they are not on a service's PATH. */
function wellKnownBinDirs(): string[] {
  const home = process.env.HOME?.trim() || homedir();
  return [
    "/opt/homebrew/bin", // Homebrew on Apple silicon
    "/usr/local/bin", // Homebrew on Intel, and the usual manual-install target
    "/usr/bin",
    "/bin",
    "/opt/local/bin", // MacPorts
    "/usr/local/git/bin", // the standalone macOS git installer
    join(home, ".local", "bin"),
    join(home, ".nix-profile", "bin"),
    "/nix/var/nix/profiles/default/bin",
    "/run/current-system/sw/bin", // NixOS
    "/snap/bin",
    "/usr/local/sbin",
  ];
}

/**
 * Where Git for Windows puts its bundled bash.
 *
 * `bash` is never on the Windows PATH: the Git installer adds `<root>\cmd` (git, gitk) and
 * deliberately not `<root>\bin` (bash, sh) — putting a second `sh.exe` on a Windows PATH breaks
 * other software. Claude Code hides this by resolving bash itself; Codex does not, so a hook
 * spelled `bash '<script>'` died with "'bash' is not recognized" and Codex reported only
 * "hook exited with code 1". The install root is derived from the git we already verified, which
 * is also the git the same installer shipped.
 */
function windowsBashDirs(): string[] {
  const dirs: string[] = [];
  const git = locateGit().path;
  if (git) {
    // <root>\cmd\git.exe and <root>\bin\git.exe both point at <root>\bin\bash.exe
    const root = dirname(dirname(git));
    dirs.push(join(root, "bin"), join(root, "usr", "bin"));
  }
  const programFiles = process.env.ProgramFiles?.trim();
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (programFiles) dirs.push(join(programFiles, "Git", "bin"));
  if (programFilesX86) dirs.push(join(programFilesX86, "Git", "bin"));
  if (localAppData) dirs.push(join(localAppData, "Programs", "Git", "bin"));
  return dirs;
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Does this candidate identify itself as the tool we asked for? A path that merely exists is not
 * evidence — the same standard the harness locator holds its SQLite candidates to.
 */
function identifies(path: string, expect: string): boolean {
  try {
    const result = Bun.spawnSync([path, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    if (result.exitCode !== 0) return false;
    return result.stdout.toString().trim().toLowerCase().startsWith(expect);
  } catch {
    return false;
  }
}

export interface ToolLocation {
  /** Absolute path to the verified executable, or null when the search came up empty. */
  readonly path: string | null;
  /** Every directory actually examined — the evidence a handoff message quotes. */
  readonly tried: readonly string[];
}

function locate(binary: string, versionPrefix: string, extraDirs: () => string[] = () => []): ToolLocation {
  const tried: string[] = [];
  const seen = new Set<string>();
  // On Windows the executable carries an extension; the bare name is kept as a fallback so a
  // POSIX-style install under MSYS/Cygwin still resolves.
  const names = process.platform === "win32" ? [`${binary}.exe`, binary] : [binary];
  const consider = (dir: string): string | null => {
    if (!dir || seen.has(dir)) return null;
    seen.add(dir);
    tried.push(dir);
    for (const name of names) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      if (identifies(candidate, versionPrefix)) return candidate;
    }
    return null;
  };

  // PATH first: whatever the surrounding environment resolved is the user's own choice, and on an
  // interactive shell it is already correct.
  const onPath = Bun.which(binary);
  if (onPath && isAbsolute(onPath) && identifies(onPath, versionPrefix)) {
    return { path: onPath, tried: [dirname(onPath)] };
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const hit = consider(dir);
    if (hit) return { path: hit, tried };
  }
  for (const dir of [...wellKnownBinDirs(), ...extraDirs()]) {
    const hit = consider(dir);
    if (hit) return { path: hit, tried };
  }
  return { path: null, tried };
}

let gitCache: ToolLocation | null = null;
let bashCache: ToolLocation | null = null;

/** Resolve `git`, searching beyond PATH. Memoized for the life of the process. */
export function locateGit(): ToolLocation {
  if (gitCache === null) gitCache = locate("git", "git version");
  return gitCache;
}

/**
 * Resolve `bash`, searching beyond PATH — the interpreter every generated hook command names.
 *
 * On POSIX this is `/bin/bash` and the search is a formality. On Windows it is the whole point:
 * see windowsBashDirs() for why the bare name never resolves there, and what it cost.
 */
export function locateBash(): ToolLocation {
  if (bashCache === null) bashCache = locate("bash", "gnu bash", windowsBashDirs);
  return bashCache;
}

/** Test seam — a fixture that installs a fake git needs the next call to look again. */
export function resetToolCache(): void {
  gitCache = null;
  bashCache = null;
}

/**
 * What to pass to spawn as argv[0]. Falls back to the bare name so that behaviour is unchanged
 * wherever git IS on PATH, and so a machine without git keeps failing exactly as it did before
 * (closed) rather than throwing something new at a caller that expects a boolean.
 */
export function gitCommand(): string {
  return locateGit().path ?? "git";
}

/**
 * The PATH a background service should run with.
 *
 * launchd hands an agent `/usr/bin:/bin:/usr/sbin:/sbin`; a systemd --user unit gets barely more.
 * The daemon shells out to git on every enrollment check and to `ps` on every OpenCode append, so
 * baking this into the service definition at install time is what makes those calls resolve the
 * same binaries the installing shell did. Order matters: the tools we verified come first, then
 * the installer's own PATH (the environment that found them), then the standard locations.
 */
export function serviceSearchPath(): string {
  const dirs: string[] = [];
  const add = (dir: string): void => {
    if (dir && isAbsolute(dir) && !dirs.includes(dir)) dirs.push(dir);
  };
  add(dirname(process.execPath)); // bun itself, so `bun` in a wrapper script resolves
  const git = locateGit().path;
  if (git) add(dirname(git));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) add(dir);
  for (const dir of wellKnownBinDirs()) {
    try {
      if (statSync(dir).isDirectory()) add(dir);
    } catch {
      /* absent on this machine */
    }
  }
  return dirs.join(delimiter);
}

// Small CLI so the installer does not have to reimplement the search in shell. Keeping one list in
// one language is the whole point: a divergence here would put git on the service PATH in the
// script and not in the engine, or the reverse, and both failures are silent.
if (import.meta.main) {
  const arg = process.argv[2];
  if (arg === "--service-path") {
    process.stdout.write(serviceSearchPath() + "\n");
  } else if (arg === "--git") {
    const { path } = locateGit();
    if (path === null) process.exit(1);
    process.stdout.write(path + "\n");
  } else if (arg === "--bash") {
    const { path } = locateBash();
    if (path === null) process.exit(1);
    process.stdout.write(path + "\n");
  } else {
    process.stderr.write("usage: tool-locate.ts --service-path | --git | --bash\n");
    process.exit(2);
  }
}
