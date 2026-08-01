// Tier ②.5 of harness discovery: look HARDER before asking a human.
//
// The existing ladder is env var → persisted location → each harness's default path, and then it
// stops and hands off to an installing agent (tier ③, setup_text.md). That handoff is correct when
// the data is genuinely somewhere unguessable — and unnecessary for the handful of places it
// predictably IS when the default misses. The common one is WSL: the documented way to run this
// engine on Windows, where Claude Code and Codex keep their data in the WINDOWS profile
// (/mnt/c/Users/<name>/.claude) while the engine runs from a Linux home that has neither.
//
// So this module enumerates the near misses, verifies each with the same fail-closed signature
// check `connect` uses, and persists a winner without asking. The safety rule is the interesting
// part:
//
//   EXACTLY ONE verified candidate → connect it.
//   MORE THAN ONE                  → connect nothing, hand off the list.
//
// Because the strongest extended candidates live under /mnt/c/Users/*, "more than one" usually
// means "more than one PERSON'S data on this machine". Reading a stranger's sessions is a worse
// outcome than a prompt, and no automatic rule can tell which of two Windows profiles is yours.
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HARNESSES,
  connectHarnessPath,
  persistedClaudeDirs,
  persistedCodexHome,
  persistedOpencodeDb,
  verifyHarnessPath,
  type Harness,
} from "./harness-locate.ts";
import { claudeCaptureDirs } from "./sources/claude.ts";
import { envValueOutsideRepoFiles } from "./env-policy.ts";
import { codexHome } from "./sources/codex.ts";
import { opencodeDbPaths } from "./sources/opencode.ts";

/** Windows profile directories that are not a person. */
const SYSTEM_PROFILES = new Set(["public", "default", "default user", "all users", "defaultuser0"]);
/** A machine with more Windows profiles than this is a shared box; enumerating it is not our job. */
const MAX_WINDOWS_PROFILES = 24;

function home(): string {
  return process.env.HOME?.trim() || homedir();
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every Windows user profile reachable from this POSIX process — the WSL/MSYS/Cygwin mounts, in
 * that order. Returns [] on a machine with no Windows filesystem attached, which is most of them.
 */
export function windowsUserHomes(): string[] {
  const roots: string[] = [];
  for (const letter of "cdef") {
    roots.push(`/mnt/${letter}/Users`, `/${letter}/Users`, `/cygdrive/${letter}/Users`);
  }
  const homes: string[] = [];
  for (const root of roots) {
    if (!isDir(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SYSTEM_PROFILES.has(name.toLowerCase())) continue;
      const candidate = join(root, name);
      if (isDir(candidate) && !homes.includes(candidate)) homes.push(candidate);
      if (homes.length >= MAX_WINDOWS_PROFILES) return homes;
    }
  }
  return homes;
}

/** OpenCode names its database opencode.db, or opencode-<channel>.db. */
function opencodeDbsIn(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^opencode(-[A-Za-z0-9_.-]+)?\.db$/.test(name))
    .map((name) => join(dir, name))
    .filter((path) => existsSync(path));
}

export interface Candidate {
  readonly path: string;
  /** Why this path was considered — quoted verbatim in a handoff. */
  readonly origin: string;
}

/**
 * Places to look once the deterministic resolution has come up empty. Cheap and finite: no
 * filesystem walk, only named directories and one readdir per Windows profile root.
 */
export function extendedCandidates(harness: Harness): Candidate[] {
  const out: Candidate[] = [];
  const push = (path: string, origin: string): void => {
    if (path && !out.some((c) => c.path === path)) out.push({ path, origin });
  };
  const h = home();
  // Guarded reads, non-negotiably. Bun autoloads the cwd's `.env`, the cwd is a repository, and
  // THIS module is the one that persists what it finds — an unguarded read here turns a tracked
  // `.env` (with `${PWD}` expansion, so the value is absolute and passes every path check) into a
  // permanent, attacker-chosen capture source. The security review demonstrated exactly that
  // end-to-end. Schema verification does not save us: the attacker ships a genuine-looking store.
  const xdgConfig = envValueOutsideRepoFiles("XDG_CONFIG_HOME")?.trim() || join(h, ".config");
  const xdgData = envValueOutsideRepoFiles("XDG_DATA_HOME")?.trim() || join(h, ".local", "share");
  const winHomes = windowsUserHomes();

  if (harness === "claude") {
    for (const win of winHomes) push(join(win, ".claude"), "Windows profile (WSL mount)");
    push(join(xdgConfig, "claude"), "XDG config dir");
    push(join(h, ".config", "claude"), "~/.config");
  } else if (harness === "codex") {
    for (const win of winHomes) push(join(win, ".codex"), "Windows profile (WSL mount)");
    push(join(xdgConfig, "codex"), "XDG config dir");
    push(join(h, ".config", "codex"), "~/.config");
  } else {
    for (const win of winHomes) {
      for (const db of opencodeDbsIn(join(win, "AppData", "Local", "opencode", "data"))) {
        push(db, "Windows profile (WSL mount)");
      }
    }
    for (const db of opencodeDbsIn(join(xdgData, "opencode"))) push(db, "XDG data dir");
    for (const db of opencodeDbsIn(join(h, ".local", "share", "opencode"))) push(db, "~/.local/share");
    for (const db of opencodeDbsIn(join(h, ".opencode"))) push(db, "~/.opencode");
    for (const db of opencodeDbsIn(join(h, "Library", "Application Support", "opencode"))) {
      push(db, "macOS Application Support");
    }
  }
  return out;
}

/** Does the ordinary resolution already reach verified data for this harness? */
function alreadyResolved(harness: Harness): string | null {
  const current: string[] =
    harness === "claude"
      ? [...claudeCaptureDirs(), ...persistedClaudeDirs()]
      : harness === "codex"
        ? [envValueOutsideRepoFiles("CODEX_HOME")?.trim() || persistedCodexHome() || codexHome()]
        : (() => {
            const pinned = envValueOutsideRepoFiles("OPENCODE_DB")?.trim() || persistedOpencodeDb();
            return pinned ? [pinned] : opencodeDbPaths();
          })();
  for (const path of current) {
    if (path && verifyHarnessPath(harness, path).ok) return path;
  }
  return null;
}

export type AutoConnectStatus = "already" | "connected" | "ambiguous" | "none" | "env-shadowed" | "foreign";

/**
 * The env var that OVERRIDES persisted locations for this harness, or null when overrides are
 * additive (Claude's env dir joins the scan list; it never shadows a persisted one).
 */
function shadowingEnv(harness: Harness): { name: string; value: string } | null {
  if (harness === "claude") return null;
  const name = harness === "codex" ? "CODEX_HOME" : "OPENCODE_DB";
  const value = envValueOutsideRepoFiles(name)?.trim();
  return value ? { name, value } : null;
}

/** Is this path inside the current user's own home directory? */
function insideHome(path: string): boolean {
  const h = home().replace(/[\\/]+$/, "");
  return path === h || path.startsWith(h + "/");
}

export interface AutoConnectResult {
  readonly harness: Harness;
  readonly status: AutoConnectStatus;
  /** The location in play — resolved, or newly connected. Null for ambiguous/none. */
  readonly path: string | null;
  /** Every verified candidate, when more than one made the decision impossible. */
  readonly candidates: readonly Candidate[];
  /** Paths examined and rejected — the evidence a handoff quotes. */
  readonly tried: readonly string[];
  readonly detail: string;
}

/**
 * Resolve `harness` the hard way, persisting the result when it is unambiguous.
 *
 * Verification is unchanged and non-negotiable: a candidate must carry the harness's schema
 * signature (a `session` table, a rollout file, a transcript under projects/) before it is
 * recorded. Looking in more places widens what can be FOUND; it never widens what is BELIEVED.
 */
export function autoConnect(harness: Harness): AutoConnectResult {
  const resolved = alreadyResolved(harness);
  if (resolved !== null) {
    return {
      harness,
      status: "already",
      path: resolved,
      candidates: [],
      tried: [],
      detail: `already resolves to verified data at ${resolved}`,
    };
  }

  // A set env var WINS over anything persisted (codex/opencode), so reaching this point with one
  // set means it names a location that failed verification — and persisting something else would
  // print "connected" while the adapter keeps reading the env value. The engine cannot unset a
  // shell variable; this is genuinely the user's call.
  const shadow = shadowingEnv(harness);
  if (shadow) {
    return {
      harness,
      status: "env-shadowed",
      path: null,
      candidates: [],
      tried: [shadow.value],
      detail:
        `$${shadow.name} is set to ${shadow.value}, which fails verification — and an env var ` +
        `overrides anything this engine could persist, so auto-connect would be a lie`,
    };
  }

  const candidates = extendedCandidates(harness);
  const tried: string[] = [];
  const verified: Candidate[] = [];
  for (const candidate of candidates) {
    tried.push(candidate.path);
    if (verifyHarnessPath(harness, candidate.path).ok) verified.push(candidate);
  }

  if (verified.length === 1) {
    const winner = verified[0]!;
    // Auto-persist ONLY inside the user's own home. A mounted Windows profile under /mnt/c/Users/*
    // verifies exactly when it holds someone's real sessions — and on a shared box the one profile
    // that verifies is routinely someone ELSE's. "Exactly one candidate" proves unambiguity, not
    // ownership; for data outside $HOME the missing evidence is consent, and no count supplies it.
    // The candidate is still reported with the exact connect command, so claiming it is one paste.
    if (!insideHome(winner.path)) {
      return {
        harness,
        status: "foreign",
        path: null,
        candidates: verified,
        tried,
        detail:
          `${winner.path} (${winner.origin}) verifies, but it lives outside this user's home — ` +
          `likely another person's profile, so it is never connected without an explicit command`,
      };
    }
    const r = connectHarnessPath(harness, winner.path);
    return r.ok
      ? {
          harness,
          status: "connected",
          path: winner.path,
          candidates: verified,
          tried,
          detail: `found and connected automatically — ${winner.path} (${winner.origin}): ${r.detail}`,
        }
      : {
          harness,
          status: "none",
          path: null,
          candidates: [],
          tried,
          detail: `a verified location could not be persisted: ${r.detail}`,
        };
  }

  if (verified.length > 1) {
    return {
      harness,
      status: "ambiguous",
      path: null,
      candidates: verified,
      tried,
      detail:
        `${verified.length} separate ${harness} data locations verified — these are usually different ` +
        `people's profiles, so none was connected automatically`,
    };
  }

  return {
    harness,
    status: "none",
    path: null,
    candidates: [],
    tried,
    detail: tried.length
      ? `no ${harness} data found in ${tried.length} additional location(s)`
      : `no additional ${harness} locations to try on this machine`,
  };
}

/** Is this harness's CLI installed here at all? Separates "misplaced data" from "not installed". */
export function harnessInstalled(harness: Harness): boolean {
  return Bun.which(harness === "claude" ? "claude" : harness) !== null;
}

export function autoConnectAll(): AutoConnectResult[] {
  return HARNESSES.map(autoConnect);
}

/** What a person or an installing agent has to supply for this harness, and how it is checked. */
function signatureOf(harness: Harness): string {
  switch (harness) {
    case "claude":
      return "its config dir — the one holding projects/ with *.jsonl transcripts (default ~/.claude*, env $CLAUDE_CONFIG_DIR)";
    case "codex":
      return "its home — the one holding sessions/ with rollout-*.jsonl, or state_*.sqlite (default ~/.codex, env $CODEX_HOME)";
    case "opencode":
      return "its database file — opencode*.db with a `session` table (default $XDG_DATA_HOME/opencode/, env $OPENCODE_DB)";
  }
}

/**
 * THE handoff block. One shape, used by every surface that runs out of automatic options, so a
 * person reads the same three lines everywhere and an installing agent can parse one format.
 *
 * Three fields, in the order a reader needs them: what was already TRIED (so nobody repeats it),
 * what BLOCKED the automatic answer, and the OPTIONS that resolve it. Anything the engine could
 * have done itself has been done before this renders — reaching here means the remaining decision
 * genuinely belongs to a human.
 */
export function renderHandoff(result: AutoConnectResult, indent = "  "): string[] {
  const { harness } = result;
  const lines: string[] = [];
  const label = `${indent}[${harness}]`;
  const cont = `${indent}${" ".repeat(harness.length + 2)}`;

  if (result.status === "already" || result.status === "connected") return lines;

  const installed = harnessInstalled(harness);
  lines.push(`${label} ⚠️ no verified ${harness} data location`);
  if (result.tried.length) {
    const shown = result.tried.slice(0, 6).join(", ");
    const more = result.tried.length > 6 ? `, … (${result.tried.length} total)` : "";
    lines.push(`${cont} tried  : ${shown}${more}`);
  }
  lines.push(`${cont} blocked: ${result.detail}`);

  if (result.status === "env-shadowed") {
    lines.push(`${cont} options: 1) if that path is wrong, unset the variable and re-run: llmwiki locate ${harness}`);
    lines.push(`${cont}          2) if it is right but empty, use the harness once so it has data, then re-run`);
    lines.push(`${cont}          3) check what is actually there: llmwiki locate ${harness} <that-path>`);
    return lines;
  }

  if (result.status === "foreign") {
    for (const candidate of result.candidates) {
      lines.push(`${cont}          • ${candidate.path} (${candidate.origin})`);
    }
    lines.push(`${cont} options: 1) if that profile is YOURS, connect it explicitly:`);
    const one = result.candidates[0];
    lines.push(`${cont}               llmwiki connect ${harness} ${one ? JSON.stringify(one.path) : "<path>"}`);
    lines.push(`${cont}          2) if it is someone else's, do nothing — it will never be read`);
    return lines;
  }

  if (result.status === "ambiguous") {
    for (const candidate of result.candidates) {
      lines.push(`${cont}          • ${candidate.path} (${candidate.origin})`);
    }
    lines.push(`${cont} options: 1) pick the one that is yours and run:`);
    lines.push(`${cont}               llmwiki connect ${harness} <path>`);
    lines.push(`${cont}          2) connect several deliberately by repeating that command`);
    return lines;
  }

  if (!installed) {
    lines.push(
      `${cont} options: 1) nothing to do — the ${harness} CLI is not installed on this machine, so there`,
    );
    lines.push(`${cont}               is no data to capture yet; it will be picked up after you install it`);
    lines.push(`${cont}          2) if the CLI IS installed under another name/path, point at its data:`);
    lines.push(`${cont}               llmwiki locate ${harness} <path>   ·   llmwiki connect ${harness} <path>`);
    return lines;
  }

  lines.push(`${cont} options: 1) find ${signatureOf(harness)}`);
  lines.push(`${cont}          2) check it (read-only):  llmwiki locate ${harness} <path>`);
  lines.push(`${cont}          3) persist it:            llmwiki connect ${harness} <path>`);
  lines.push(`${cont}             (refused unless the check passes — nothing unverified is ever recorded)`);
  return lines;
}
