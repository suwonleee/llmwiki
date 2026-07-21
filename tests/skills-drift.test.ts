// Skill-command drift — guards a silent-failure class, not a crash.
//
// Three places must agree on "which /wiki-* commands exist": the repo's skill/ dir (the files
// themselves), wire.ts SKILLS (what setup installs into every profile), and doctor.ts COMMANDS
// (what doctor checks and --fix re-installs). Drift is silent in one direction each way:
// a skill missing from SKILLS is never installed for new users, and one missing from COMMANDS
// is installed but its loss is never detected or repaired. Observed 2026-07-21: wire installed
// /wiki-quiz but doctor didn't check it — a deleted quiz command would have stayed gone.
//
// Like tests/cli-flags.test.ts, this is deliberately a SOURCE test: the bug is drift between
// hand-maintained lists, and only reading the sources catches an entry someone adds tomorrow.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function listFrom(srcPath: string, constName: string): Set<string> {
  const src = readFileSync(join(ROOT, srcPath), "utf8");
  const block = src.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\]`));
  if (!block) throw new Error(`${constName} list not found in ${srcPath} — did it change shape?`);
  return new Set(Array.from(block[1]!.matchAll(/"([a-z-]+\.md)"/g), (m) => m[1]!));
}

describe("skill command lists stay in sync", () => {
  const skillFiles = new Set(readdirSync(join(ROOT, "skill")).filter((f) => f.endsWith(".md")));
  const wireSkills = listFrom("src/daemon/wire.ts", "SKILLS");
  const doctorCommands = listFrom("src/engine/doctor.ts", "COMMANDS");

  test("wire installs every skill file (a file missing here is never installed)", () => {
    expect([...wireSkills].sort()).toEqual([...skillFiles].sort());
  });

  test("doctor checks every installed skill (one missing here is lost silently)", () => {
    expect([...doctorCommands].sort()).toEqual([...wireSkills].sort());
  });
});
