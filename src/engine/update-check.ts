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

// `source` names the tracked ref (`origin/main`, or `<updateRemote>/main` for a fork) and `apply` is
// the exact command that brings it in — renderers print both instead of assuming `git pull`.
export type EngineUpdateNotice =
  | { kind: "update"; localVersion: string; remoteVersion: string; checkedAt: string; source: string; apply: string }
  | { kind: "setup-required"; localVersion: string; remoteVersion: string; checkedAt: string }
  | {
      kind: "commits-behind";
      localVersion: string;
      remoteVersion: string;
      behind: number;
      checkedAt: string;
      source: string;
      apply: string;
    };

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

// Where updates come from. A clone that shares history with its upstream pulls from `origin`. A
// clone whose history DIVERGED from it — a private runtime fork whose origin is its own backup and
// which takes upstream changes as file-level diffs — names the upstream remote in
// `git config --local llmwiki.updateRemote` and records the last upstream commit it applied in
// `llmwiki.updateBase`. Without that, the check fetched the fork's own backup and answered
// "0 behind" while the real upstream was eight commits ahead (measured 2026-10-06), and
// `HEAD..<upstream>/main` on unrelated histories counts the upstream's whole past instead.
// Both values are local config, never repository content, and are validated before use.
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface UpdateSource {
  remote: string; // remote whose main is the upstream
  base: string | null; // last upstream commit applied to a diverged fork; null = shared history
}

export function updateSource(clone: string = CLONE_ROOT): UpdateSource {
  const remote = git(["config", "--local", "--get", "llmwiki.updateRemote"], clone, 5_000);
  const base = git(["config", "--local", "--get", "llmwiki.updateBase"], clone, 5_000);
  return {
    remote: remote !== null && REMOTE_RE.test(remote) ? remote : "origin",
    base: base !== null && GIT_OID_RE.test(base) ? base : null,
  };
}

/** Upstream commits this clone has not taken yet, from local refs only. null = unknowable. */
function behindUpstream(clone: string, src: UpdateSource, timeout: number): number | null {
  const raw = git(["rev-list", "--count", `${src.base ?? "HEAD"}..${src.remote}/main`], clone, timeout);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The one command that brings the upstream in, for this clone's tracking mode. */
export function applyCommand(clone: string = CLONE_ROOT, src: UpdateSource = updateSource(clone)): string {
  if (src.base !== null) return `cd ${clone} && bun src/cli.ts sync-upstream`;
  const pull = src.remote === "origin" ? "git pull" : `git pull ${src.remote} main`;
  return `cd ${clone} && ${pull} && ./setup.sh`;
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
    const src = updateSource(clone);
    const fetch = spawnSync("git", ["fetch", "--quiet", src.remote, "main"], { cwd: clone, timeout: 30_000 });
    if (fetch.status !== 0) return null;
    const local = liveEngineVersion(clone);
    const remote = versionOf(git(["show", `${src.remote}/main:package.json`], clone));
    if (local === null || remote === null) return null;
    const behind = behindUpstream(clone, src, 15_000) ?? 0;
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

// What a commit must touch before the installed copies are actually stale. Hooks and githooks are
// invoked by path, engine code under src/ is loaded fresh by every CLI/hook call, and the daemon
// restarts itself onto new code (`daemon-sync`) — so a change confined to those runs in place and
// needs no ./setup.sh. So does skill/ref/: `conventions --section` reads it from the clone at call
// time and nothing copies it into a harness. Everything else counts: setup.sh, skill/ (copied into every harness),
// adapters/, daemon/, package.json, and the src/ files that RENDER the installed copies. The notice
// used to fire on any HEAD difference, including a hook-only commit, which taught people to ignore it.
const IN_PLACE_DIRS = /^(hooks|githooks|tests|docs|skill\/ref)\//;
const SETUP_RENDERERS = /^src\/(daemon\/wire[^/]*\.ts|engine\/(claude-commands|skill-policy|tool-locate)\.ts|plugin\/)/;

export function needsSetup(path: string): boolean {
  if (IN_PLACE_DIRS.test(path)) return false;
  if (!path.includes("/") && path.endsWith(".md")) return false; // root prose (README, ARCHITECTURE…)
  if (path.startsWith("src/")) return SETUP_RENDERERS.test(path);
  return true;
}

function componentCurrent(installedHead: string, liveHead: string, root: string): boolean {
  if (installedHead === liveHead) return true;
  if (!GIT_OID_RE.test(installedHead)) return false; // "unknown" pre-receipt evidence
  // Unreadable history (a rewritten or pruned install commit) proves nothing → stays stale.
  const changed = git(["diff", "--name-only", "--no-renames", "-z", installedHead, liveHead], root);
  return changed !== null && !changed.split("\0").some((path) => path !== "" && needsSetup(path));
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
      [...new Set(Object.values(receipt.components))].every((head) => componentCurrent(head, liveHead, liveRoot))
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
  const src = updateSource(clone);
  const source = `${src.remote}/main`;
  const apply = applyCommand(clone, src);
  if (rec !== null && cmpSemver(rec.remoteVersion, live) > 0) {
    return { kind: "update", localVersion: live, remoteVersion: rec.remoteVersion, checkedAt: rec.checkedAt, source, apply };
  }
  if (!installReceiptMatches(clone, stateRoot)) {
    return {
      kind: "setup-required",
      localVersion: live,
      remoteVersion: rec?.remoteVersion ?? live,
      checkedAt: rec?.checkedAt ?? "",
    };
  }
  // Version equality is not "up to date". The notice above compares package.json versions, so a
  // release that ships fixes without bumping the version is invisible: this repository sat 49
  // commits ahead of its own v0.11.2 tag with `remoteVersion === localVersion`, and the daemon
  // dutifully logged "0 behind" for a clone that WAS current while every clone made at the tag
  // was told nothing. `behind` was already measured and logged here; it just never reached anyone.
  //
  // Lowest priority on purpose — it speaks only when the version says nothing and the install is
  // otherwise healthy, so it can never mask the two more actionable notices above.
  const behind = behindOriginNow(clone, src);
  if (rec !== null && behind > 0) {
    return {
      kind: "commits-behind",
      localVersion: live,
      remoteVersion: rec.remoteVersion,
      behind,
      checkedAt: rec.checkedAt,
      source,
      apply,
    };
  }
  return null;
}

/**
 * The ONE line a person sees about an engine update — in the terminal, not in the model's context.
 *
 * The cold-start payload has always carried the update notice, but as `additionalContext` it
 * reaches the MODEL; the person only hears about it if the model chooses to mention it, or if
 * they run `doctor`. This is the same fact rendered for the surfaces that show text to a human:
 * a hook's `systemMessage` (Claude Code and Codex both display it), an OpenCode toast, and the
 * CLI's stderr. One sentence, one command to run, nothing else.
 *
 * Nothing is said under a PLUGIN install. Every line here ends in a clone command (`git pull`,
 * `./setup.sh`), and a plugin has neither: it updates through the harness's own plugin manager,
 * and the receipt `setup-required` keys on is written only by setup.sh — so a plugin-only machine
 * has no receipt by design and would otherwise be nagged forever about a step that does not
 * exist there. (The daemon that records origin's version is clone-only too, so `update` and
 * `commits-behind` cannot even arise on such a machine.) The model-facing context payload keeps
 * its existing behavior; only the human-facing line is gated.
 */
export function humanUpdateLine(
  notice: EngineUpdateNotice | null,
  opts: { ko: boolean; pluginContext: boolean; clone?: string },
): string {
  if (notice === null || opts.pluginContext) return "";
  const clone = opts.clone ?? CLONE_ROOT;
  const setup = `cd ${clone} && ./setup.sh`;
  switch (notice.kind) {
    case "update":
      return opts.ko
        ? `[llmwiki] 엔진 업데이트 있음: v${notice.localVersion} → v${notice.remoteVersion} — 적용: ${notice.apply}`
        : `[llmwiki] engine update available: v${notice.localVersion} → v${notice.remoteVersion} — apply: ${notice.apply}`;
    case "commits-behind":
      return opts.ko
        ? `[llmwiki] 엔진이 ${notice.source}보다 ${notice.behind}커밋 뒤 (버전 번호는 같음) — 적용: ${notice.apply}`
        : `[llmwiki] engine is ${notice.behind} commit(s) behind ${notice.source} (same version number) — apply: ${notice.apply}`;
    case "setup-required":
      return opts.ko
        ? `[llmwiki] 마지막 설치 뒤 엔진 파일이 변경됨 — 적용을 마치려면: ${setup}`
        : `[llmwiki] engine files changed since the last install — finish applying them: ${setup}`;
  }
}

/** Are we running as a harness PLUGIN rather than a clone install? Both harnesses export this. */
export function inPluginContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLAUDE_PLUGIN_ROOT ?? "").trim() !== "";
}

/**
 * Commits in HEAD..origin/main (or updateBase..<updateRemote>/main) RIGHT NOW, from local refs
 * only — no network.
 *
 * Deliberately not `rec.behind`: that number was measured by the daemon's last daily check, so it
 * survives the pull that resolves it. Reading it here would keep telling someone who just pulled
 * and re-ran setup that they are behind, for up to a day — a false alarm about the exact action we
 * asked them to take, which is worse than the silence this notice exists to fix. The fetch is
 * still the daemon's job; this only re-reads what that fetch already stored.
 *
 * 0 on any failure (no origin, no main, detached, git missing): the notice stays quiet rather than
 * guessing. Same local-refs-only rule as context.ts's team `behindUpstream`.
 */
function behindOriginNow(clone: string, src: UpdateSource = updateSource(clone)): number {
  return behindUpstream(clone, src, 5_000) ?? 0;
}

export interface UpstreamSync {
  ok: boolean;
  from: string | null; // updateBase before the run
  to: string | null; // <updateRemote>/main applied
  commits: string[]; // `git log --oneline from..to`, newest first
  message: string; // failure reason, or "" on success
}

/**
 * Stage `<updateBase>..<updateRemote>/main` onto a diverged fork as one file-level diff, then move
 * updateBase to the applied commit. Staging only — the person reviews and commits, then runs setup
 * (the receipt keys on HEAD, so setup before the commit would be stale again right after it).
 *
 * `--3way` makes an overlap with fork-only edits a visible conflict instead of a silent reject;
 * any failure leaves updateBase where it was, so the same command can simply be re-run.
 */
export function stageUpstreamSync(clone: string = CLONE_ROOT): UpstreamSync {
  const src = updateSource(clone);
  const fail = (message: string, to: string | null = null): UpstreamSync => ({
    ok: false,
    from: src.base,
    to,
    commits: [],
    message,
  });
  if (src.base === null) return fail("llmwiki.updateBase is not set — this clone tracks its upstream by history; use git pull");
  const fetch = spawnSync("git", ["fetch", "--quiet", src.remote, "main"], { cwd: clone, timeout: 60_000 });
  if (fetch.status !== 0) return fail(`git fetch ${src.remote} main failed`);
  const to = git(["rev-parse", "--verify", `${src.remote}/main`], clone);
  if (to === null || !GIT_OID_RE.test(to)) return fail(`${src.remote}/main is not resolvable`);
  if (to === src.base) return { ok: true, from: src.base, to, commits: [], message: "" };
  if (git(["merge-base", "--is-ancestor", src.base, to], clone) === null) {
    return fail(`updateBase ${src.base.slice(0, 12)} is not an ancestor of ${src.remote}/main`, to);
  }
  const diff = spawnSync("git", ["diff", "--binary", src.base, to], { cwd: clone, timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (diff.status !== 0) return fail("git diff failed", to);
  const applied = spawnSync("git", ["apply", "--index", "--3way"], { cwd: clone, input: diff.stdout, encoding: "utf8", timeout: 60_000 });
  if (applied.status !== 0) return fail(`git apply failed — resolve or reset the index, then re-run:\n${applied.stderr}`.trim(), to);
  if (git(["config", "--local", "llmwiki.updateBase", to], clone) === null) {
    return fail("applied, but recording llmwiki.updateBase failed — set it to the applied commit by hand", to);
  }
  const log = git(["log", "--oneline", "--no-decorate", `${src.base}..${to}`], clone) ?? "";
  return { ok: true, from: src.base, to, commits: log.split("\n").filter(Boolean), message: "" };
}
