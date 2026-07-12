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
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLONE_ROOT } from "../engine/paths.ts";
import { claudeConfigDirs } from "../engine/sources/claude.ts";

const HOME = homedir();
const ROOT = CLONE_ROOT; // resolved from this file's location — path/name-agnostic
const INJECT = `bash ${ROOT}/hooks/sessionstart-inject.sh`;
const TURN_INJECT = `bash ${ROOT}/hooks/userpromptsubmit-inject.sh`;
const SKILLS = ["wiki-update.md", "wiki-ask.md", "wiki-sync.md"];
// When the clone IS ~/llmwiki, the skills' `~/llmwiki` references resolve correctly at runtime
// (shell ~-expansion), so we can SYMLINK the installed commands to the repo skills instead of
// copying. That eliminates installed-vs-repo drift (an edit to skill/*.md is immediately live, no
// re-wire). A non-canonical clone (public template elsewhere) still needs the absolute path baked
// in, so it falls back to copy-with-rewrite.
const CANONICAL = ROOT === join(HOME, "llmwiki");
// stable filename key — present regardless of clone path, so re-running from a new
// location detects & re-points the old hook instead of leaving a stale duplicate.
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
  return claudeConfigDirs();
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

function apply(): number {
  const profs = profiles();
  if (!profs.length) {
    // Non-Claude harness: nothing Claude-specific to wire. The engine is harness-neutral —
    // drive it via the CLI directly instead.
    console.log("  [wire] no ~/.claude* profile found — nothing Claude-specific to wire.");
    console.log("  (If your Claude config dir lives elsewhere, set CLAUDE_CONFIG_DIR and re-run.)");
    console.log("  Harness-neutral usage (Codex / any): inject cold-start with");
    console.log(`    bun ${ROOT}/src/cli.ts context <repo>`);
    console.log("  from your harness's startup config (e.g. AGENTS.md), and run /wiki-* steps via the same CLI.");
    return 0;
  }
  for (const prof of profs) {
    const sp = join(prof, "settings.json");
    const name = prof.split("/").pop()!;
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

    // install slash commands → <profile>/commands/. The skill files reference the
    // engine via `~/llmwiki` (canonical placeholder); rewrite to THIS clone's path.
    mkdirSync(join(prof, "commands"), { recursive: true });
    for (const skill of SKILLS) {
      const src = join(ROOT, "skill", skill);
      const dst = join(prof, "commands", skill);
      rmSync(dst, { force: true }); // drop any prior copy/symlink before re-installing
      if (CANONICAL) {
        symlinkSync(src, dst); // live link to the repo skill — no drift, no re-wire needed
      } else {
        let body = readFileSync(src, "utf-8");
        body = body.split("~/llmwiki").join(ROOT).split("$HOME/llmwiki").join(ROOT);
        writeFileSync(dst, body, "utf-8");
      }
    }

    const cmds = SKILLS.map((s) => "/" + s.slice(0, -3)).join(", ");
    console.log(
      `  [${name}] ✅ old removed: ${removed}, re-pointed: ${repointed}, ` +
        `SessionStart+UserPromptSubmit → ${ROOT.split("/").pop()}, installed (${CANONICAL ? "symlink" : "copy"}): ${cmds}`,
    );
  }
  console.log("✓ cutover applied (backups: settings.json.llmwiki-bak.*)");
  return 0;
}

function revert(): number {
  for (const prof of profiles()) {
    const sp = join(prof, "settings.json");
    const dir = prof;
    let baks: string[] = [];
    try {
      baks = readdirSync(dir)
        .filter((f) => f.startsWith("settings.json.llmwiki-bak."))
        .sort();
    } catch {
      /* none */
    }
    if (baks.length) {
      copyFileSync(join(dir, baks[baks.length - 1]!), sp);
      console.log(`  [${prof.split("/").pop()}] ↩ restored ${baks[baks.length - 1]}`);
    }
  }
  console.log("✓ reverted to most recent backups");
  return 0;
}

process.exit(process.argv.includes("--revert") ? revert() : apply());
