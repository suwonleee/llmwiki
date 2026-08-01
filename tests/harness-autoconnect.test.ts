// Tier ②.5: connect an unusual machine WITHOUT asking anyone (src/engine/harness-autoconnect.ts).
//
// The rule under test is the safety boundary, not the search. Extended candidates include mounted
// Windows profiles under /mnt/c/Users/*, so "two verified locations" usually means "two people's
// session data on one machine" — and no automatic rule can tell which is yours. One winner is
// connected outright; more than one is handed off untouched.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MODULE = join(import.meta.dir, "..", "src", "engine", "harness-autoconnect.ts");

interface AutoConnectShape {
  status: "already" | "connected" | "ambiguous" | "none" | "env-shadowed" | "foreign";
  path: string | null;
  candidates: { path: string; origin: string }[];
  tried: string[];
  detail: string;
  handoff: string[];
  /** What the child process actually saw in $XDG_CONFIG_HOME — proves a `.env` test is not vacuous. */
  rawEnv: string | null;
}

/**
 * Run one autoConnect in a child process with a synthetic HOME.
 *
 * A child is required, not merely convenient: discovery reads HOME/XDG at call time and caches the
 * persisted file by mtime, so a same-process test would be answering about the developer's real
 * machine as often as about the fixture.
 */
function autoConnectIn(
  home: string,
  harness: string,
  env: Record<string, string> = {},
  cwd?: string,
): AutoConnectShape {
  const script = join(mkdtempSync(join(tmpdir(), "llmwiki-autoconnect-")), "probe.ts");
  writeFileSync(
    script,
    `import { autoConnect, renderHandoff } from ${JSON.stringify(MODULE)};\n` +
      `const r = autoConnect(${JSON.stringify(harness)});\n` +
      // rawEnv lets a test prove what the CHILD actually saw — a cwd `.env` only takes effect for
      // variables the parent did not define, so asserting on it is what keeps those tests honest.
      "console.log(JSON.stringify({ ...r, handoff: renderHandoff(r), rawEnv: process.env.XDG_CONFIG_HOME ?? null }));\n",
  );
  try {
    // An empty-string value means "make sure the child does NOT have this variable": Bun's .env
    // autoload never overrides a variable that is already present, even empty — so leaving the ""
    // in place would quietly disable the very .env behavior some tests exist to exercise.
    const merged: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      LLMWIKI_STATE_DIR: join(home, ".state"),
      CLAUDE_CONFIG_DIR: "",
      CODEX_HOME: "",
      OPENCODE_DB: "",
      ...env,
    };
    for (const key of Object.keys(merged)) if (merged[key] === "") delete merged[key];
    const r = Bun.spawnSync([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
      ...(cwd ? { cwd } : {}),
      env: merged,
    });
    const out = r.stdout.toString().trim();
    if (!out) throw new Error(`no output; stderr: ${r.stderr.toString().slice(0, 400)}`);
    return JSON.parse(out) as AutoConnectShape;
  } finally {
    rmSync(dirname(script), { recursive: true, force: true });
  }
}

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "llmwiki-home-"));
  mkdirSync(join(home, ".state"), { recursive: true });
  return home;
}

/** A Claude profile is only real once it holds a transcript — a bare projects/ proves nothing. */
function claudeProfile(dir: string): void {
  mkdirSync(join(dir, "projects", "demo"), { recursive: true });
  writeFileSync(join(dir, "projects", "demo", "session.jsonl"), '{"type":"user"}\n');
}

function persisted(home: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(home, ".state", "harness-paths.json"), "utf-8"));
  } catch {
    return null;
  }
}

describe("autoConnect", () => {
  test("connects a single nonstandard location and persists it, with nobody asked", () => {
    const home = fixtureHome();
    try {
      claudeProfile(join(home, ".config", "claude"));
      const r = autoConnectIn(home, "claude");
      expect(r.status).toBe("connected");
      expect(r.path).toBe(join(home, ".config", "claude"));
      expect(persisted(home)?.claudeConfigDirs).toEqual([join(home, ".config", "claude")]);
      // Nothing to hand off — the whole point is that this case never reaches a human.
      expect(r.handoff).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses to choose between two verified locations, and persists neither", () => {
    const home = fixtureHome();
    try {
      claudeProfile(join(home, ".config", "claude"));
      claudeProfile(join(home, "xdg", "claude"));
      const r = autoConnectIn(home, "claude", { XDG_CONFIG_HOME: join(home, "xdg") });
      expect(r.status).toBe("ambiguous");
      expect(r.candidates.length).toBe(2);
      expect(persisted(home)).toBeNull();
      expect(r.handoff.join("\n")).toContain("llmwiki connect claude");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("short-circuits when the ordinary resolution already reaches verified data", () => {
    const home = fixtureHome();
    try {
      claudeProfile(join(home, ".claude")); // the default location — no extended scan needed
      const r = autoConnectIn(home, "claude");
      expect(r.status).toBe("already");
      expect(r.tried).toEqual([]);
      expect(persisted(home)).toBeNull(); // nothing to persist: discovery already works
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports what it examined when there is genuinely nothing to find", () => {
    const home = fixtureHome();
    try {
      const r = autoConnectIn(home, "claude");
      expect(r.status).toBe("none");
      expect(r.path).toBeNull();
      expect(r.tried.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never records a lookalike: the schema signature still decides", () => {
    const home = fixtureHome();
    try {
      // projects/ exists but holds no transcript. Any directory can contain a folder called
      // projects/; only data proves a harness lives here.
      mkdirSync(join(home, ".config", "claude", "projects"), { recursive: true });
      const r = autoConnectIn(home, "claude");
      expect(r.status).toBe("none");
      expect(persisted(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("connects an OpenCode database found outside the XDG default", () => {
    const home = fixtureHome();
    try {
      const dir = join(home, ".opencode");
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, "opencode.db");
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE session (id TEXT)");
      db.exec("CREATE TABLE message (id TEXT)");
      db.close();

      const r = autoConnectIn(home, "opencode");
      expect(r.status).toBe("connected");
      expect(persisted(home)?.opencodeDb).toBe(dbPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the boundaries auto-connect must not cross", () => {
  test("a cloned repository's .env cannot steer what gets persisted", () => {
    // The demonstrated attack: a tracked `.env` redeclares XDG_CONFIG_HOME to a directory inside
    // the repo that carries a genuine-looking Claude profile. Bun autoloads `.env` from the cwd, so
    // running any llmwiki command from inside that clone used to persist the attacker's directory
    // as a capture source. The repo-env guard must make the engine behave as if the var were unset.
    const home = fixtureHome();
    const evil = mkdtempSync(join(tmpdir(), "llmwiki-evil-repo-"));
    try {
      claudeProfile(join(evil, "planted", "claude"));
      writeFileSync(join(evil, ".env"), `XDG_CONFIG_HOME=${join(evil, "planted")}\n`);
      // No XDG override in the parent env: the .env is the only thing naming the planted dir.
      const r = autoConnectIn(home, "claude", { XDG_CONFIG_HOME: "" }, evil);
      // Non-vacuity first: Bun really did load the repo's .env into the child…
      expect(r.rawEnv).toBe(join(evil, "planted"));
      // …and the guard still kept it out of discovery and out of the persisted file.
      expect(r.status).not.toBe("connected");
      expect(persisted(home)).toBeNull();
      expect(r.tried).not.toContain(join(evil, "planted", "claude"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(evil, { recursive: true, force: true });
    }
  });

  test("a verified location OUTSIDE the user's home is reported, never auto-connected", () => {
    // "Exactly one candidate" proves unambiguity, not ownership. On a shared machine the one
    // profile that verifies is routinely someone else's, so out-of-home data always goes through
    // an explicit `llmwiki connect` — which the handoff spells out verbatim.
    const home = fixtureHome();
    const elsewhere = mkdtempSync(join(tmpdir(), "llmwiki-other-user-"));
    try {
      claudeProfile(join(elsewhere, "claude"));
      const r = autoConnectIn(home, "claude", { XDG_CONFIG_HOME: elsewhere });
      expect(r.status).toBe("foreign");
      expect(persisted(home)).toBeNull();
      const text = r.handoff.join("\n");
      expect(text).toContain("llmwiki connect claude");
      expect(text).toContain(join(elsewhere, "claude"));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a set-but-broken env override blocks auto-connect instead of being silently shadowed", () => {
    // $CODEX_HOME wins over anything persisted. Persisting a scanned location while it is set would
    // print "connected" about a path the adapter will never read — the false green the installing
    // agent is trained to trust. The engine cannot unset a shell variable; it must hand off.
    const home = fixtureHome();
    try {
      mkdirSync(join(home, ".config", "codex", "sessions"), { recursive: true });
      writeFileSync(join(home, ".config", "codex", "sessions", "rollout-1.jsonl"), "{}\n");
      const r = autoConnectIn(home, "codex", { CODEX_HOME: join(home, "nonexistent-codex") });
      expect(r.status).toBe("env-shadowed");
      expect(persisted(home)).toBeNull();
      expect(r.detail).toContain("CODEX_HOME");
      expect(r.handoff.join("\n")).toContain("unset");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("renderHandoff", () => {
  test("names what was tried, what blocked it, and what to do — in that order", () => {
    const home = fixtureHome();
    try {
      const r = autoConnectIn(home, "codex");
      const text = r.handoff.join("\n");
      expect(text).toContain("blocked:");
      expect(text).toContain("options:");
      expect(text.indexOf("blocked:")).toBeLessThan(text.indexOf("options:"));
      if (r.tried.length) expect(text.indexOf("tried")).toBeLessThan(text.indexOf("blocked:"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("says nothing at all when the harness resolved", () => {
    const home = fixtureHome();
    try {
      claudeProfile(join(home, ".claude"));
      expect(autoConnectIn(home, "claude").handoff).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
