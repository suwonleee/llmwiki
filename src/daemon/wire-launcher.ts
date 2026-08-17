#!/usr/bin/env bun
// Shared user launcher. Installation belongs to setup, not to a particular harness: a Claude-only
// user needs the same short project commands as Codex/OpenCode, and changing harnesses must not
// change how the engine is invoked.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, delimiter, join } from "node:path";

import { CLONE_ROOT } from "../engine/paths.ts";

const HOME = process.env.HOME?.trim() || homedir();
const BIN_DIR = process.env.LLMWIKI_BIN_DIR?.trim() || join(HOME, ".local", "bin");
const LAUNCHER = join(BIN_DIR, "llmwiki");
const MARK = "# llmwiki launcher (llmwiki-managed)";
const LEGACY_MARK = "# llmwiki launcher (llmwiki-codex-managed)";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function body(): string {
  return `#!/bin/sh\n${MARK}\nexec ${shellQuote(process.execPath)} ${shellQuote(join(CLONE_ROOT, "src", "cli.ts"))} "$@"\n`;
}

function managed(content: string): boolean {
  return content.includes(MARK) || content.includes(LEGACY_MARK);
}

function current(content: string): boolean {
  return managed(content) && content.includes(CLONE_ROOT);
}

function conflict(): boolean {
  if (!existsSync(LAUNCHER)) return false;
  try {
    return !managed(readFileSync(LAUNCHER, "utf8"));
  } catch {
    return true;
  }
}

function writeAtomic(content: string): boolean {
  mkdirSync(dirname(LAUNCHER), { recursive: true });
  if (existsSync(LAUNCHER) && readFileSync(LAUNCHER, "utf8") === content) return false;
  const temporary = `${LAUNCHER}.llmwiki-tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o755 });
  renameSync(temporary, LAUNCHER);
  chmodSync(LAUNCHER, 0o755);
  return true;
}

function apply(dryRun: boolean): number {
  if (conflict()) {
    console.error(`  [launcher] ❌ refusing to overwrite unrelated command: ${LAUNCHER}`);
    return 1;
  }
  if (dryRun) {
    console.log(`  [launcher] would install shared CLI: ${LAUNCHER}`);
    return 0;
  }
  const changed = writeAtomic(body());
  console.log(`  [launcher] ✅ shared CLI ${changed ? "installed" : "already current"}: ${LAUNCHER}`);
  if (process.platform === "win32") {
    console.log("  [launcher] • convenience command is for Git Bash; harness commands use explicit Bun paths in PowerShell");
  } else if (!(process.env.PATH ?? "").split(delimiter).includes(BIN_DIR)) {
    console.log("  [launcher] ⚠️ add the CLI to PATH once:");
    console.log(`             export PATH=${shellQuote(BIN_DIR)}:"$PATH"`);
  }
  return 0;
}

function revert(dryRun: boolean): number {
  let owned = false;
  try {
    owned = current(readFileSync(LAUNCHER, "utf8"));
  } catch {
    /* absent */
  }
  if (dryRun) {
    console.log(`  [launcher] current-clone CLI=${owned}: ${LAUNCHER}`);
    return 0;
  }
  if (owned) rmSync(LAUNCHER, { force: true });
  console.log(`  [launcher] ↩ ${owned ? "removed shared CLI" : "no current-clone CLI to remove"}`);
  return 0;
}

const args = process.argv.slice(2);
const known = new Set(["--dry-run", "--revert"]);
const unknown = args.find((arg) => !known.has(arg));
if (unknown) {
  console.error(`unknown option: ${unknown}`);
  process.exit(2);
}
process.exit(args.includes("--revert") ? revert(args.includes("--dry-run")) : apply(args.includes("--dry-run")));
