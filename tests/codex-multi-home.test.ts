// Codex is no longer a single-home harness.
//
// Codex Desktop (which ships as the `orca` app) runs each signed-in account against its own
// relocated CODEX_HOME under the app's data directory, exporting that variable into the processes
// it launches. A detached capture daemon never sees the export, so a machine-level sweep pinned to
// one home simply stops seeing new sessions — and says "nothing captured", not "wrong directory".
//
// Measured on the author's machine when this was found (2026-09-03): ~/.codex/sessions had frozen
// on 2026-08-22, its rollouts hardlinked into the account home at migration, while the account
// home kept writing. 40 rollouts existed only there, 6 of them in enrolled repositories. Across
// all three homes 494 rollout FILES resolved to 188 distinct inodes.
//
// Two invariants pull in opposite directions, and both are load-bearing:
//   - default (no real override) must sweep every home this machine owns, or capture goes blind;
//   - an explicit override must stay EXCLUSIVE, or pointing CODEX_HOME at a fixture (or at one
//     account) silently drags in every other home's sessions.
// The seam between them is that the daemon's service definition bakes `${CODEX_HOME:-$HOME/.codex}`
// at install time, so a machine that had nothing set exports the DEFAULT as though it were a
// choice. That frozen default must not count as an override — it is what pinned the daemon.
import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexHomes, codexSource } from "../src/engine/sources/codex.ts";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix = "llmwiki-codex-homes-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write one plain rollout with a resolvable session id + cwd, and return its path. */
function rollout(sessionsDir: string, id: string, cwd: string): string {
  const day = join(sessionsDir, "2026", "09", "01");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-09-01T10-00-00-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd } }) + "\n");
  return path;
}

/** The desktop app's per-account home, exactly as it lays it out on darwin. */
function orcaAccountHome(home: string, account: string): string {
  const dir = join(home, "Library", "Application Support", "orca", "codex-accounts", account, "home");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  // the app's own marker; account homes carry it, the shared runtime home does not
  writeFileSync(join(dir, ".orca-managed-home"), account);
  return dir;
}

const UUID_A = "01a00000-0000-7000-8000-00000000000a";
const UUID_B = "01a00000-0000-7000-8000-00000000000b";

describe("Codex reads every home this machine owns", () => {
  test("the baked-default CODEX_HOME still sweeps desktop-app homes (the pinned-daemon case)", () => {
    if (process.platform !== "darwin") return; // the app's data root is platform-specific
    const home = scratch();
    setEnv("HOME", home);
    const cliHome = join(home, ".codex");
    mkdirSync(join(cliHome, "sessions"), { recursive: true });
    // exactly what daemon/install.sh freezes into the service definition on a machine that had
    // nothing set: the default, exported as if it were a decision
    setEnv("CODEX_HOME", cliHome);
    const appHome = orcaAccountHome(home, "0e1c9d2a-4b6f-4a1e-8c3d-5f7a9b1c2d3e");

    rollout(join(cliHome, "sessions"), UUID_A, "/repo/cli");
    rollout(join(appHome, "sessions"), UUID_B, "/repo/app");

    expect(codexHomes()).toEqual([cliHome, appHome]);
    const routes = codexSource.discoverRoutes();
    expect(routes.map((r) => r.sessionId).sort()).toEqual([UUID_A, UUID_B]);
    expect(routes.map((r) => r.repo).sort()).toEqual(["/repo/app", "/repo/cli"]);
  });

  test("a real override is exclusive — it never drags in the other homes", () => {
    if (process.platform !== "darwin") return;
    const home = scratch();
    setEnv("HOME", home);
    const cliHome = join(home, ".codex");
    mkdirSync(join(cliHome, "sessions"), { recursive: true });
    const appHome = orcaAccountHome(home, "0e1c9d2a-4b6f-4a1e-8c3d-5f7a9b1c2d3e");
    rollout(join(cliHome, "sessions"), UUID_A, "/repo/cli");
    rollout(join(appHome, "sessions"), UUID_B, "/repo/app");

    // a third, deliberately chosen home — the shape a test fixture or `llmwiki connect` produces
    const chosen = scratch("llmwiki-codex-chosen-");
    mkdirSync(join(chosen, "sessions"), { recursive: true });
    const only = "01a00000-0000-7000-8000-00000000000c";
    rollout(join(chosen, "sessions"), only, "/repo/chosen");
    setEnv("CODEX_HOME", chosen);

    expect(codexHomes()).toEqual([chosen]);
    expect(codexSource.discoverRoutes().map((r) => r.sessionId)).toEqual([only]);
  });

  test("a rollout hardlinked into two homes is discovered ONCE (the queue is keyed by path)", () => {
    if (process.platform !== "darwin") return;
    const home = scratch();
    setEnv("HOME", home);
    const cliHome = join(home, ".codex");
    mkdirSync(join(cliHome, "sessions"), { recursive: true });
    setEnv("CODEX_HOME", cliHome);
    const appHome = orcaAccountHome(home, "0e1c9d2a-4b6f-4a1e-8c3d-5f7a9b1c2d3e");

    // the migration's own shape: the same inode reachable under both homes...
    const shared = rollout(join(cliHome, "sessions"), UUID_A, "/repo/shared");
    const linkDay = join(appHome, "sessions", "2026", "09", "01");
    mkdirSync(linkDay, { recursive: true });
    linkSync(shared, join(linkDay, `rollout-2026-09-01T10-00-00-${UUID_A}.jsonl`));
    // ...plus one that exists only in the app home, which is the content that was being lost
    rollout(join(appHome, "sessions"), UUID_B, "/repo/app-only");

    const routes = codexSource.discoverRoutes();
    expect(routes.map((r) => r.sessionId).sort()).toEqual([UUID_A, UUID_B]);
    // the shared conversation resolves to the primary home, not the app copy
    expect(routes.find((r) => r.sessionId === UUID_A)!.path).toBe(shared);
  });

  test("a home that does not exist is skipped rather than failing the sweep", () => {
    const home = scratch();
    setEnv("HOME", home);
    setEnv("CODEX_HOME", join(home, "nope"));
    expect(codexHomes()).toEqual([]);
    expect(codexSource.discoverRoutes()).toEqual([]);
  });
});
