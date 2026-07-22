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
import { dirname, join } from "node:path";
import { CLONE_ROOT } from "../engine/paths.ts";

const HOME = process.env.HOME?.trim() || homedir();
const CODEX_HOME = process.env.CODEX_HOME?.trim() || join(HOME, ".codex");
const HOOKS_PATH = join(CODEX_HOME, "hooks.json");
const SKILLS_ROOT = join(HOME, ".agents", "skills");
const BIN_DIR = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
const LAUNCHER = join(BIN_DIR, "llmwiki");
const MANAGED = "llmwiki-codex-managed";
const OWNER_MARK = `${MANAGED} root=${CLONE_ROOT}`;
const LAUNCHER_MARK = "# llmwiki launcher (llmwiki-managed)";
const LEGACY_LAUNCHER_MARK = `# llmwiki launcher (${MANAGED})`;
const BACKUP_ID = createHash("sha256").update(CLONE_ROOT).digest("hex").slice(0, 16);
const INSTALL_BACKUP = join(CODEX_HOME, `llmwiki-install-backup.${BACKUP_ID}.json`);
const SESSION_MARK = "hooks/sessionstart-inject.sh";
const TURN_MARK = "hooks/userpromptsubmit-inject.sh";
const SESSION_CMD = `bash ${shellQuote(`${CLONE_ROOT}/${SESSION_MARK}`)}`;
const TURN_CMD = `bash ${shellQuote(`${CLONE_ROOT}/${TURN_MARK}`)}`;
const SKILLS = ["wiki-fast", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;
const LEGACY_SKILLS = SKILLS.map((name) => `llmwiki-${name.slice("wiki-".length)}`);

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
          typeof hook.command === "string" &&
          (hook.command.includes(SESSION_MARK) || hook.command.includes(TURN_MARK));
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
    if (file.hooks && event in file.hooks) file.hooks[event] = kept;
  }
  return removed;
}

function managedHookSnapshot(file: HooksFile): Record<string, HookGroup[]> {
  const snapshot: Record<string, HookGroup[]> = {};
  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    const groups = file.hooks?.[event] ?? [];
    const managed = groups.flatMap((group) => {
      const hooks = (group.hooks ?? []).filter(
        (hook) =>
          typeof hook.command === "string" &&
          (hook.command.includes(SESSION_MARK) || hook.command.includes(TURN_MARK)),
      );
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
  for (const name of [...SKILLS, ...LEGACY_SKILLS]) {
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
    if (isManagedLauncher(content)) launcher = { content, mode: statSync(LAUNCHER).mode & 0o777 };
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
    hooks: [{ type: "command", command: SESSION_CMD, timeout: 20, statusMessage: "llmwiki cold-start context" }],
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
  body = body.replace(/^---\n/, `---\nname: ${name}\n`);
  body = body
    .replaceAll("Read `~/llmwiki/skill/wiki-fast.md`", "invoke `$wiki-fast` before continuing")
    .replaceAll("bun ~/llmwiki/src/cli.ts", "llmwiki")
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
    "Use the installed `llmwiki` command; do not assume Claude-specific environment variables.\n";
  const frontmatterEnd = body.indexOf("\n---\n", 4);
  return frontmatterEnd >= 0
    ? body.slice(0, frontmatterEnd + 5) + marker + body.slice(frontmatterEnd + 5)
    : marker + body;
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
  const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(HOME, ".config");
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
    if (LEGACY_SKILLS.some((name) => existsSync(join(SKILLS_ROOT, name, "SKILL.md")))) {
      console.log(`  migrate: remove managed legacy skill names (${LEGACY_SKILLS.map((name) => `$${name}`).join(", ")})`);
    }
    console.log(`  CLI   : ${LAUNCHER}`);
    if (prior) console.log(`  backup: preserve the previous llmwiki install for --revert (${INSTALL_BACKUP})`);
    return 0;
  }

  if (prior) writeJsonAtomic(INSTALL_BACKUP, prior);
  const hooksChanged = writeJsonAtomic(HOOKS_PATH, hooks);
  for (const name of [...SKILLS, ...LEGACY_SKILLS]) removeManagedSkill(name);
  for (const sourceName of SKILLS) {
    const dir = join(SKILLS_ROOT, sourceName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), codexSkill(sourceName), "utf8");
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
  if (!(process.env.PATH ?? "").split(":").includes(BIN_DIR)) {
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
    [...SKILLS, ...LEGACY_SKILLS].some((name) => {
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
  for (const name of [...SKILLS, ...LEGACY_SKILLS]) removeManagedSkill(name, true);
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
