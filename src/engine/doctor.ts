// llmwiki doctor — engine + daemon + profile wiring health check.
// Behavior: CORE existence check,
// OS-aware daemon probe (launchctl on darwin, systemd --user / pgrep on linux),
// per-profile SessionStart hook + slash-command checks, and a --fix path that
// safely re-registers the SessionStart inject hook (timestamped backup → parse →
// append → re-parse validation → write).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";
import { claudeConfigDirs } from "./sources/claude.ts";

const HOME = process.env.HOME?.trim() || homedir();
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
  "src/daemon/wire-codex.ts",
  "src/daemon/wire-opencode.ts",
  "adapters/opencode/llmwiki.ts",
  "daemon/install.sh",
  "hooks/sessionstart-inject.sh",
  "hooks/userpromptsubmit-inject.sh",
  "setup.sh",
  "skill/wiki-save.md",
  "skill/wiki-ask.md",
  "skill/wiki-deep.md",
  "skill/wiki-quiz.md",
];
// slash commands that must be present in every profile's commands/ dir.
// Must stay in sync with wire.ts SKILLS and the repo's skill/ dir — tests/skills-drift.test.ts
// enforces all three (drift here is silent: wire installs a command doctor never checks, so its
// loss is invisible — the same success-looking-failure class as the CLI value-flag allowlist).
const COMMANDS = ["wiki-save.md", "wiki-ask.md", "wiki-deep.md", "wiki-quiz.md"] as const;
const PLIST = join(HOME, "Library", "LaunchAgents", "com.llmwiki.daemon.plist");
const LABEL = "com.llmwiki.daemon";
// canonical SessionStart read-injection hook — what --fix re-registers if a profile lost it
// (e.g. an OMC update regenerated settings.json). Presence keys on the hook script
// filename (survives any clone path/name — decision: path-agnostic setup), then the
// full command below distinguishes "wired to THIS clone" from "wired to another clone".
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const SESSIONSTART_CMD = `bash ${shellQuote(`${CLONE_ROOT}/hooks/sessionstart-inject.sh`)}`;
// per-turn read-injection hook — same self-heal contract as SessionStart
const TURNCTX_CMD = `bash ${shellQuote(`${CLONE_ROOT}/hooks/userpromptsubmit-inject.sh`)}`;
const WIRE_CLAUDE_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire.ts"))}`;
const WIRE_CODEX_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-codex.ts"))}`;
const WIRE_OPENCODE_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-opencode.ts"))}`;
const CODEX_SKILLS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;
// explicit install history (mirrors wire-codex.ts LEGACY_SKILLS) — deriving legacy names from
// the current ones breaks on every rename: it fabricates never-installed names and goes blind
// to the ones that actually exist on disk
const LEGACY_CODEX_SKILLS = ["llmwiki-fast", "llmwiki-ask", "llmwiki-deep", "llmwiki-quiz", "wiki-fast"];
const CODEX_MANAGED = "llmwiki-codex-managed";
const OPENCODE_COMMANDS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;
const OPENCODE_MANAGED = "llmwiki-opencode-managed";

export interface CodexInstallStatus {
  installed: boolean;
  hooksPath: string;
  hooksValid: boolean;
  sessionHook: boolean;
  turnHook: boolean;
  reviewRecords: boolean;
  missingSkills: string[];
  staleSkills: string[];
  legacySkills: string[];
  launcher: "missing" | "managed" | "foreign";
  launcherOnPath: boolean;
}

export interface OpenCodeInstallStatus {
  installed: boolean;
  plugin: "missing" | "current" | "stale" | "foreign";
  missingCommands: string[];
  staleCommands: string[];
  launcher: "missing" | "managed" | "foreign";
  launcherOnPath: boolean;
}

function commandLocation(
  hooks: Record<string, any[]> | undefined,
  event: string,
  expected: string,
): { group: number; hook: number } | null {
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return null;
  for (const [groupIndex, group] of groups.entries()) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const [hookIndex, hook] of handlers.entries()) {
      if (hook?.type === "command" && hook?.command === expected) return { group: groupIndex, hook: hookIndex };
    }
  }
  return null;
}

// Structural inspection only. Codex owns the current-hash verdict, so a matching config
// record is reported as "review record present", never as an authoritative trust claim.
// `/hooks` remains the source of truth for new/changed handlers.
export function inspectCodexInstall(
  codexHome: string,
  home: string = HOME,
  binDir: string = process.env.LLMWIKI_BIN_DIR?.trim() || join(home, ".local", "bin"),
): CodexInstallStatus {
  const hooksPath = join(codexHome, "hooks.json");
  const result: CodexInstallStatus = {
    installed: existsSync(codexHome),
    hooksPath,
    hooksValid: false,
    sessionHook: false,
    turnHook: false,
    reviewRecords: false,
    missingSkills: [],
    staleSkills: [],
    legacySkills: [],
    launcher: "missing",
    launcherOnPath: false,
  };
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
    result.hooksValid = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    parsed = null;
  }
  const session = commandLocation(parsed?.hooks, "SessionStart", SESSIONSTART_CMD);
  const turn = commandLocation(parsed?.hooks, "UserPromptSubmit", TURNCTX_CMD);
  result.sessionHook = session !== null;
  result.turnHook = turn !== null;
  if (session && turn) {
    try {
      const config = readFileSync(join(codexHome, "config.toml"), "utf8");
      const sessionKey = `[hooks.state."${hooksPath}:session_start:${session.group}:${session.hook}"]`;
      const turnKey = `[hooks.state."${hooksPath}:user_prompt_submit:${turn.group}:${turn.hook}"]`;
      result.reviewRecords = config.includes(sessionKey) && config.includes(turnKey);
    } catch {
      /* no review records yet */
    }
  }
  result.missingSkills = CODEX_SKILLS.filter(
    (name) => !existsSync(join(home, ".agents", "skills", name, "SKILL.md")),
  );
  result.staleSkills = CODEX_SKILLS.filter((name) => {
    const installed = join(home, ".agents", "skills", name, "SKILL.md");
    if (!existsSync(installed)) return false;
    const source = join(CLONE_ROOT, "skill", `${name}.md`);
    try {
      const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
      const owner = `${CODEX_MANAGED} root=${CLONE_ROOT} source_sha256=${hash}`;
      return !readFileSync(installed, "utf8").includes(owner);
    } catch {
      return true;
    }
  });
  result.legacySkills = LEGACY_CODEX_SKILLS.filter((name) =>
    existsSync(join(home, ".agents", "skills", name, "SKILL.md")),
  );
  const launcher = join(binDir, "llmwiki");
  try {
    const text = readFileSync(launcher, "utf8");
    result.launcher = text.includes("# llmwiki launcher") && text.includes(CLONE_ROOT) ? "managed" : "foreign";
  } catch {
    result.launcher = "missing";
  }
  result.launcherOnPath = (process.env.PATH ?? "").split(":").includes(dirname(launcher));
  return result;
}

export function inspectOpenCodeInstall(
  configRoot: string,
  home: string = HOME,
  binDir: string = process.env.LLMWIKI_BIN_DIR?.trim() || join(home, ".local", "bin"),
): OpenCodeInstallStatus {
  const opencodeRoot = join(configRoot, "opencode");
  const plugin = join(opencodeRoot, "plugin", "llmwiki.ts");
  const commandsRoot = join(opencodeRoot, "commands");
  const result: OpenCodeInstallStatus = {
    installed: false,
    plugin: "missing",
    missingCommands: [],
    staleCommands: [],
    launcher: "missing",
    launcherOnPath: false,
  };
  result.installed = Bun.which("opencode") !== null;
  try {
    const content = readFileSync(plugin, "utf8");
    if (!content.includes(OPENCODE_MANAGED)) {
      result.plugin = content.includes("llmwiki OpenCode plugin") ? "stale" : "foreign";
    } else {
      const source = join(CLONE_ROOT, "adapters", "opencode", "llmwiki.ts");
      const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
      const owner = `${OPENCODE_MANAGED} root=${CLONE_ROOT} source_sha256=${hash}`;
      result.plugin = content.includes(owner) ? "current" : "stale";
    }
  } catch {
    result.plugin = "missing";
  }
  result.missingCommands = OPENCODE_COMMANDS.filter(
    (name) => !existsSync(join(commandsRoot, `${name}.md`)),
  );
  result.staleCommands = OPENCODE_COMMANDS.filter((name) => {
    const installed = join(commandsRoot, `${name}.md`);
    if (!existsSync(installed)) return false;
    try {
      const source = join(CLONE_ROOT, "skill", `${name}.md`);
      const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
      const owner = `${OPENCODE_MANAGED} root=${CLONE_ROOT} source_sha256=${hash}`;
      return !readFileSync(installed, "utf8").includes(owner);
    } catch {
      return true;
    }
  });
  const launcher = join(binDir, "llmwiki");
  try {
    const content = readFileSync(launcher, "utf8");
    result.launcher = content.includes("# llmwiki launcher") && content.includes(CLONE_ROOT) ? "managed" : "foreign";
  } catch {
    result.launcher = "missing";
  }
  result.launcherOnPath = (process.env.PATH ?? "").split(":").includes(dirname(launcher));
  return result;
}

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

export type DoctorHarness = "all" | "codex" | "claude" | "opencode";

export function runDoctor(fix = false, harness: DoctorHarness = "all"): number {
  console.log(
    `=== llmwiki doctor (root=${CLONE_ROOT}, harness=${harness}${fix ? ", --fix" : ""}) ===`,
  );
  let issues = 0;
  let actions = 0;

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

  // SessionStart read-injection hooks across profiles. A Codex-only setup must not fail
  // because an independently managed Claude profile points at another llmwiki clone.
  const inspectClaude = harness === "claude" || (harness === "all" && Bun.which("claude") !== null);
  for (const prof of inspectClaude ? claudeProfiles() : []) {
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
        `  [${name}] ⚠️ SessionStart hook points to a different clone (re-point: ${WIRE_CLAUDE_CMD})`,
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
        `  [${name}] ⚠️ UserPromptSubmit hook points to a different clone (re-point: ${WIRE_CLAUDE_CMD})`,
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

  // Codex is a first-class setup target. The hook file, both lifecycle events, four skills,
  // and the launcher must all point at this clone. Hook trust itself is owned by Codex's
  // current-hash review UI; config records are only a conservative "review happened" signal.
  if (harness === "all" || harness === "codex") {
    try {
      const codexHome = process.env.CODEX_HOME?.trim() || join(HOME, ".codex");
      if (existsSync(codexHome)) {
        const status = inspectCodexInstall(codexHome, HOME);
        if (!status.hooksValid || !status.sessionHook || !status.turnHook) {
          const missing = [
            !status.sessionHook ? "SessionStart" : "",
            !status.turnHook ? "UserPromptSubmit" : "",
          ].filter(Boolean);
          console.log(
            `  [codex] ⚠️ hooks incomplete${missing.length ? ` (${missing.join(", ")})` : ""} — ` +
              `run \`${WIRE_CODEX_CMD}\``,
          );
          issues += 1;
        } else if (!status.reviewRecords) {
          console.log("  [codex] ⚠️ hooks installed; one-time review required — start Codex and open `/hooks`");
          actions += 1;
        } else {
          console.log("  [codex] ✅ hooks installed; review records present");
          console.log("  [codex] ⚠️ confirm the current hook hashes in `/hooks` after install or re-pointing");
          actions += 1;
        }

      if (status.missingSkills.length) {
          console.log(
            `  [codex] ⚠️ missing skill(s): ${status.missingSkills.map((name) => `$${name}`).join(", ")}`,
          );
          issues += 1;
        } else {
          console.log(`  [codex] ✅ skills present: ${CODEX_SKILLS.map((name) => `$${name}`).join(", ")}`);
        }
        if (status.staleSkills.length) {
          console.log(
            `  [codex] ⚠️ stale/wrong-clone skill(s): ${status.staleSkills.map((name) => `$${name}`).join(", ")} — ` +
              "re-run setup after moving or updating the clone",
          );
          issues += 1;
        }
        if (status.legacySkills.length) {
          console.log(
            `  [codex] ⚠️ legacy skill name(s): ${status.legacySkills.map((name) => `$${name}`).join(", ")} — ` +
              "re-run setup to migrate to the shorter `$wiki-*` names",
          );
          issues += 1;
        }

        if (status.launcher === "managed") {
          console.log(`  [codex] ✅ llmwiki command installed${status.launcherOnPath ? " + on PATH" : ""}`);
          if (!status.launcherOnPath) {
            const binDir = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
            console.log(`  [codex] ⚠️ ${binDir} is not on PATH`);
            console.log(`          export PATH=${shellQuote(binDir)}:"$PATH"`);
            actions += 1;
          }
        } else {
          console.log(
            status.launcher === "foreign"
              ? "  [codex] ⚠️ `llmwiki` launcher target is owned by another command"
              : `  [codex] ⚠️ llmwiki command missing — run \`${WIRE_CODEX_CMD}\``,
          );
          issues += 1;
        }
      } else if (harness === "codex") {
        console.log(`  [codex] ⚠️ CODEX_HOME not found: ${codexHome}`);
        issues += 1;
      }
    } catch {
      /* Codex inspection must never crash doctor; required missing surfaces are reported when inspectable. */
    }
  }

  // OpenCode is a first-class target when selected, and is auto-inspected under `all`
  // only when the CLI or an existing global config is present.
  if (harness === "all" || harness === "opencode") {
    const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(HOME, ".config");
    const opencodeRoot = join(configRoot, "opencode");
    const status = inspectOpenCodeInstall(configRoot, HOME);
    if (harness === "opencode" || status.installed || existsSync(opencodeRoot)) {
      if (!status.installed) {
        console.log("  [opencode] ⚠️ OpenCode CLI not found on PATH");
        issues += 1;
      }
      if (status.plugin === "current") {
        console.log("  [opencode] ✅ global read-injection plugin points to this clone");
      } else {
        const reason = status.plugin === "foreign" ? "target is unrelated" : status.plugin;
        console.log(`  [opencode] ⚠️ plugin ${reason} — run \`${WIRE_OPENCODE_CMD}\``);
        issues += 1;
      }
      if (status.missingCommands.length) {
        console.log(
          `  [opencode] ⚠️ missing command(s): ${status.missingCommands.map((name) => `/${name}`).join(", ")}`,
        );
        issues += 1;
      } else {
        console.log(`  [opencode] ✅ commands present: ${OPENCODE_COMMANDS.map((name) => `/${name}`).join(", ")}`);
      }
      if (status.staleCommands.length) {
        console.log(
          `  [opencode] ⚠️ stale/wrong-clone command(s): ${status.staleCommands.map((name) => `/${name}`).join(", ")} — ` +
            "re-run setup after moving or updating the clone",
        );
        issues += 1;
      }
      if (status.launcher === "managed") {
        console.log(`  [opencode] ✅ llmwiki command installed${status.launcherOnPath ? " + on PATH" : ""}`);
        if (!status.launcherOnPath) {
          const binDir = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
          console.log(`  [opencode] ⚠️ ${binDir} is not on PATH`);
          console.log(`             export PATH=${shellQuote(binDir)}:"$PATH"`);
          actions += 1;
        }
      } else {
        console.log(
          status.launcher === "foreign"
            ? "  [opencode] ⚠️ `llmwiki` launcher target is owned by another command"
            : `  [opencode] ⚠️ llmwiki command missing — run \`${WIRE_OPENCODE_CMD}\``,
        );
        issues += 1;
      }
    }
  }

  console.log("=== summary ===");
  if (issues === 0) {
    console.log(actions ? `  ✅ installed; ${actions} user action(s) required above.` : "  ✅ healthy.");
    return 0;
  }
  console.log(`  ⚠️ ${issues} issue(s). See above.`);
  return 1;
}
