#!/usr/bin/env bun
// First-class OpenCode wiring for a path-independent llmwiki clone.
//
//   bun wire-opencode.ts             install global plugin + /wiki-* commands + user CLI
//   bun wire-opencode.ts --dry-run   validate conflicts and print targets, write nothing
//   bun wire-opencode.ts --revert    remove only surfaces owned by this clone
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLONE_ROOT } from "../engine/paths.ts";

const HOME = process.env.HOME?.trim() || homedir();
const CONFIG_ROOT = process.env.XDG_CONFIG_HOME?.trim() || join(HOME, ".config");
const OPENCODE_ROOT = join(CONFIG_ROOT, "opencode");
const PLUGIN = join(OPENCODE_ROOT, "plugin", "llmwiki.ts");
const COMMANDS_ROOT = join(OPENCODE_ROOT, "commands");
const BIN_DIR = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
const LAUNCHER = join(BIN_DIR, "llmwiki");
const COMMANDS = ["wiki-fast", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;
const MANAGED = "llmwiki-opencode-managed";
const OWNER_MARK = `${MANAGED} root=${CLONE_ROOT}`;
const PLUGIN_LEGACY_MARK = "llmwiki OpenCode plugin";
const LAUNCHER_MARK = "# llmwiki launcher (llmwiki-managed)";
const LEGACY_LAUNCHER_MARK = "# llmwiki launcher (llmwiki-codex-managed)";
const BACKUP_ID = createHash("sha256").update(CLONE_ROOT).digest("hex").slice(0, 16);
const INSTALL_BACKUP = join(OPENCODE_ROOT, `llmwiki-install-backup.${BACKUP_ID}.json`);

interface InstallBackup {
  version: 1;
  targetRoot: string;
  plugin: string | null;
  commands: Record<string, string>;
  launcher: { content: string; mode: number } | null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function usage(): string {
  return `Usage: bun ${shellQuote(join(CLONE_ROOT, "src", "daemon", "wire-opencode.ts"))} [--dry-run|--revert]\n`;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
  );
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isManagedPlugin(content: string): boolean {
  return (
    content.includes(MANAGED) ||
    (content.includes(PLUGIN_LEGACY_MARK) &&
      content.includes("experimental.chat.system.transform") &&
      content.includes("const ROOT = process.env.LLMWIKI_ROOT"))
  );
}

function isManagedLauncher(content: string): boolean {
  return content.includes(LAUNCHER_MARK) || content.includes(LEGACY_LAUNCHER_MARK);
}

function pluginBody(): string {
  const sourcePath = join(CLONE_ROOT, "adapters", "opencode", "llmwiki.ts");
  const source = readFileSync(sourcePath, "utf8");
  const rootLine = `const ROOT = process.env.LLMWIKI_ROOT ?? ${JSON.stringify(CLONE_ROOT)}; // absolute path of the llmwiki clone`;
  const body = source.replace(
    /^const ROOT = process\.env\.LLMWIKI_ROOT \?\? .*$/m,
    rootLine,
  );
  if (body === source) throw new Error(`cannot locate LLMWIKI_ROOT placeholder in ${sourcePath}`);
  return `// ${OWNER_MARK} source_sha256=${hashFile(sourcePath)}\n${body}`;
}

function commandBody(name: (typeof COMMANDS)[number]): string {
  const sourcePath = join(CLONE_ROOT, "skill", `${name}.md`);
  let body = readFileSync(sourcePath, "utf8");
  body = body
    .replaceAll("Read `~/llmwiki/skill/wiki-fast.md`", `Read \`${join(CLONE_ROOT, "skill", "wiki-fast.md")}\``)
    .replaceAll("bun ~/llmwiki/src/cli.ts", "llmwiki")
    .replaceAll("$CLAUDE_PROJECT_DIR", "the current OpenCode project directory")
    .replaceAll("~/llmwiki", CLONE_ROOT)
    .replaceAll("$HOME/llmwiki", CLONE_ROOT);
  const marker = `\n<!-- ${OWNER_MARK} source_sha256=${hashFile(sourcePath)} -->\n`;
  const frontmatterEnd = body.indexOf("\n---\n", 4);
  return frontmatterEnd >= 0
    ? body.slice(0, frontmatterEnd + 5) + marker + body.slice(frontmatterEnd + 5)
    : marker + body;
}

function launcherBody(): string {
  return (
    "#!/bin/sh\n" +
    `${LAUNCHER_MARK}\n` +
    `exec ${shellQuote(process.execPath)} ${shellQuote(join(CLONE_ROOT, "src", "cli.ts"))} "$@"\n`
  );
}

function writeAtomic(path: string, content: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  if (existsSync(path)) copyFileSync(path, `${path}.llmwiki-bak.${timestamp()}`);
  const tmp = `${path}.llmwiki-tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  return true;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const content = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(content);
  writeAtomic(path, content);
}

function conflicts(): string[] {
  const found: string[] = [];
  if (existsSync(PLUGIN)) {
    try {
      if (!isManagedPlugin(readFileSync(PLUGIN, "utf8"))) found.push(PLUGIN);
    } catch {
      found.push(PLUGIN);
    }
  }
  for (const name of COMMANDS) {
    const path = join(COMMANDS_ROOT, `${name}.md`);
    if (!existsSync(path)) continue;
    try {
      if (!readFileSync(path, "utf8").includes(MANAGED)) found.push(path);
    } catch {
      found.push(path);
    }
  }
  if (existsSync(LAUNCHER)) {
    try {
      if (!isManagedLauncher(readFileSync(LAUNCHER, "utf8"))) found.push(LAUNCHER);
    } catch {
      found.push(LAUNCHER);
    }
  }
  return found;
}

function capturePriorInstall(): InstallBackup | null {
  let plugin: string | null = null;
  let currentOwned = false;
  try {
    const content = readFileSync(PLUGIN, "utf8");
    if (isManagedPlugin(content)) plugin = content;
    if (isManagedPlugin(content) && content.includes(CLONE_ROOT)) currentOwned = true;
  } catch {
    /* absent */
  }
  const commands: Record<string, string> = {};
  for (const name of COMMANDS) {
    const path = join(COMMANDS_ROOT, `${name}.md`);
    try {
      const content = readFileSync(path, "utf8");
      if (content.includes(MANAGED)) commands[name] = content;
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
  if (currentOwned || (!plugin && Object.keys(commands).length === 0 && !launcher)) return null;
  return { version: 1, targetRoot: CLONE_ROOT, plugin, commands, launcher };
}

function restorePriorInstall(): boolean {
  if (!existsSync(INSTALL_BACKUP)) return false;
  const backup = JSON.parse(readFileSync(INSTALL_BACKUP, "utf8")) as InstallBackup;
  if (backup.version !== 1 || backup.targetRoot !== CLONE_ROOT) {
    throw new Error(`invalid install backup: ${INSTALL_BACKUP}`);
  }
  if (backup.plugin && !existsSync(PLUGIN)) writeAtomic(PLUGIN, backup.plugin);
  for (const [name, content] of Object.entries(backup.commands)) {
    const path = join(COMMANDS_ROOT, `${name}.md`);
    if (!existsSync(path)) writeAtomic(path, content);
  }
  if (backup.launcher && !existsSync(LAUNCHER)) {
    writeAtomic(LAUNCHER, backup.launcher.content);
    chmodSync(LAUNCHER, backup.launcher.mode);
  }
  rmSync(INSTALL_BACKUP, { force: true });
  return true;
}

function codexUsesCurrentClone(): boolean {
  for (const name of COMMANDS) {
    try {
      const content = readFileSync(join(HOME, ".agents", "skills", name, "SKILL.md"), "utf8");
      if (content.includes("llmwiki-codex-managed") && content.includes(`root=${CLONE_ROOT}`)) return true;
    } catch {
      /* absent */
    }
  }
  return false;
}

function apply(dryRun: boolean): number {
  const blocked = conflicts();
  if (blocked.length) {
    console.error("  [opencode] ❌ refusing to overwrite unrelated file(s):");
    for (const path of blocked) console.error(`             ${path}`);
    return 1;
  }
  const prior = capturePriorInstall();
  if (dryRun) {
    console.log("=== llmwiki OpenCode wiring [DRY-RUN] ===");
    console.log(`  plugin  : ${PLUGIN}`);
    console.log(`  commands: ${COMMANDS.map((name) => `/${name}`).join(", ")} → ${COMMANDS_ROOT}`);
    console.log(`  CLI     : ${LAUNCHER}`);
    if (prior) console.log(`  backup  : preserve the previous llmwiki install for --revert (${INSTALL_BACKUP})`);
    return 0;
  }

  if (prior) writeJsonAtomic(INSTALL_BACKUP, prior);
  const pluginChanged = writeAtomic(PLUGIN, pluginBody());
  for (const name of COMMANDS) writeAtomic(join(COMMANDS_ROOT, `${name}.md`), commandBody(name));
  writeAtomic(LAUNCHER, launcherBody());
  chmodSync(LAUNCHER, 0o755);

  console.log(`  [opencode] ✅ plugin ${pluginChanged ? "installed" : "already current"}: ${PLUGIN}`);
  console.log(`  [opencode] ✅ commands installed: ${COMMANDS.map((name) => `/${name}`).join(", ")}`);
  console.log(`  [opencode] ✅ CLI installed: ${LAUNCHER}`);
  if (!(process.env.PATH ?? "").split(":").includes(BIN_DIR)) {
    console.log("  [opencode] ⚠️ add the CLI to PATH before using `llmwiki` in a new shell:");
    console.log(`             export PATH=${shellQuote(BIN_DIR)}:"$PATH"`);
  }
  return 0;
}

function revert(dryRun: boolean): number {
  let pluginOwned = false;
  try {
    const content = readFileSync(PLUGIN, "utf8");
    pluginOwned = isManagedPlugin(content) && content.includes(CLONE_ROOT);
  } catch {
    /* absent */
  }
  const ownedCommands = COMMANDS.filter((name) => {
    try {
      return readFileSync(join(COMMANDS_ROOT, `${name}.md`), "utf8").includes(OWNER_MARK);
    } catch {
      return false;
    }
  });
  let launcherOwned = false;
  try {
    const content = readFileSync(LAUNCHER, "utf8");
    launcherOwned = isManagedLauncher(content) && content.includes(CLONE_ROOT);
  } catch {
    /* absent */
  }
  const currentOwned = pluginOwned || ownedCommands.length > 0 || launcherOwned;
  if (dryRun) {
    console.log("=== llmwiki OpenCode revert [DRY-RUN] ===");
    console.log(
      `  plugin=${pluginOwned}, commands=${ownedCommands.length}, CLI=${launcherOwned && !codexUsesCurrentClone()}, ` +
        `restore_previous=${currentOwned && existsSync(INSTALL_BACKUP)}`,
    );
    return 0;
  }
  if (pluginOwned) rmSync(PLUGIN, { force: true });
  for (const name of ownedCommands) rmSync(join(COMMANDS_ROOT, `${name}.md`), { force: true });
  if (launcherOwned && !codexUsesCurrentClone()) rmSync(LAUNCHER, { force: true });
  const restored = currentOwned ? restorePriorInstall() : false;
  console.log(
    `  [opencode] ↩ removed ${pluginOwned ? 1 : 0} plugin, ${ownedCommands.length} command(s)` +
      (launcherOwned && !codexUsesCurrentClone() ? ", and managed CLI" : "") +
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
  console.error(`  [opencode] ❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
