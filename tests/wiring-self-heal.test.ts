// The harness holds settings.json in memory and writes it back whole on any in-session change
// (/model, a permission grant), silently dropping hooks added on disk after that session started —
// including what setup.sh installed from inside that very session. The daemon re-asserts them.
// These pin the conservative contract: heal only TOTAL loss, never fight a different clone's
// wiring, never create a profile, never touch a file that does not parse.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reassertClaudeReadHooks } from "../src/engine/doctor.ts";

let dir = "";
let savedHome: string | undefined;
let savedCfg: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-selfheal-"));
  savedHome = process.env.HOME;
  savedCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = dir;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon wiring self-heal", () => {
  test("re-adds both read hooks after a settings rewrite dropped them, keeping the user's keys", () => {
    const profile = join(dir, ".claude");
    mkdirSync(profile);
    writeFileSync(join(profile, "settings.json"), JSON.stringify({ model: "opus" }) + "\n");

    const notes = reassertClaudeReadHooks();

    expect(notes.length).toBe(2);
    const cur = JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
    expect(cur.model).toBe("opus"); // additive — the rewrite that caused this was a clobber; the repair must not be
    const hooks = JSON.stringify(cur.hooks);
    expect(hooks).toContain("hooks/sessionstart-inject.sh");
    expect(hooks).toContain("hooks/userpromptsubmit-inject.sh");
  });

  test("a profile wired to a DIFFERENT clone is left byte-identical — conflicts are doctor's to report", () => {
    const profile = join(dir, ".claude");
    mkdirSync(profile);
    const body =
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash /elsewhere/hooks/sessionstart-inject.sh" }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "bash /elsewhere/hooks/userpromptsubmit-inject.sh" }] }],
        },
      }) + "\n";
    writeFileSync(join(profile, "settings.json"), body);

    expect(reassertClaudeReadHooks()).toEqual([]);
    expect(readFileSync(join(profile, "settings.json"), "utf-8")).toBe(body);
  });

  test("a profile without settings.json is never created", () => {
    mkdirSync(join(dir, ".claude-bare"));

    expect(reassertClaudeReadHooks()).toEqual([]);
    expect(existsSync(join(dir, ".claude-bare", "settings.json"))).toBe(false);
  });

  test("a file that does not parse is reported and left untouched", () => {
    const profile = join(dir, ".claude");
    mkdirSync(profile);
    writeFileSync(join(profile, "settings.json"), "{ malformed\n");

    const notes = reassertClaudeReadHooks();

    expect(notes.join(" ")).toContain("parse failed");
    expect(readFileSync(join(profile, "settings.json"), "utf-8")).toBe("{ malformed\n");
  });
});
