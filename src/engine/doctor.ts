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
import { RETIRED_CODEX_SKILLS } from "./install-history.ts";
import { CLONE_ROOT } from "./paths.ts";
import { claudeConfigDirs, claudeRetentionDays } from "./sources/claude.ts";
import { EXPIRY_WARN_DAYS, healthReadOnly, pendingPastRetentionReadOnly } from "./capture.ts";
import { effectiveStateRoot, probeStateRoot } from "./state-dir.ts";
import { inspectEnrollment } from "./enrollment.ts";
import { liveEngineVersion, readUpdateCheck, updateAvailable } from "./update-check.ts";

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
  "src/engine/wiki-doctor.ts",
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
  "skill/wiki-doctor.md",
];
// slash commands that must be present in every profile's commands/ dir.
// Must stay in sync with wire.ts SKILLS and the repo's skill/ dir — tests/skills-drift.test.ts
// enforces all three (drift here is silent: wire installs a command doctor never checks, so its
// loss is invisible — the same success-looking-failure class as the CLI value-flag allowlist).
const COMMANDS = ["wiki-save.md", "wiki-ask.md", "wiki-deep.md", "wiki-quiz.md", "wiki-doctor.md"] as const;
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
// "wired to THIS clone" is matched on the bare script path, not the full command string:
// wire.ts registers the hook unquoted while repairHook writes it shellQuoted, and both
// spellings must pass — the path itself is the clone identity (the *_CMD forms above stay
// for what repairHook writes).
const SESSIONSTART_SCRIPT = `${CLONE_ROOT}/hooks/sessionstart-inject.sh`;
const TURNCTX_SCRIPT = `${CLONE_ROOT}/hooks/userpromptsubmit-inject.sh`;
const WIRE_CLAUDE_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire.ts"))}`;
const WIRE_CODEX_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-codex.ts"))}`;
const WIRE_OPENCODE_CMD = `bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-opencode.ts"))}`;
const CODEX_SKILLS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"] as const;
const CODEX_MANAGED = "llmwiki-codex-managed";
const OPENCODE_COMMANDS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"] as const;
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
  result.legacySkills = RETIRED_CODEX_SKILLS.filter((name) =>
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
/**
 * Re-add the read-injection hooks a live session silently dropped.
 *
 * The harness holds settings.json in memory and writes it back whole on any in-session change
 * (/model, a permission grant) — clobbering hooks added on disk after that session started,
 * including the ones setup.sh installed from INSIDE that very session. Observed twice in one day
 * on the author's machine; both times every check stayed green while the read loop was dead until
 * the next manual doctor run. The capture daemon is the one llmwiki process that outlives
 * sessions, so it re-asserts what the human installed.
 *
 * Conservative on purpose: only profiles that already exist (never create one), only when NO
 * llmwiki hook of that event survives in the file — a hook pointing at a DIFFERENT clone is a
 * conflict for doctor to report, never for a daemon to fight — and only through repairHook's
 * validated backup → parse → append → re-parse write.
 */
export function reassertClaudeReadHooks(): string[] {
  const notes: string[] = [];
  for (const dir of claudeConfigDirs()) {
    const sp = join(dir, "settings.json");
    if (!existsSync(sp)) continue;
    let raw: string;
    try {
      raw = readFileSync(sp, "utf-8");
    } catch {
      continue;
    }
    for (const [event, script, cmd] of [
      ["SessionStart", "hooks/sessionstart-inject.sh", SESSIONSTART_CMD],
      ["UserPromptSubmit", "hooks/userpromptsubmit-inject.sh", TURNCTX_CMD],
    ] as const) {
      if (raw.includes(script)) continue; // some clone's hook survives → not ours to touch
      notes.push(`${basename(dir)} ${event}: ${repairHook(sp, event, cmd)}`);
      try {
        raw = readFileSync(sp, "utf-8"); // repairHook rewrote the file; re-read before the next event
      } catch {
        break;
      }
    }
  }
  return notes;
}

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

function ageDays(utcText: string | null): number | null {
  if (!utcText) return null;
  // capture_queue.first_seen is sqlite's `datetime('now')` — UTC, space-separated.
  const ms = Date.parse(`${utcText.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? (Date.now() - ms) / 86_400_000 : null;
}

function humanAge(days: number): string {
  if (days < 1) return "today";
  if (days < 2) return "1 day ago";
  return `${Math.floor(days)} days ago`;
}

/**
 * Capture health — the half of this installation that fails SILENTLY.
 *
 * Every other check here asks "is the wiring present?", and wiring being present is exactly what
 * both field failures looked like while capture was dead: a router resolving 22 of 2,687 sessions,
 * and a state root the engine refused to adopt. Neither moved a single ✅ to ⚠️. These three lines
 * are the ones that would have.
 */
// Engine freshness — automatic CHECK, manual APPLY (see engine/update-check.ts). Print-only,
// contributes ZERO to the failure count: setup.sh propagates doctor failures, and "a newer
// version exists" is information, not a defect — it must never make an install read as broken.
export function reportEngineUpdate(): void {
  try {
    const rec = readUpdateCheck();
    if (rec === null) {
      console.log("  [update] • no check recorded yet — the daemon asks origin once a day");
      return;
    }
    const avail = updateAvailable();
    if (avail) {
      console.log(`  [update] ⚠️ v${avail.localVersion} → v${avail.remoteVersion} available — cd ${CLONE_ROOT} && git pull && ./setup.sh`);
      console.log("  [update]    (the engine never updates itself — applying is your act)");
    } else {
      const live = liveEngineVersion() ?? rec.localVersion;
      console.log(`  [update] ✅ engine v${live} — no newer version recorded (checked ${rec.checkedAt.slice(0, 10) || "?"})`);
    }
  } catch {
    /* freshness is informational — doctor must not fail over it */
  }
}

export function reportCaptureHealth(): number {
  let issues = 0;
  const root = effectiveStateRoot();
  const state = probeStateRoot(root);
  if (state.usable) {
    console.log(`  [capture] ✅ state root: ${root} (${state.detail})`);
  } else {
    console.log(`  [capture] ❌ state root unusable: ${root}`);
    console.log(`  [capture]    ${state.detail} — capture cannot write; nothing is being recorded`);
    issues += 1;
  }

  const health = healthReadOnly();
  if (health === null) {
    console.log("  [capture] • no capture history yet (queue not created)");
    return issues;
  }

  // Enrollment inventory, drawn only from repositories the queue already knows — no machine scan.
  const known = health.repos.filter((r) => existsSync(r));
  const enrolled: string[] = [];
  const dormant: string[] = []; // has a wiki, but automatic integration is off
  for (const repo of known) {
    if (inspectEnrollment(repo).enabled) enrolled.push(repo);
    else if (existsSync(join(repo, "docs", "wiki"))) dormant.push(repo);
  }
  const preview = (list: string[]): string =>
    `${list.slice(0, 5).join(" · ")}${list.length > 5 ? ` … (+${list.length - 5})` : ""}`;
  if (!known.length) {
    // The queue file exists from the first sweep onward, including sweeps that captured nothing —
    // so a fresh install answered "enrolled repositories: 0" while the adopter's `init` had just
    // printed "automatic integration enabled". Two lines of output, flatly contradicting each
    // other, at the exact moment the adopter is deciding whether this thing works. The inventory
    // is drawn from repositories the QUEUE has seen; when it has seen none, say that instead of
    // reporting a count that is not about enrollment at all.
    console.log(
      "  [capture] • no repository captured yet — enrolled repos are listed here after their first captured session",
    );
    console.log("  [capture]    (`llmwiki status <repo>` answers for one repository right now)");
  } else {
    console.log(`  [capture] ✅ enrolled repositories: ${enrolled.length}${enrolled.length ? ` — ${preview(enrolled)}` : ""}`);
  }
  if (dormant.length) {
    // The upgrade trap: a repository whose wiki you still use, silently inert because enrollment
    // arrived after it. Cold start prints nothing there BY DESIGN, so this is the only surface
    // that can say so.
    console.log(`  [capture] ⚠️ ${dormant.length} repositor(ies) hold a wiki but are not enrolled — \`llmwiki init <repo>\``);
    console.log(`  [capture]    ${preview(dormant)}`);
    issues += 1;
  }

  for (const k of health.byKind) {
    const days = ageDays(k.lastSeen);
    console.log(`  [capture] • ${k.kind}: ${k.rows} row(s), last ${days === null ? "unknown" : humanAge(days)}`);
  }

  // Claude Code deletes its own transcripts on `settings.cleanupPeriodDays` (default 30). That is
  // the real deadline on the backlog — the transcript is the evidence, so a pending session that
  // passes it is not late, it is gone. Read the number instead of assuming it.
  const retention = claudeRetentionDays();
  const backlog = pendingPastRetentionReadOnly(retention.days);
  const source = retention.configured ? "settings.cleanupPeriodDays" : "Claude Code default";
  if (backlog.atRisk > 0) {
    console.log(
      `  [capture] ⚠️ ${backlog.atRisk} pending Claude session(s) are older than the ${retention.days}-day transcript retention (${source}) — /wiki-deep files them if they are worth keeping`,
    );
    issues += 1;
  } else if (backlog.expiringSoon === 0) {
    console.log(`  [capture] ✅ no pending session past the ${retention.days}-day transcript retention (${source})`);
  }
  // Independent of the line above, not an alternative to it: "already overdue" and "overdue this
  // week" are different amounts of work with different deadlines, and the second is the only one
  // where the advice can still be taken.
  if (backlog.expiringSoon > 0) {
    console.log(
      `  [capture] ⚠️ ${backlog.expiringSoon} pending Claude session(s) lose their transcript within ${EXPIRY_WARN_DAYS} day(s) (${retention.days}-day retention, ${source}) — /wiki-deep if any is worth keeping`,
    );
    issues += 1;
  }
  // Deliberately NOT reported: rows whose transcript is already gone. The 2026-07-22 retention
  // decision keeps those as a silent ledger (device 2) — an un-filed session that expired is
  // usually one the human chose not to keep, so announcing it is a nag about a decision they
  // already made, and telling them to delete the row destroys the only record that it existed.
  const newest = ageDays(health.lastSeen);
  if (newest !== null && newest > 7) {
    console.log(
      `  [capture] ⚠️ nothing captured in ${Math.floor(newest)} days — check \`llmwiki status <repo>\` and the daemon log`,
    );
    issues += 1;
  }
  return issues;
}

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
    // What matters is whether capture is RUNNING, not which supervisor is holding it. macOS
    // without a usable launchd falls back to the same plain background process Linux uses, so the
    // check accepts that state too — reporting it honestly as degraded (it will not survive a
    // reboot) rather than as a failure, which would fail `setup.sh` over a working loop.
    const pgrep = tryRun(["pgrep", "-f", "daemon/watch.ts"]);
    const unsupervised = pgrep.ok && pgrep.code === 0;
    const r = existsSync(PLIST) ? tryRun(["launchctl", "list"]) : { ok: false, stdout: "", code: 1 };
    if (existsSync(PLIST)) console.log(`  [daemon] ✅ plist installed: ${PLIST}`);
    if (r.ok && r.stdout.includes(LABEL)) {
      console.log("  [daemon] ✅ loaded (launchctl)");
    } else if (unsupervised) {
      console.log(
        "  [daemon] ⚠️ running unsupervised (no launchd) — capture works now but will NOT survive a reboot; " +
          "re-run daemon/install.sh after each boot, or see daemon/README.md",
      );
    } else if (!existsSync(PLIST)) {
      console.log("  [daemon] ⚠️ not installed — capture loop inactive. Run setup.sh, or see daemon/README.md.");
      issues += 1;
    } else if (!r.ok) {
      console.log("  [daemon] ⚠️ launchctl check failed");
    } else if (fix) {
      tryRun(["launchctl", "load", PLIST]);
      console.log("  [daemon] 🔧 launchctl load attempted (re-run doctor to confirm)");
    } else {
      console.log("  [daemon] ⚠️ not loaded — `doctor --fix` (or launchctl load it)");
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

  reportEngineUpdate();
  issues += reportCaptureHealth();

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
    if (has && txt.includes(SESSIONSTART_SCRIPT)) {
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
    if (hasTurn && txt.includes(TURNCTX_SCRIPT)) {
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

  // Codex is a first-class setup target. The hook file, both lifecycle events, all skills,
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
