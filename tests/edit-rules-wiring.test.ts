// Clone install of the PreToolUse edit-rules hook (src/daemon/wire.ts) and doctor's view of it.
//
// PreToolUse is where people keep their OWN guards (a branch guard, a formatter), so the contract is
// narrow: our group is added beside theirs with the edit-tool matcher, re-running setup leaves
// exactly one, and uninstall removes ours and nothing else.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EDIT_HOOK_MATCHER } from "../src/engine/edit-rules.ts";

const ROOT = join(import.meta.dir, "..");
const GUARD = { matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: "bash ~/guards/branch-guard.sh --event PreToolUse" }] };

describe("Claude clone install: PreToolUse edit-rules hook", () => {
  let dir: string;
  let profile: string;
  let env: Record<string, string>;

  const settings = () => JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  const ours = () => (settings().hooks?.PreToolUse ?? []).filter((g: any) => JSON.stringify(g).includes("pretooluse-inject.sh"));

  function run(entry: string[]): { code: number; out: string } {
    const r = Bun.spawnSync(["bun", ...entry], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
  }
  const wire = (...args: string[]) => run([join(ROOT, "src", "daemon", "wire.ts"), ...args]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-editrules-wire-"));
    profile = join(dir, "profile");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    for (const d of [home, bin, join(profile, "commands")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(profile, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [GUARD] } }));
    const launchctl = join(bin, "launchctl");
    writeFileSync(launchctl, "#!/bin/sh\nif [ \"${1:-}\" = list ]; then printf '0\\t0\\tcom.llmwiki.daemon\\n'; fi\nexit 0\n");
    chmodSync(launchctl, 0o755);
    env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: profile,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    } as Record<string, string>;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("install adds one owned group beside the user's guard; re-install stays at one", () => {
    expect(wire().code).toBe(0);
    expect(ours()).toEqual([
      {
        matcher: EDIT_HOOK_MATCHER,
        hooks: [{ type: "command", command: `bash '${ROOT}/hooks/pretooluse-inject.sh'`, timeout: 5 }],
      },
    ]);
    expect(settings().hooks.PreToolUse[0]).toEqual(GUARD);
    // Bash too: agents edit through shell commands (bash-writes.ts), in one group with the edit tools.
    expect(EDIT_HOOK_MATCHER.split("|")).toEqual(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);

    expect(wire().code).toBe(0);
    expect(ours()).toHaveLength(1);
    expect(settings().hooks.PreToolUse).toHaveLength(2);
  });

  test("uninstall removes ours and leaves the guard byte-for-byte", () => {
    wire();
    expect(wire("--revert").code).toBe(0);
    expect(settings().hooks.PreToolUse).toEqual([GUARD]);
    expect(wire("--revert").code).toBe(0); // idempotent
    expect(settings().hooks.PreToolUse).toEqual([GUARD]);
  });

  test("doctor sees the wired hook, and --fix re-registers a lost one with the edit matcher", () => {
    wire();
    const doctor = (...a: string[]) => run([join(ROOT, "src", "cli.ts"), "doctor", "--harness", "claude", ...a]).out;
    expect(doctor()).toContain("edit-rules hook present");

    const s = settings();
    s.hooks.PreToolUse = [GUARD];
    writeFileSync(join(profile, "settings.json"), JSON.stringify(s));
    expect(doctor()).toContain("no llmwiki PreToolUse edit-rules hook");
    expect(doctor("--fix")).toContain("re-registered");
    expect(ours()).toHaveLength(1);
    expect(ours()[0].matcher).toBe(EDIT_HOOK_MATCHER);
    expect(settings().hooks.PreToolUse[0]).toEqual(GUARD);
  });

  test("an install from before Bash was matched is flagged by doctor and re-pointed by setup", () => {
    wire();
    const doctor = () => run([join(ROOT, "src", "cli.ts"), "doctor", "--harness", "claude"]).out;
    const s = settings();
    for (const g of s.hooks.PreToolUse) if (JSON.stringify(g).includes("pretooluse-inject.sh")) g.matcher = "Edit|Write|MultiEdit|NotebookEdit";
    writeFileSync(join(profile, "settings.json"), JSON.stringify(s));
    expect(doctor()).toContain('edit-rules hook matcher is "Edit|Write|MultiEdit|NotebookEdit"');
    expect(wire().code).toBe(0);
    expect(ours()).toHaveLength(1);
    expect(ours()[0].matcher).toBe(EDIT_HOOK_MATCHER);
    expect(doctor()).toContain("edit-rules hook present");
    expect(settings().hooks.PreToolUse[0]).toEqual(GUARD);
  });
});
