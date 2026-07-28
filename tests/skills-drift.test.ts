// Skill-command drift — guards a silent-failure class, not a crash.
//
// Three places once had to agree on "which /wiki-* commands exist": the repo's skill/ dir (the
// files themselves), wire.ts SKILLS (what setup installs into every profile), and doctor.ts
// COMMANDS (what doctor checks and --fix re-installs). Drift was silent in one direction each
// way: a skill missing from SKILLS was never installed for new users, and one missing from
// COMMANDS was installed but its loss never detected or repaired. Observed 2026-07-21: wire
// installed /wiki-quiz but doctor didn't check it — a deleted quiz command would have stayed gone.
//
// Two of those three lists are now ONE: engine/claude-commands.ts owns the command list (and the
// bytes both installers write). So the remaining invariants are that the single list still tracks
// the skill/ directory, and that nobody re-introduces a private copy of it — which is what
// re-opened the drift in the first place.
//
// Like tests/cli-flags.test.ts, this is deliberately a SOURCE test: the bug is drift between
// hand-maintained lists, and only reading the sources catches an entry someone adds tomorrow.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CLAUDE_COMMANDS } from "../src/engine/claude-commands.ts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("skill command lists stay in sync", () => {
  const skillFiles = new Set(readdirSync(join(ROOT, "skill")).filter((f) => f.endsWith(".md")));

  test("the shared list covers every skill file (a file missing here is never installed)", () => {
    const installed: string[] = [...CLAUDE_COMMANDS];
    expect(installed.sort()).toEqual([...skillFiles].sort());
  });

  test("both installers use the shared list rather than a private copy", () => {
    for (const src of ["src/daemon/wire.ts", "src/engine/doctor.ts"]) {
      const text = read(src);
      expect(text).toContain("claude-commands.ts");
      // a re-introduced literal list is exactly the drift this file exists to prevent
      expect(text).not.toMatch(/=\s*\[[^\]]*"wiki-save\.md"/);
    }
  });

  test("doctor's CORE file-sanity list covers every skill source file (a missing source is repairable only if checked)", () => {
    const core = read("src/engine/doctor.ts").match(/const CORE = \[([\s\S]*?)\]/)?.[1] ?? "";
    for (const f of skillFiles) expect(core).toContain(`"skill/${f}"`);
  });
});
