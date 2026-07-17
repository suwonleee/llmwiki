// llmwiki doctor — engine + daemon + profile wiring health check.
// Behavior: CORE existence check,
// OS-aware daemon probe (launchctl on darwin, systemd --user / pgrep on linux),
// per-profile SessionStart hook + slash-command checks, and a --fix path that
// safely re-registers the SessionStart inject hook (timestamped backup → parse →
// append → re-parse validation → write).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { claudeConfigDirs } from "./sources/claude.ts";

const HOME = homedir();
const CORE = [
  "src/engine/db.ts",
  "src/engine/lint.ts",
  "src/engine/chunker.ts",
  "src/engine/refs.ts",
  "src/engine/extract.ts",
  "src/engine/update.ts",
  "src/engine/schema.sql",
  "src/engine/capture.ts",
  "src/engine/autoupdate.ts",
  "src/engine/review.ts",
  "src/engine/doctor.ts",
  "src/engine/claude.ts",
  "src/cli.ts",
  "src/daemon/watch.ts",
  "src/daemon/wire.ts",
  "daemon/install.sh",
  "hooks/sessionstart-inject.sh",
  "hooks/userpromptsubmit-inject.sh",
  "setup.sh",
  "skill/wiki-fast.md",
  "skill/wiki-ask.md",
  "skill/wiki-deep.md",
];
// slash commands that must be present in every profile's commands/ dir
const COMMANDS = ["wiki-fast.md", "wiki-ask.md", "wiki-deep.md"] as const;
const PLIST = join(HOME, "Library", "LaunchAgents", "com.llmwiki.daemon.plist");
const LABEL = "com.llmwiki.daemon";
// canonical SessionStart read-injection hook — what --fix re-registers if a profile lost it
// (e.g. an OMC update regenerated settings.json). Presence keys on the hook script
// filename (survives any clone path/name — decision: path-agnostic setup), then the
// full command below distinguishes "wired to THIS clone" from "wired to another clone".
const SESSIONSTART_CMD = `bash ${CLONE_ROOT}/hooks/sessionstart-inject.sh`;
// per-turn read-injection hook — same self-heal contract as SessionStart
const TURNCTX_CMD = `bash ${CLONE_ROOT}/hooks/userpromptsubmit-inject.sh`;

// timestamp like Python's datetime.now():%Y%m%d-%H%M%S
function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function tryRun(cmd: string[], timeoutMs = 5000): { code: number | null; stdout: string; stderr: string; ok: boolean } {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return {
      code: r.exitCode,
      stdout: r.stdout ? new TextDecoder().decode(r.stdout) : "",
      stderr: r.stderr ? new TextDecoder().decode(r.stderr) : "",
      ok: true,
    };
  } catch {
    return { code: null, stdout: "", stderr: "", ok: false };
  }
}

// Re-add a read-injection hook (SessionStart or UserPromptSubmit) to an existing
// settings.json. Safe: backup → parse → append (preserving OMC/other hooks) →
// JSON-validate → write.
function repairHook(sp: string, event = "SessionStart", cmd = SESSIONSTART_CMD): string {
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(sp, "utf-8"));
  } catch (e) {
    return `🔴 parse failed (${e}) — manual fix needed`;
  }
  const bak = `${sp}.bak.${ts()}`;
  copyFileSync(sp, bak);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks[event]) settings.hooks[event] = [];
  settings.hooks[event].push({
    matcher: "",
    hooks: [{ type: "command", command: cmd }],
  });
  let text: string;
  try {
    text = JSON.stringify(settings, null, 2) + "\n";
    JSON.parse(text); // re-parse validation before writing
  } catch (e) {
    return `🔴 serialize-validate failed (${e}) — original kept`;
  }
  writeFileSync(sp, text, "utf-8");
  return `🔧 re-registered (backup: ${basename(bak)})`;
}

// ~/.claude* directories plus $CLAUDE_CONFIG_DIR (shared discovery — sources/claude.ts)
function claudeProfiles(): string[] {
  return claudeConfigDirs();
}

export function runDoctor(fix = false): number {
  console.log(`=== llmwiki doctor (root=${CLONE_ROOT}${fix ? ", --fix" : ""}) ===`);
  let issues = 0;

  for (const rel of CORE) {
    const ok = existsSync(join(CLONE_ROOT, rel));
    issues += ok ? 0 : 1;
    console.log(`  [core] ${ok ? "✅" : "❌"} ${rel}`);
  }

  // daemon installed? (OS-aware: macOS launchd / Linux systemd / cron·nohup)
  if (process.platform === "darwin") {
    if (existsSync(PLIST)) {
      console.log(`  [daemon] ✅ plist installed: ${PLIST}`);
      const r = tryRun(["launchctl", "list"]);
      if (!r.ok) {
        console.log(`  [daemon] ⚠️ launchctl check failed`);
      } else {
        const running = r.stdout.includes(LABEL);
        if (running) {
          console.log("  [daemon] ✅ loaded (launchctl)");
        } else if (fix) {
          tryRun(["launchctl", "load", PLIST]);
          console.log("  [daemon] 🔧 launchctl load attempted (re-run doctor to confirm)");
        } else {
          console.log("  [daemon] ⚠️ not loaded — `doctor --fix` (or launchctl load it)");
          issues += 1;
        }
      }
    } else {
      console.log("  [daemon] ⚠️ not installed — capture loop inactive. Run setup.sh, or see daemon/README.md.");
      issues += 1;
    }
  } else {
    // Linux: prefer a systemd --user unit; else accept a running watch.ts (cron/nohup fallback)
    const unit = join(HOME, ".config", "systemd", "user", "llmwiki-daemon.service");
    const pgrep = tryRun(["pgrep", "-f", "daemon/watch.ts"]);
    const watchRunning = pgrep.ok && pgrep.code === 0;
    if (existsSync(unit)) {
      const sc = tryRun(["systemctl", "--user", "is-active", "--quiet", "llmwiki-daemon.service"]);
      const active = sc.ok ? sc.code === 0 : watchRunning;
      if (active) {
        console.log(`  [daemon] ✅ systemd --user active: ${unit}`);
      } else {
        console.log(
          `  [daemon] ⚠️ systemd unit installed but inactive — \`systemctl --user start llmwiki-daemon.service\``,
        );
        issues += 1;
      }
    } else if (watchRunning) {
      console.log("  [daemon] ✅ watch.ts running (cron/nohup fallback)");
    } else {
      console.log("  [daemon] ⚠️ not installed — capture loop inactive. Run setup.sh, or see daemon/README.md.");
      issues += 1;
    }
  }

  // SessionStart read-injection hooks across profiles
  for (const prof of claudeProfiles()) {
    const sp = join(prof, "settings.json");
    const name = basename(prof);
    if (!existsSync(sp)) continue;
    let txt: string;
    try {
      txt = readFileSync(sp, "utf-8");
    } catch {
      txt = "";
    }
    // key on the stable hook script filename, not the substring "llmwiki" — so the
    // check holds regardless of the clone's name/path (decision: path-agnostic setup).
    const has = txt.includes("sessionstart-inject.sh") && txt.includes("SessionStart");
    if (has && txt.includes(SESSIONSTART_CMD)) {
      console.log(`  [${name}] ✅ read-injection hook present`);
    } else if (has) {
      // script name found but pointing at a different clone — repairHook would only
      // append a duplicate; wire.ts strip-then-add is the correct re-point path.
      console.log(
        `  [${name}] ⚠️ SessionStart hook points to a different clone (re-point: bun ${CLONE_ROOT}/src/daemon/wire.ts)`,
      );
      issues += 1;
    } else if (fix) {
      console.log(`  [${name}] ⚠️ no llmwiki SessionStart hook → ${repairHook(sp)}`);
    } else {
      console.log(`  [${name}] ⚠️ no llmwiki SessionStart hook (run \`doctor --fix\` to re-register)`);
      issues += 1;
    }

    // per-turn read-injection hook — same presence key + self-heal
    const hasTurn = txt.includes("userpromptsubmit-inject.sh") && txt.includes("UserPromptSubmit");
    if (hasTurn && txt.includes(TURNCTX_CMD)) {
      console.log(`  [${name}] ✅ turn-context hook present`);
    } else if (hasTurn) {
      console.log(
        `  [${name}] ⚠️ UserPromptSubmit hook points to a different clone (re-point: bun ${CLONE_ROOT}/src/daemon/wire.ts)`,
      );
      issues += 1;
    } else if (fix) {
      console.log(
        `  [${name}] ⚠️ no llmwiki UserPromptSubmit hook → ${repairHook(sp, "UserPromptSubmit", TURNCTX_CMD)}`,
      );
    } else {
      console.log(`  [${name}] ⚠️ no llmwiki UserPromptSubmit hook (run \`doctor --fix\` to re-register)`);
      issues += 1;
    }

    // slash commands present in this profile? (commands/ files survive OMC settings.json regen)
    const missing = COMMANDS.filter((c) => !existsSync(join(prof, "commands", c)));
    const slashList = (cs: readonly string[]) => cs.map((c) => "/" + c.slice(0, -3)).join(", ");
    if (missing.length === 0) {
      console.log(`  [${name}] ✅ commands present: ${slashList(COMMANDS)}`);
    } else if (fix) {
      mkdirSync(join(prof, "commands"), { recursive: true });
      for (const c of missing) {
        copyFileSync(join(CLONE_ROOT, "skill", c), join(prof, "commands", c));
      }
      console.log(`  [${name}] 🔧 installed missing command(s): ${slashList(missing)}`);
    } else {
      console.log(`  [${name}] ⚠️ missing command(s): ${slashList(missing)} (run \`doctor --fix\`)`);
      issues += 1;
    }
  }

  // Other harnesses (advisory — read-injection is a progressive enhancement there, never a
  // baseline, so nothing here increments `issues`; machines without the harness stay silent).
  // Wiring recipes live in adapters/codex and adapters/opencode.
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    if (existsSync(codexHome)) {
      const hooksJson = join(codexHome, "hooks.json");
      let hj = "";
      try {
        hj = readFileSync(hooksJson, "utf-8");
      } catch {
        /* not wired */
      }
      if (hj.includes("sessionstart-inject.sh")) {
        let trusted = false;
        try {
          trusted = readFileSync(join(codexHome, "config.toml"), "utf-8").includes("[hooks.state.");
        } catch {
          /* no config */
        }
        console.log(
          trusted
            ? "  [codex] ✅ read-injection hooks wired + trusted"
            : "  [codex] ⚠️ hooks wired but NOT trusted — run interactive `codex` once and accept the hooks review (advisory)",
        );
      } else {
        console.log("  [codex] ℹ️ installed, hooks not wired — see adapters/codex (advisory)");
      }
    }
    const ocPlugin = join(homedir(), ".config", "opencode", "plugin", "llmwiki.ts");
    const ocData =
      (process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")) + "/opencode";
    if (existsSync(ocData)) {
      console.log(
        existsSync(ocPlugin)
          ? "  [opencode] ✅ llmwiki plugin installed (global)"
          : "  [opencode] ℹ️ installed, plugin not wired — see adapters/opencode (advisory)",
      );
    }
  } catch {
    /* advisory section must never break doctor */
  }

  console.log("=== summary ===");
  if (issues === 0) {
    console.log("  ✅ healthy.");
    return 0;
  }
  console.log(`  ⚠️ ${issues} issue(s). See above.`);
  return 1;
}
