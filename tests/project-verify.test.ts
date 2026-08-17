import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";
import { supervisorStubs } from "./support/service-definition.ts";

const ROOT = join(import.meta.dir, "..");

describe("single project readiness receipt", () => {
  let scratch = "";

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("proves machine wiring, enrollment, index, and cold-start memory together", () => {
    scratch = mkdtempSync(join(tmpdir(), "llmwiki-project-verify-"));
    const home = join(scratch, "home");
    const profile = join(scratch, "claude");
    const state = join(scratch, "state");
    const bin = join(scratch, "bin");
    const repo = join(scratch, "project");
    for (const dir of [home, profile, repo]) mkdirSync(dir, { recursive: true });
    inertSupervisorBin(bin, {
      claude: "#!/bin/sh\nexit 0\n",
      ...supervisorStubs(),
    });
    const git = join(bin, "git");
    writeFileSync(git, "#!/bin/sh\nexec /usr/bin/git \"$@\"\n");
    chmodSync(git, 0o755);
    const env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: profile,
      LLMWIKI_STATE_DIR: state,
      PATH: [bin, dirname(process.execPath), join(home, ".local", "bin"), "/usr/bin", "/bin"].join(":"),
      USER: "project-verify-user",
    };
    const run = (args: string[], cwd = ROOT) =>
      Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });

    expect(run(["git", "init", "-q", repo], scratch).exitCode).toBe(0);
    expect(run(["bash", join(ROOT, "setup.sh"), "--harness", "claude"]).exitCode).toBe(0);
    expect(run([process.execPath, join(ROOT, "src", "cli.ts"), "init", repo]).exitCode).toBe(0);

    const verified = run([process.execPath, join(ROOT, "src", "cli.ts"), "verify", repo, "--harness", "claude"]);
    const output = verified.stdout.toString() + verified.stderr.toString();
    expect(verified.exitCode, output).toBe(0);
    expect(output).toContain("project work-memory readiness");
    expect(output).toContain("[project] ✅ enrolled");
    expect(output).toContain("[memory] ✅ cold-start context is non-empty");
    expect(output).toContain("READY: automatic work-memory read and capture mechanics are active");

    expect(run([process.execPath, join(ROOT, "src", "cli.ts"), "disable", repo]).exitCode).toBe(0);
    const disabled = run([process.execPath, join(ROOT, "src", "cli.ts"), "verify", repo, "--harness", "claude"]);
    expect(disabled.exitCode).toBe(1);
    expect(disabled.stdout.toString()).toContain("[project] ❌ not enrolled");
  }, 20_000);
});
