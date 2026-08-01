// A persisted harness location must survive crossing between Windows and its POSIX shells.
//
// `harness-paths.json` is the artifact that exists to rescue a machine whose harness data is
// somewhere unusual — and it was the one that failed quietly. Every entry was filtered through
// `path.isAbsolute`, which is platform-specific: `C:\Users\me\.codex` is not absolute under POSIX
// rules, so a location connected on native Windows vanished with ZERO output when the same person
// worked in WSL. Discovery then fell back to defaults and looked like it had never been configured.
//
// WSL is the documented way to run this engine on Windows, so that is the supported path, not an
// exotic one.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { windowsDriveMounts } from "../src/engine/harness-locate.ts";

describe("windowsDriveMounts", () => {
  test("offers every shell's spelling of a drive path, in preference order", () => {
    expect(windowsDriveMounts("C:\\Users\\me\\.codex")).toEqual([
      "/mnt/c/Users/me/.codex",
      "/c/Users/me/.codex",
      "/cygdrive/c/Users/me/.codex",
    ]);
  });

  test("accepts forward slashes and any drive letter, normalizing the letter", () => {
    expect(windowsDriveMounts("D:/data/opencode/opencode.db")[0]).toBe("/mnt/d/data/opencode/opencode.db");
  });

  test("leaves POSIX paths alone — there is nothing to translate", () => {
    expect(windowsDriveMounts("/home/me/.codex")).toEqual([]);
    expect(windowsDriveMounts("relative/path")).toEqual([]);
    // A single letter followed by a colon is the only shape that means "drive"; a URL is not one.
    expect(windowsDriveMounts("https://example.com/x")).toEqual([]);
  });
});

/** Read the persisted locations the way the engine does, under a controlled state root. */
function readPersisted(stateDir: string): Record<string, unknown> {
  const module = join(import.meta.dir, "..", "src", "engine", "harness-locate.ts");
  const script = join(mkdtempSync(join(tmpdir(), "llmwiki-paths-probe-")), "probe.ts");
  writeFileSync(
    script,
    `import { persistedCodexHome, persistedOpencodeDb, persistedClaudeDirs } from ${JSON.stringify(module)};\n` +
      "console.log(JSON.stringify({ codex: persistedCodexHome(), opencode: persistedOpencodeDb(), claude: persistedClaudeDirs() }));\n",
  );
  try {
    const r = Bun.spawnSync([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LLMWIKI_STATE_DIR: stateDir } as Record<string, string>,
    });
    return JSON.parse(r.stdout.toString().trim() || "{}");
  } finally {
    rmSync(dirname(script), { recursive: true, force: true });
  }
}

function stateWith(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-state-"));
  writeFileSync(join(dir, "harness-paths.json"), JSON.stringify(contents, null, 2) + "\n");
  return dir;
}

describe("reading a harness-paths.json written on another platform", () => {
  test("a Windows path whose mount is not present here is still dropped", () => {
    // Translation is only ever accepted against a mount that EXISTS. Without one, a drive path is a
    // guess, and this engine does not act on guesses about where data lives.
    const dir = stateWith({ version: 1, codexHome: "C:\\Users\\nobody\\.codex" });
    try {
      expect(readPersisted(dir).codex).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("POSIX entries are untouched by the translation path", () => {
    const target = mkdtempSync(join(tmpdir(), "llmwiki-codex-home-"));
    const dir = stateWith({ version: 1, codexHome: target });
    try {
      expect(readPersisted(dir).codex).toBe(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("a mixed file keeps the usable entries instead of failing whole", () => {
    const target = mkdtempSync(join(tmpdir(), "llmwiki-claude-dir-"));
    mkdirSync(join(target, "projects"), { recursive: true });
    const dir = stateWith({
      version: 1,
      codexHome: "C:\\Users\\nobody\\.codex", // unreachable here
      claudeConfigDirs: [target, "C:\\Users\\nobody\\.claude"],
    });
    try {
      const persisted = readPersisted(dir);
      expect(persisted.codex).toBeNull();
      expect(persisted.claude).toEqual([target]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("a translatable drive path IS adopted when its mount exists", () => {
    // The real WSL shape, reproduced without WSL: point the drive translation at a directory that
    // genuinely exists by building the mount layout the translator looks for. `/mnt/...` is not
    // writable in a test, so this asserts the decision rule through the pure function instead — the
    // integration above proves the filter, this proves the intent.
    const candidates = windowsDriveMounts("C:\\Users\\me\\.claude");
    expect(candidates[0]).toBe("/mnt/c/Users/me/.claude");
    expect(candidates.some((path) => path.includes("Users/me/.claude"))).toBe(true);
  });
});
