// The daemon installer must report a VERIFIED state, never an assumed one.
//
// The macOS branch used to run `launchctl load` and then print "✓ installed + loaded launchd"
// unconditionally — including when launchctl was missing entirely, where the shell's own
// "command not found" was the only clue and the script still exited 0. A plist on disk is not a
// running daemon, and a green line over a dead capture loop is the one failure this engine cannot
// afford: everything downstream (backlog, pending nags, doctor) reads as healthy while nothing is
// being captured. Linux already had the right shape — try a supervisor, else start the process
// anyway and say so — so these pin that macOS behaves the same.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const darwin = process.platform === "darwin";
let scratch = "";

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

/**
 * Run daemon/install.sh against isolated dirs with every external supervisor stubbed.
 * `launchctlList` is what the fake `launchctl list` prints — the only thing that decides whether
 * launchd actually took the job.
 */
function runInstall(opts: { launchctl: boolean; launchctlList: string }): { out: string; code: number | null } {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-daemon-install-"));
  const home = join(scratch, "home");
  const state = join(scratch, "state");
  const bin = join(scratch, "bin");
  const sysbin = join(scratch, "sysbin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(sysbin, { recursive: true });

  // The system PATH cannot be inherited here. `launchctl` lives in /bin, so "pretend it is absent"
  // would otherwise run the REAL one — which happily loads a temp-dir plist into the developer's
  // own launchd under the shared label and leaves it pointing at a deleted file once the test
  // cleans up. So the sandbox gets an explicit tool list instead, with no supervisor in it.
  for (const tool of "bash sh env uname mkdir rm ls cat grep sed awk tr head tail sort wc chmod cp mv find ps sleep kill basename dirname date nohup id".split(" ")) {
    // existsSync first: symlinkSync happily creates a DANGLING link, so "try /bin, fall back to
    // /usr/bin" silently linked every tool to a path that does not exist.
    for (const dir of ["/bin", "/usr/bin"]) {
      if (!existsSync(join(dir, tool))) continue;
      try {
        symlinkSync(join(dir, tool), join(sysbin, tool));
      } catch {
        /* already linked */
      }
      break;
    }
  }

  // `bun` shim: answers the state-bootstrap call with a path, and exits immediately when asked to
  // launch watch.ts — so the fallback's background start leaves no process behind.
  const bunShim = join(bin, "bun");
  writeFileSync(
    bunShim,
    `#!/bin/bash\ncase "$*" in\n  *state-bootstrap.ts*) mkdir -p ${JSON.stringify(state)}; echo ${JSON.stringify(state)};;\n  *) exit 0;;\nesac\n`,
  );
  chmodSync(bunShim, 0o755);

  if (opts.launchctl) {
    const lc = join(bin, "launchctl");
    writeFileSync(lc, `#!/bin/bash\n[ "$1" = "list" ] && printf '%s' ${JSON.stringify(opts.launchctlList)}\nexit 0\n`);
    chmodSync(lc, 0o755);
  }
  // crontab is stubbed rather than removed: the fallback legitimately registers an @reboot line,
  // and a test must never write into the developer's real crontab to prove it.
  const cron = join(bin, "crontab");
  writeFileSync(cron, "#!/bin/bash\ncat >/dev/null 2>&1 || true\nexit 0\n");
  chmodSync(cron, 0o755);

  // Run a COPY, inside a scratch clone. install.sh derives ROOT (and therefore the watch.ts path it
  // matches against `ps`) from its own location, and its fallback stops any process whose command
  // line ends in "…/bun <that watch.ts>". Executing the repository's own copy therefore matches —
  // and kills — the developer's real running daemon. The isolation has to include the script.
  const clone = join(scratch, "clone");
  mkdirSync(join(clone, "daemon"), { recursive: true });
  mkdirSync(join(clone, "src", "daemon"), { recursive: true });
  copyFileSync(join(ROOT, "daemon", "install.sh"), join(clone, "daemon", "install.sh"));
  writeFileSync(join(clone, "src", "daemon", "watch.ts"), "// never executed: bun is stubbed\n");

  const r = Bun.spawnSync(["/bin/bash", join(clone, "daemon", "install.sh")], {
    env: { HOME: home, PATH: `${bin}:${sysbin}`, LLMWIKI_STATE_DIR: state },
  });
  return { out: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? ""), code: r.exitCode };
}

describe.if(darwin)("macOS daemon install reports what launchd actually did", () => {
  test("claims success only when launchd holds the job", () => {
    const { out, code } = runInstall({ launchctl: true, launchctlList: "123\t0\tcom.llmwiki.daemon\n" });

    expect(out).toContain("installed + loaded launchd");
    expect(out).not.toContain("Falling back");
    expect(code).toBe(0);
  });

  test("a load that silently did not take falls back instead of claiming success", () => {
    // launchctl exits 0 for `load` and then does not list the label — the exact shape of the
    // silent failure, and the reason the old code's exit status could not be trusted.
    const { out, code } = runInstall({ launchctl: true, launchctlList: "" });

    expect(out).not.toContain("installed + loaded launchd");
    expect(out).toContain("did not accept");
    expect(out).toContain("started watch.ts in background");
    expect(code).toBe(0);
  });

  test("a missing launchctl is reported, not left to the shell's error", () => {
    const { out, code } = runInstall({ launchctl: false, launchctlList: "" });

    expect(out).toContain("launchctl not found");
    expect(out).not.toContain("installed + loaded launchd");
    expect(out).toContain("started watch.ts in background");
    expect(code).toBe(0);
  });
});
