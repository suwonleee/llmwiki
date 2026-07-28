// The five /wiki-* command files, and the ONE way they are written into a Claude profile.
//
// Two installers write these: the cutover in daemon/wire.ts and doctor's `--fix` repair. They must
// produce byte-identical files, because everything downstream decides by what is IN the file:
//
//   - uninstall removes by ownership marker, so an unmarked copy is indistinguishable from a file
//     the user wrote themselves — it survives uninstall forever;
//   - setup's preflight refuses to touch ANY profile when it finds an unmarked wiki-*.md, so one
//     unmarked copy blocks the next `git pull && ./setup.sh` — the exact command the update
//     notice tells people to run;
//   - the skills ship with a `~/llmwiki` placeholder for their own clone path. A copy that keeps
//     it sends the agent to a path that does not exist in a clone installed anywhere else.
//
// A plain copyFileSync satisfies none of the three. Route every write through here.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLONE_ROOT } from "./paths.ts";

export const OWNED_MARK = "<!-- installed by llmwiki (owned; removed by uninstall) -->";

export const CLAUDE_COMMANDS = [
  "wiki-save.md",
  "wiki-ask.md",
  "wiki-deep.md",
  "wiki-quiz.md",
  "wiki-doctor.md",
] as const;

type ClaudeCommand = (typeof CLAUDE_COMMANDS)[number];
export type CommandRootState = "missing" | "directory" | "unsafe";
export type CommandFileState = "missing" | "regular" | "unsafe";

function assertCommandName(name: string): asserts name is ClaudeCommand {
  if (!(CLAUDE_COMMANDS as readonly string[]).includes(name)) {
    throw new Error(`unsupported Claude command name: ${name}`);
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Inspect `<profile>/commands` without following a profile or directory symlink. */
export function commandRootState(profile: string): CommandRootState {
  const profileStat = lstatOrNull(profile);
  if (!profileStat || profileStat.isSymbolicLink() || !profileStat.isDirectory()) return "unsafe";
  const commandStat = lstatOrNull(join(profile, "commands"));
  if (!commandStat) return "missing";
  return !commandStat.isSymbolicLink() && commandStat.isDirectory() ? "directory" : "unsafe";
}

/** Inspect one managed command path without following the final path component. */
export function commandFileState(profile: string, name: string): CommandFileState {
  assertCommandName(name);
  const root = commandRootState(profile);
  if (root === "unsafe") return "unsafe";
  if (root === "missing") return "missing";
  const stat = lstatOrNull(join(profile, "commands", name));
  if (!stat) return "missing";
  return !stat.isSymbolicLink() && stat.isFile() ? "regular" : "unsafe";
}

/** The exact bytes an owned command file must hold: this clone's paths, then the ownership mark. */
export function renderOwnedCommand(name: string, root: string = CLONE_ROOT): string {
  assertCommandName(name);
  const body = readFileSync(join(root, "skill", name), "utf-8")
    .split("~/llmwiki")
    .join(root)
    .split("$HOME/llmwiki")
    .join(root);
  return `${body.replace(/\n*$/, "\n")}\n${OWNED_MARK}\n`;
}

/** Write one owned command into `<profile>/commands/`, creating the directory. Returns its path. */
export function writeOwnedCommand(profile: string, name: string, root: string = CLONE_ROOT): string {
  assertCommandName(name);
  const commandDir = join(profile, "commands");
  const rootState = commandRootState(profile);
  if (rootState === "unsafe") throw new Error(`unsafe command directory: ${commandDir}`);
  if (rootState === "missing") mkdirSync(commandDir, { mode: 0o700 });
  const dst = join(profile, "commands", name);
  const destination = commandFileState(profile, name);
  if (destination === "unsafe") throw new Error(`unsafe command destination: ${dst}`);
  if (destination === "regular") throw new Error(`command destination already exists: ${dst}`);
  // wx makes the final create exclusive, so a dangling symlink planted after inspection is still
  // refused rather than followed. Parent components were checked above without following links.
  writeFileSync(dst, renderOwnedCommand(name, root), { encoding: "utf-8", flag: "wx", mode: 0o600 });
  return dst;
}
