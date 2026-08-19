#!/usr/bin/env bun
// First-class Codex wiring for a path-independent llmwiki clone.
//
//   bun wire-codex.ts             merge hooks + install skills + user CLI
//   bun wire-codex.ts --dry-run   print the exact targets, write nothing
//   bun wire-codex.ts --revert    remove only llmwiki-managed entries
//
// Existing hook groups are preserved. Re-running strips stale llmwiki handlers first,
// so moving the clone re-points the commands without creating duplicates.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { insertAfterFrontmatter } from "../engine/frontmatter.ts";
import { RETIRED_CODEX_SKILLS } from "../engine/install-history.ts";
import { CLONE_ROOT, CLONE_ROOT_SHELL, ENGINE_CLI_TOKEN, engineCliCommand, hookCliCommand } from "../engine/paths.ts";
import { envValueOutsideRepoFiles } from "../engine/env-policy.ts";
import { FRONTMATTER_GATE, SKILL_POLICY_REL, skillPolicyYaml } from "../engine/skill-policy.ts";

const HOME = process.env.HOME?.trim() || homedir();
const CODEX_HOME = envValueOutsideRepoFiles("CODEX_HOME")?.trim() || join(HOME, ".codex");
const HOOKS_PATH = join(CODEX_HOME, "hooks.json");
const SKILLS_ROOT = join(HOME, ".agents", "skills");
const BIN_DIR = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
const LAUNCHER = join(BIN_DIR, "llmwiki");
// How a generated skill body is told to call the engine.
//
// POSIX installs get the short `llmwiki` this wiring drops in ~/.local/bin. A native Windows
// install must NOT: that launcher is a `#!/bin/sh` script, so Git Bash runs it while PowerShell
// and cmd.exe cannot — and Codex and OpenCode both hand the agent's shell commands to PowerShell
// there. Every `llmwiki …` line in a skill was therefore dead on arrival, and it presented exactly
// that way: the skill loaded, ran its first command, and got CommandNotFoundException. The
// explicit interpreter spelling is what the Claude wiring has always emitted; it needs no PATH
// entry and works in every shell on every platform.
const CLI_INVOCATION = process.platform === "win32" ? engineCliCommand() : "llmwiki";
const MANAGED = "llmwiki-codex-managed";
const OWNER_MARK = `${MANAGED} root=${CLONE_ROOT}`;
const LAUNCHER_MARK = "# llmwiki launcher (llmwiki-managed)";
const LEGACY_LAUNCHER_MARK = `# llmwiki launcher (${MANAGED})`;
const BACKUP_ID = createHash("sha256").update(CLONE_ROOT).digest("hex").slice(0, 16);
const INSTALL_BACKUP = join(CODEX_HOME, `llmwiki-install-backup.${BACKUP_ID}.json`);
const SESSION_MARK = "hooks/sessionstart-inject.sh";
const TURN_MARK = "hooks/userpromptsubmit-inject.sh";
// CLONE_ROOT_SHELL, matching wire.ts and doctor.ts: these are bash commands stored in JSON
// (hooks.json), and doctor recognizes an install by comparing this exact string. One spelling
// across all three harnesses is what keeps that comparison from depending on the OS (paths.ts).
// Windows does not go through the shell adapters at all.
//
// `bash` is never on the Windows PATH (Git's installer adds <root>\cmd, not <root>\bin), and Codex
// runs a hook command through PowerShell — where the bare name does not resolve AND a quoted
// absolute path is not a command either. Both spellings were measured against a live Codex: both
// produced "hook exited with code 1", which is all Codex says, so cold-start and turn-context were
// simply dead on native Windows with nothing in any log to say why.
//
// `bun` IS on PATH (it is how the engine runs at all), takes a double-quoted argument that
// PowerShell, cmd.exe and bash all parse the same way, and needs no interpreter in front of it. The
// repo argument is omitted deliberately: in hook mode the engine already prefers the harness's own
// cwd over the positional, and CLAUDE_PROJECT_DIR — the only reason the adapter passes one — does
// not exist under Codex. Verified end to end: hooks report Completed and the wiki block arrives.
const CLI_SHELL = engineCliCommand();
const HOOK_CLI_SHELL = hookCliCommand();
const SESSION_CMD =
  process.platform === "win32"
    ? `${CLI_SHELL} context --hook-event SessionStart`
    : `bash ${shellQuote(`${CLONE_ROOT_SHELL}/${SESSION_MARK}`)}`;
const TURN_CMD =
  process.platform === "win32"
    ? `${HOOK_CLI_SHELL} turn-context-hook`
    : `bash ${shellQuote(`${CLONE_ROOT_SHELL}/${TURN_MARK}`)}`;
const SKILLS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"] as const;
// The invocation gate itself lives in engine/skill-policy.ts — one rule, both install surfaces.

/**
 * Is this handler one llmwiki owns?
 *
 * Both spellings count: the adapter script path (POSIX, and every install written before the
 * Windows branch existed) and the direct CLI invocation this clone emits on Windows. Matching only
 * the current platform's spelling would leave the other one behind on re-run — one dead hook plus
 * one live duplicate, which is worse than either alone. Clone-agnostic on purpose, exactly as the
 * script-path match has always been: re-pointing a machine at a new clone is the whole reason this
 * strips before it writes.
 */
function isManagedHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (command.includes(SESSION_MARK) || command.includes(TURN_MARK)) return true;
  return (
    (command.includes("/src/cli.ts") && command.includes("--hook-event")) ||
    (command.includes("/src/hook-cli.ts") && command.includes("turn-context-hook"))
  );
}

interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}
interface HooksFile {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface InstallBackup {
  version: 1;
  targetRoot: string;
  hooks: Record<string, HookGroup[]>;
  skills: Record<string, string>;
  launcher: { content: string; mode: number } | null;
}

function isManagedLauncher(content: string): boolean {
  return content.includes(LAUNCHER_MARK) || content.includes(LEGACY_LAUNCHER_MARK);
}

function usage(): string {
  return `Usage: bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-codex.ts"))} [--dry-run|--revert]\n`;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readHooks(): HooksFile {
  if (!existsSync(HOOKS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(HOOKS_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top level must be an object");
    if (parsed.hooks !== undefined) {
      if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) {
        throw new Error("hooks must be an object");
      }
      for (const [event, groups] of Object.entries(parsed.hooks)) {
        if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
        for (const [index, group] of groups.entries()) {
          if (!group || typeof group !== "object" || !Array.isArray((group as HookGroup).hooks)) {
            throw new Error(`hooks.${event}[${index}].hooks must be an array`);
          }
        }
      }
    }
    return parsed as HooksFile;
  } catch (error) {
    throw new Error(`cannot parse ${HOOKS_PATH}: ${error}`);
  }
}

function stripManagedHooks(file: HooksFile): number {
  let removed = 0;
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const groups = file.hooks?.[event] ?? [];
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const hooks = (group.hooks ?? []).filter((hook) => {
        const managed =
          isManagedHookCommand(hook.command);
        if (managed) removed += 1;
        return !managed;
      });
      if (hooks.length) kept.push({ ...group, hooks });
    }
    if (file.hooks && event in file.hooks) file.hooks[event] = kept;
  }
  return removed;
}

function stripCurrentHooks(file: HooksFile): number {
  let removed = 0;
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const groups = file.hooks?.[event] ?? [];
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const hooks = (group.hooks ?? []).filter((hook) => {
        const owned = hook.command === SESSION_CMD || hook.command === TURN_CMD;
        if (owned) removed += 1;
        return !owned;
      });
      if (hooks.length) kept.push({ ...group, hooks });
    }
    if (file.hooks && event in file.hooks) {
      if (kept.length) file.hooks[event] = kept;
      else delete file.hooks[event];
    }
  }
  if (file.hooks && Object.keys(file.hooks).length === 0) delete file.hooks;
  if (file.description === "llmwiki lifecycle hooks for Codex") delete file.description;
  return removed;
}

function managedHookSnapshot(file: HooksFile): Record<string, HookGroup[]> {
  const snapshot: Record<string, HookGroup[]> = {};
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const groups = file.hooks?.[event] ?? [];
    const managed = groups.flatMap((group) => {
      const hooks = (group.hooks ?? []).filter((hook) => isManagedHookCommand(hook.command));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (managed.length) snapshot[event] = managed;
  }
  return snapshot;
}

function capturePriorInstall(hooks: HooksFile): InstallBackup | null {
  const hookSnapshot = managedHookSnapshot(hooks);
  const skills: Record<string, string> = {};
  let currentOwned = Object.values(hookSnapshot)
    .flatMap((groups) => groups)
    .flatMap((group) => group.hooks ?? [])
    .some((hook) => hook.command === SESSION_CMD || hook.command === TURN_CMD);
  for (const name of [...SKILLS, ...RETIRED_CODEX_SKILLS]) {
    const file = join(SKILLS_ROOT, name, "SKILL.md");
    try {
      const content = readFileSync(file, "utf8");
      if (content.includes(MANAGED)) skills[name] = content;
      if (content.includes(OWNER_MARK)) currentOwned = true;
    } catch {
      /* absent */
    }
  }
  let launcher: InstallBackup["launcher"] = null;
  try {
    const content = readFileSync(LAUNCHER, "utf8");
    if (isManagedLauncher(content)) {
      launcher = { content, mode: statSync(LAUNCHER).mode & 0o777 };
      if (content.includes(CLONE_ROOT)) currentOwned = true; // shared launcher from this clone's OpenCode wiring
    }
  } catch {
    /* absent */
  }
  const hasPrior = Object.keys(hookSnapshot).length > 0 || Object.keys(skills).length > 0 || launcher !== null;
  if (!hasPrior || currentOwned) return null;
  return { version: 1, targetRoot: CLONE_ROOT, hooks: hookSnapshot, skills, launcher };
}

function restorePriorInstall(hooks: HooksFile): boolean {
  if (!existsSync(INSTALL_BACKUP)) return false;
  const backup = JSON.parse(readFileSync(INSTALL_BACKUP, "utf8")) as InstallBackup;
  if (backup.version !== 1 || backup.targetRoot !== CLONE_ROOT) {
    throw new Error(`invalid install backup: ${INSTALL_BACKUP}`);
  }
  hooks.hooks ??= {};
  for (const [event, groups] of Object.entries(backup.hooks)) {
    hooks.hooks[event] ??= [];
    hooks.hooks[event].push(...groups);
  }
  writeJsonAtomic(HOOKS_PATH, hooks);
  for (const [name, content] of Object.entries(backup.skills)) {
    const file = join(SKILLS_ROOT, name, "SKILL.md");
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  if (backup.launcher && !existsSync(LAUNCHER)) {
    mkdirSync(dirname(LAUNCHER), { recursive: true });
    writeFileSync(LAUNCHER, backup.launcher.content, "utf8");
    chmodSync(LAUNCHER, backup.launcher.mode);
  }
  rmSync(INSTALL_BACKUP, { force: true });
  return true;
}

function addHooks(file: HooksFile): void {
  file.description ??= "llmwiki lifecycle hooks for Codex";
  file.hooks ??= {};
  file.hooks.SessionStart ??= [];
  file.hooks.UserPromptSubmit ??= [];
  file.hooks.SessionStart.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: SESSION_CMD,
        timeout: 20,
        statusMessage: "llmwiki cold-start context",
        // Codex spills hook stdout above ~2,500 approx tokens (bytes/4 → 10,000 bytes) to a tmp
        // file and injects only a head/tail preview (codex-rs output_spill.rs). A healthy wiki's
        // cold start crosses that quietly — the engine already owns its context budget, so spilling
        // is disabled here. 0 = "no spill" since 0.145.0 (#34393); older parsers ignore the
        // unknown field (handler variants never had deny_unknown_fields) and keep the default.
        additionalContextLimit: 0,
      },
    ],
  });
  file.hooks.UserPromptSubmit.push({
    matcher: "",
    hooks: [{ type: "command", command: TURN_CMD, timeout: 10, statusMessage: "llmwiki turn-context" }],
  });
}

function writeJsonAtomic(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(text);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  if (existsSync(path)) copyFileSync(path, `${path}.llmwiki-bak.${timestamp()}`);
  const tmp = `${path}.llmwiki-tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
  return true;
}

function codexSkill(sourceName: (typeof SKILLS)[number]): string {
  const name = sourceName;
  let body = readFileSync(join(CLONE_ROOT, "skill", `${sourceName}.md`), "utf8");
  body = body.replace(/^---(\r?\n)/, `---$1name: ${name}$1${FRONTMATTER_GATE}$1`);
  body = body
    .replaceAll("Read `~/llmwiki/skill/wiki-save.md`", "invoke `$wiki-save` before continuing")
    .replaceAll(ENGINE_CLI_TOKEN, CLI_INVOCATION)
    .replace(/^\$ARGUMENTS$/gm, "Use any text supplied with this skill invocation as arguments and task context.")
    .replaceAll("$CLAUDE_PROJECT_DIR", "$PWD")
    .replaceAll("~/llmwiki", CLONE_ROOT)
    .replaceAll("$HOME/llmwiki", CLONE_ROOT);
  for (const skill of SKILLS) {
    body = body.replace(new RegExp(`(?<![A-Za-z0-9_.-])/${skill}\\b`, "g"), `$${skill}`);
  }
  const marker =
    `\n<!-- ${OWNER_MARK} source_sha256=${skillSourceHash(sourceName)} -->\n` +
    "> Codex: treat the current working directory (`$PWD`) as the target repository. " +
    `Use \`${CLI_INVOCATION}\`; do not assume Claude-specific environment variables.\n`;
  return insertAfterFrontmatter(body, marker);
}

function codexSkillPolicy(sourceName: (typeof SKILLS)[number]): string {
  const source = readFileSync(join(CLONE_ROOT, "skill", `${sourceName}.md`), "utf8");
  return skillPolicyYaml(source, sourceName, OWNER_MARK);
}

function skillSourceHash(sourceName: (typeof SKILLS)[number]): string {
  return createHash("sha256")
    .update(readFileSync(join(CLONE_ROOT, "skill", `${sourceName}.md`)))
    .digest("hex");
}

function launcherBody(): string {
  return (
    "#!/bin/sh\n" +
    `${LAUNCHER_MARK}\n` +
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(CLONE_ROOT, "src", "cli.ts"))} "$@"\n`
  );
}

function skillConflicts(): string[] {
  return SKILLS.flatMap((sourceName) => {
    const file = join(SKILLS_ROOT, sourceName, "SKILL.md");
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, "utf8").includes(MANAGED) ? [] : [file];
    } catch {
      return [file];
    }
  });
}

function removeManagedSkill(name: string, currentCloneOnly = false): boolean {
  const dir = join(SKILLS_ROOT, name);
  const file = join(dir, "SKILL.md");
  try {
    const content = readFileSync(file, "utf8");
    if (!content.includes(currentCloneOnly ? OWNER_MARK : MANAGED)) return false;
    rmSync(file, { force: true });
    // Same ownership test as SKILL.md: a hand-written policy file is left alone.
    const policy = join(dir, SKILL_POLICY_REL);
    try {
      if (readFileSync(policy, "utf8").includes(currentCloneOnly ? OWNER_MARK : MANAGED)) {
        rmSync(policy, { force: true });
        rmdirSync(dirname(policy));
      }
    } catch {
      /* absent, foreign, or the agents/ directory still holds other files */
    }
    try {
      rmdirSync(dir);
    } catch {
      /* preserve user-added references/scripts in the formerly managed skill directory */
    }
    return true;
  } catch {
    return false;
  }
}

function launcherConflict(): boolean {
  if (!existsSync(LAUNCHER)) return false;
  try {
    return !isManagedLauncher(readFileSync(LAUNCHER, "utf8"));
  } catch {
    return true;
  }
}

function openCodeUsesCurrentClone(): boolean {
  const configRoot = envValueOutsideRepoFiles("XDG_CONFIG_HOME")?.trim() || join(HOME, ".config");
  try {
    const plugin = readFileSync(join(configRoot, "opencode", "plugin", "llmwiki.ts"), "utf8");
    return plugin.includes("llmwiki-opencode-managed") && plugin.includes(`root=${CLONE_ROOT}`);
  } catch {
    return false;
  }
}

function apply(dryRun: boolean): number {
  if (launcherConflict()) {
    console.error(`  [codex] ❌ refusing to overwrite unrelated command: ${LAUNCHER}`);
    return 1;
  }
  const conflicts = skillConflicts();
  if (conflicts.length) {
    console.error("  [codex] ❌ refusing to overwrite unrelated skill file(s):");
    for (const file of conflicts) console.error(`          ${file}`);
    return 1;
  }
  const hooks = readHooks();
  const prior = capturePriorInstall(hooks);
  const repointed = stripManagedHooks(hooks);
  addHooks(hooks);

  if (dryRun) {
    console.log("=== llmwiki Codex wiring [DRY-RUN] ===");
    console.log(`  hooks : merge ${HOOKS_PATH} (preserve unrelated entries; re-point ${repointed})`);
    console.log(`  skills: ${SKILLS.map((skill) => join(SKILLS_ROOT, skill, "SKILL.md")).join(", ")}`);
    console.log(`  policy: ${SKILLS.map((skill) => join(SKILLS_ROOT, skill, SKILL_POLICY_REL)).join(", ")}`);
    if (RETIRED_CODEX_SKILLS.some((name) => existsSync(join(SKILLS_ROOT, name, "SKILL.md")))) {
      console.log(
        `  migrate: remove managed retired skill names (${RETIRED_CODEX_SKILLS.map((name) => `$${name}`).join(", ")})`,
      );
    }
    console.log(`  CLI   : ${LAUNCHER}`);
    if (prior) console.log(`  backup: preserve the previous llmwiki install for --revert (${INSTALL_BACKUP})`);
    return 0;
  }

  if (prior) writeJsonAtomic(INSTALL_BACKUP, prior);
  const hooksChanged = writeJsonAtomic(HOOKS_PATH, hooks);
  for (const name of [...SKILLS, ...RETIRED_CODEX_SKILLS]) removeManagedSkill(name);
  for (const sourceName of SKILLS) {
    const dir = join(SKILLS_ROOT, sourceName);
    mkdirSync(join(dir, dirname(SKILL_POLICY_REL)), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), codexSkill(sourceName), "utf8");
    writeFileSync(join(dir, SKILL_POLICY_REL), codexSkillPolicy(sourceName), "utf8");
  }
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(LAUNCHER, launcherBody(), "utf8");
  chmodSync(LAUNCHER, 0o755);

  console.log(
    `  [codex] ✅ hooks ${hooksChanged ? "merged" : "already current"}: ${HOOKS_PATH} (re-pointed ${repointed})`,
  );
  console.log(`  [codex] ✅ skills installed: ${SKILLS.map((skill) => `$${skill}`).join(", ")}`);
  console.log(`  [codex] ✅ CLI installed: ${LAUNCHER}`);
  console.log("  [codex] ACTION REQUIRED: start Codex, open `/hooks`, and trust the two llmwiki hooks once.");
  if (process.platform === "win32") {
    // The bare command is a convenience here, never a dependency: the skills carry the explicit
    // interpreter spelling, so say what this launcher is instead of prescribing a PATH edit that
    // only helps in one of the three shells a Windows user has open.
    console.log(`  [codex] • \`llmwiki\` is a /bin/sh launcher — Git Bash only (add ${BIN_DIR} to its PATH to use it)`);
    console.log(`  [codex]    the installed skills call \`${CLI_INVOCATION}\`, which needs no PATH entry`);
  } else if (!(process.env.PATH ?? "").split(delimiter).includes(BIN_DIR)) {
    console.log(`  [codex] ⚠️ add the CLI to PATH before using \`llmwiki\` in a new shell:`);
    console.log(`          export PATH=${shellQuote(BIN_DIR)}:"$PATH"`);
  }
  return 0;
}

function revert(dryRun: boolean): number {
  const hooks = readHooks();
  const currentOwned =
    managedHookSnapshot(hooks)
      .SessionStart?.flatMap((group) => group.hooks ?? [])
      .some((hook) => hook.command === SESSION_CMD) ||
    managedHookSnapshot(hooks)
      .UserPromptSubmit?.flatMap((group) => group.hooks ?? [])
      .some((hook) => hook.command === TURN_CMD) ||
    [...SKILLS, ...RETIRED_CODEX_SKILLS].some((name) => {
      try {
        return readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8").includes(OWNER_MARK);
      } catch {
        return false;
      }
    }) ||
    (() => {
      try {
        const launcher = readFileSync(LAUNCHER, "utf8");
        return isManagedLauncher(launcher) && launcher.includes(CLONE_ROOT);
      } catch {
        return false;
      }
    })();
  const removed = stripCurrentHooks(hooks);
  if (dryRun) {
    console.log("=== llmwiki Codex revert [DRY-RUN] ===");
    console.log(
      `  hooks=${removed}, skills=${SKILLS.length}, CLI=${LAUNCHER}, restore_previous=${currentOwned && existsSync(INSTALL_BACKUP)}`,
    );
    return 0;
  }
  if (existsSync(HOOKS_PATH)) writeJsonAtomic(HOOKS_PATH, hooks);
  for (const name of [...SKILLS, ...RETIRED_CODEX_SKILLS]) removeManagedSkill(name, true);
  try {
    const launcher = readFileSync(LAUNCHER, "utf8");
    if (isManagedLauncher(launcher) && launcher.includes(CLONE_ROOT) && !openCodeUsesCurrentClone()) {
      rmSync(LAUNCHER, { force: true });
    }
  } catch {
    /* absent or user-owned */
  }
  const restored = currentOwned ? restorePriorInstall(hooks) : false;
  console.log(
    `  [codex] ↩ removed ${removed} hook handler(s), managed skills, and managed CLI` +
      (restored ? "; restored the previous llmwiki install" : ""),
  );
  return 0;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}
const known = new Set(["--dry-run", "--revert"]);
const unknown = args.find((arg) => !known.has(arg));
if (unknown) {
  console.error(`Unknown option: ${unknown}`);
  process.stderr.write(usage());
  process.exit(2);
}
const dryRun = args.includes("--dry-run");
try {
  process.exit(args.includes("--revert") ? revert(dryRun) : apply(dryRun));
} catch (error) {
  console.error(`  [codex] ❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
