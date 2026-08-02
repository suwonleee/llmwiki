#!/usr/bin/env bun
// wire.ts — cut over the Claude profiles to this clone's llmwiki engine.
// For each ~/.claude*/settings.json — plus $CLAUDE_CONFIG_DIR — (backup → edit → JSON-validate → save):
//   - REMOVE old hooks (legacy distill check/enqueue).
//   - ADD/RE-POINT SessionStart: bash <ROOT>/hooks/sessionstart-inject.sh.
//   - INSTALL /wiki-* commands → <profile>/commands/, rewriting the ~/llmwiki
//     placeholder to THIS clone's absolute path.
//
//   bun wire.ts            apply cutover
//   bun wire.ts --revert   restore the most recent backups
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CLAUDE_COMMANDS,
  OWNED_MARK,
  commandFileState,
  commandRootState,
  writeOwnedCommand,
} from "../engine/claude-commands.ts";
import { RETIRED_CLAUDE_COMMANDS } from "../engine/install-history.ts";
import { CLONE_ROOT, CLONE_ROOT_SHELL, engineCliCommand } from "../engine/paths.ts";
import { claudeConfigDirs } from "../engine/sources/claude.ts";

const ROOT = CLONE_ROOT; // resolved from this file's location — path/name-agnostic

// The hook command is a SHELL string that Claude Code runs. A clone path containing a space,
// a quote, `$(…)`, a backtick or a `;` would otherwise split into the wrong argv — or execute.
// Quoting matches the Codex/OpenCode wiring, which already did this.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// CLONE_ROOT_SHELL, not ROOT: this string is a bash command that also has to round-trip through
// settings.json, and one posix-shaped spelling is what keeps the written hook, doctor's
// clone-identity check, and uninstall comparing the same bytes (paths.ts). Identical on POSIX.
const INJECT = `bash ${shellQuote(`${CLONE_ROOT_SHELL}/hooks/sessionstart-inject.sh`)}`;
const TURN_INJECT = `bash ${shellQuote(`${CLONE_ROOT_SHELL}/hooks/userpromptsubmit-inject.sh`)}`;

// The ownership mark and the command list live in engine/claude-commands.ts — doctor's `--fix`
// installs the same files, and a second copy of either would let the two installers drift.
// Commands are marker-bearing copies even for ~/llmwiki. A generic symlink target is not a
// trustworthy ownership proof; copies make conflict/uninstall decisions exact and local.
//
// Hook marks below are a stable filename key — present regardless of clone path, so re-running
// from a new location detects & re-points the old hook instead of leaving a stale duplicate.
const NEW_MARK = "hooks/sessionstart-inject.sh";
const TURN_MARK = "hooks/userpromptsubmit-inject.sh";
const OLD_MARKS = ["wiki-distill-check.sh", "wiki-distill-enqueue.py"];

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookBlock {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = { hooks?: Record<string, HookBlock[]>; [k: string]: unknown };

function profiles(): string[] {
  // ~/.claude* plus an explicit $CLAUDE_CONFIG_DIR (shared discovery — engine/sources/claude.ts).
  // Deliberately NOT the dirs `llmwiki connect claude` persisted: those say where to READ
  // transcripts, and wiring writes (settings.json, commands/) belong only to a profile this
  // machine owns.
  return claudeConfigDirs();
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function has(settings: Settings, event: string, mark: string): boolean {
  for (const b of settings.hooks?.[event] ?? []) {
    for (const h of b.hooks ?? []) {
      if ((h.command ?? "").includes(mark)) return true;
    }
  }
  return false;
}

function strip(settings: Settings, event: string, mark: string): number {
  const blocks = settings.hooks?.[event] ?? [];
  let removed = 0;
  const newBlocks: HookBlock[] = [];
  for (const b of blocks) {
    const hooks = (b.hooks ?? []).filter((h) => !(h.command ?? "").includes(mark));
    removed += (b.hooks ?? []).length - hooks.length;
    if (hooks.length) newBlocks.push({ ...b, hooks });
  }
  if (settings.hooks && event in settings.hooks) settings.hooks[event] = newBlocks;
  return removed;
}

function addSessionStart(settings: Settings): void {
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: INJECT }] });
}

// Per-turn read-injection. Additive next to any OMC/other UserPromptSubmit
// entries — same coexistence contract as the SessionStart hook.
function addUserPromptSubmit(settings: Settings): void {
  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit ??= [];
  settings.hooks.UserPromptSubmit.push({ matcher: "", hooks: [{ type: "command", command: TURN_INJECT }] });
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function commandConflicts(profs: readonly string[]): string[] {
  const conflicts: string[] = [];
  for (const prof of profs) {
    const commandDir = join(prof, "commands");
    if (commandRootState(prof) === "unsafe") {
      conflicts.push(commandDir);
      continue;
    }
    for (const file of CLAUDE_COMMANDS) {
      const path = join(commandDir, file);
      const state = commandFileState(prof, file);
      if (state === "unsafe" || (state === "regular" && !isOwnedCommandFile(path))) conflicts.push(path);
    }
    for (const file of RETIRED_CLAUDE_COMMANDS) {
      const path = join(commandDir, file);
      if (pathExists(path) && !isOwnedCommandFile(path)) conflicts.push(path);
    }
  }
  return conflicts.sort();
}

function apply(dryRun = false): number {
  const profs = profiles();
  if (!profs.length) {
    // Non-Claude harness: nothing Claude-specific to wire. The engine is harness-neutral —
    // drive it via the CLI directly instead.
    console.log("  [wire] no ~/.claude* profile found — nothing Claude-specific to wire.");
    console.log("  (If your Claude config dir lives elsewhere, set CLAUDE_CONFIG_DIR and re-run.)");
    console.log("  Harness-neutral usage (Codex / any): inject cold-start with");
    // engineCliCommand, not a bare `bun <root>/src/cli.ts`: this line is printed for the reader to
    // paste into a shell, so it is subject to the same quoting contract as the invocations the
    // wirings substitute into generated pages (paths.ts). It was the last unquoted spelling left,
    // and it reaches exactly the adopters who have no Claude profile — a Codex- or OpenCode-only
    // install, where this is the ONLY instruction they get. A clone under `~/my llmwiki` (or the
    // `C:\Users\First Last` that Windows hands out by default) truncated it at the space, and bun
    // answered `Module not found ".../my"`.
    console.log(`    ${engineCliCommand(ROOT)} context <repo>`);
    console.log("  from your harness's startup config (e.g. AGENTS.md), and run /wiki-* steps via the same CLI.");
    return 0;
  }
  const conflicts = commandConflicts(profs);
  if (conflicts.length) {
    console.error("🔴 Claude command conflict(s); setup left every profile untouched:");
    for (const path of conflicts) console.error(`    ${path}`);
    console.error("   Move or rename those user-owned files, then re-run setup.");
    return 1;
  }
  if (dryRun) {
    console.log("✓ Claude preflight: no command conflicts");
    for (const prof of profs) console.log(`  would wire: ${prof}`);
    return 0;
  }
  for (const prof of profs) {
    const sp = join(prof, "settings.json");
    const name = basename(prof);
    let settings: Settings;
    if (existsSync(sp)) {
      try {
        settings = JSON.parse(readFileSync(sp, "utf-8"));
      } catch (e) {
        console.log(`  [${name}] 🔴 parse failed (${e}) — skipped`);
        continue;
      }
      copyFileSync(sp, `${sp}.llmwiki-bak.${timestamp()}`);
    } else {
      // A profile dir with no settings.json yet (a fresh Claude install) used to be silently
      // skipped while still printing "cutover applied" — adopters got NO hook/commands and a
      // false success. Create it with the wiring instead.
      settings = {};
    }

    let removed = 0;
    for (const mark of OLD_MARKS) {
      removed += strip(settings, "SessionStart", mark);
      removed += strip(settings, "Stop", mark);
    }
    // re-point: drop any prior llmwiki inject hook (possibly a different clone path)
    // then re-add THIS clone's, so a run from a new location cuts over cleanly.
    const repointed =
      strip(settings, "SessionStart", NEW_MARK) + strip(settings, "UserPromptSubmit", TURN_MARK);
    addSessionStart(settings);
    addUserPromptSubmit(settings);

    const text = JSON.stringify(settings, null, 2) + "\n";
    JSON.parse(text); // validate
    writeFileSync(sp, text, "utf-8");

    // install slash commands → <profile>/commands/ (engine/claude-commands.ts owns the bytes:
    // `~/llmwiki` placeholder → THIS clone's path, plus the ownership mark).
    mkdirSync(join(prof, "commands"), { recursive: true });
    // prune retired commands before re-installing so renamed skills leave no broken command
    for (const stale of RETIRED_CLAUDE_COMMANDS) {
      const path = join(prof, "commands", stale);
      if (isOwnedCommandFile(path)) rmSync(path, { force: true });
    }
    for (const skill of CLAUDE_COMMANDS) {
      const dst = join(prof, "commands", skill);
      if (isOwnedCommandFile(dst)) rmSync(dst, { force: true }); // prior llmwiki copy/symlink
      writeOwnedCommand(prof, skill, ROOT);
    }

    const cmds = CLAUDE_COMMANDS.map((s) => "/" + s.slice(0, -3)).join(", ");
    console.log(
      `  [${name}] ✅ old removed: ${removed}, re-pointed: ${repointed}, ` +
        `SessionStart+UserPromptSubmit → ${basename(ROOT)}, installed (owned copy): ${cmds}`,
    );
  }
  console.log("✓ cutover applied (backups: settings.json.llmwiki-bak.*)");
  return 0;
}

// Uninstall by OWNERSHIP, not by chronology.
//
// Restoring the newest `settings.json.llmwiki-bak.*` was wrong in the ordinary case: on a second
// install that backup is a file that ALREADY contains llmwiki's hooks, so "revert" reinstated
// them — and any unrelated hook the user added between the two installs was silently rolled back
// with it. Removing exactly the entries that carry our marker leaves everything else alone,
// whatever order things happened in. Backups stay on disk for human recovery; they are simply
// not the source of truth for removal.
function isOwnedCommandFile(path: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) {
    try {
      const target = resolve(dirname(path), readlinkSync(path));
      return target === join(ROOT, "skill", basename(path));
    } catch {
      return false;
    }
  }
  if (!st.isFile()) return false;
  try {
    return readFileSync(path, "utf-8").includes(OWNED_MARK);
  } catch {
    return false;
  }
}

function revert(): number {
  let hooks = 0;
  let commands = 0;
  let failures = 0;
  for (const prof of profiles()) {
    const name = basename(prof);
    const sp = join(prof, "settings.json");
    if (existsSync(sp)) {
      let settings: Settings | null = null;
      try {
        settings = JSON.parse(readFileSync(sp, "utf-8"));
      } catch (e) {
        console.log(`  [${name}] 🔴 parse failed (${e}) — left untouched`);
        failures += 1;
      }
      if (settings) {
        try {
          copyFileSync(sp, `${sp}.llmwiki-bak.${timestamp()}`);
          let removed = 0;
          for (const mark of [NEW_MARK, TURN_MARK, ...OLD_MARKS]) {
            for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
              removed += strip(settings, event, mark);
            }
          }
          // drop hook events we emptied, so uninstall leaves no `"SessionStart": []` residue
          for (const [event, blocks] of Object.entries(settings.hooks ?? {})) {
            if (Array.isArray(blocks) && blocks.length === 0) delete settings.hooks![event];
          }
          if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
          const text = JSON.stringify(settings, null, 2) + "\n";
          JSON.parse(text); // validate before writing
          writeFileSync(sp, text, "utf-8");
          hooks += removed;
          console.log(`  [${name}] ↩ removed ${removed} llmwiki hook entr${removed === 1 ? "y" : "ies"}`);
        } catch (e) {
          failures += 1;
          console.log(`  [${name}] 🔴 hook removal failed (${e}) — settings left for inspection`);
        }
      }
    }
    // installed commands: marker-bearing copies, plus exact legacy links into THIS clone.
    const cmdDir = join(prof, "commands");
    for (const file of [...CLAUDE_COMMANDS, ...RETIRED_CLAUDE_COMMANDS]) {
      const path = join(cmdDir, file);
      if (!isOwnedCommandFile(path)) continue;
      try {
        rmSync(path, { force: true });
        commands += 1;
      } catch (e) {
        failures += 1;
        console.log(`  [${name}] 🔴 command removal failed (${path}: ${e})`);
      }
    }
  }
  console.log(
    `${failures ? "⚠" : "✓"} llmwiki Claude wiring removed: ${hooks} hook entr${hooks === 1 ? "y" : "ies"}, ${commands} command file(s)`,
  );
  console.log("  (unrelated hooks and commands were left untouched; settings backups kept as settings.json.llmwiki-bak.*)");
  if (failures) console.log(`  🔴 ${failures} removal step(s) failed; inspect the messages above and re-run uninstall.`);
  return failures ? 1 : 0;
}

if (process.argv.includes("--revert")) process.exit(revert());
process.exit(apply(process.argv.includes("--dry-run")));
