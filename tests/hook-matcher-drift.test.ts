// SessionStart matcher drift — guards a silent-failure class, not a crash.
//
// Three surfaces install the same two read-injection hooks: the Claude clone install
// (src/daemon/wire.ts), the Codex clone install (src/daemon/wire-codex.ts), and the plugin bundle
// (hooks/hooks.json, which BOTH harnesses read). They must agree on the SessionStart matcher.
//
// They did not. The clone installs have always written the empty matcher; the plugin file carried
// an enumerated source list, "startup|resume|clear|compact". Claude Code evaluates a matcher of
// that shape as an EXACT STRING LIST, not a regex, so the list matches exactly the sources named
// in it and nothing else. When Claude Code v2.1.214 added a fifth source, `fork` (covering
// --fork-session, /fork and /branch; before that release forks reported `resume` and were caught
// by the list), plugin-installed sessions that were forked silently stopped receiving cold-start
// context. Clone installs were unaffected — which is exactly why it went unnoticed.
//
// The fix is not "add fork": a sixth source would reopen the same hole. An enumerated list is the
// defect, because it fails CLOSED and SILENTLY on a value the harness adds later. The empty
// matcher means "every source" and cannot go stale.
//
// Like tests/skills-drift.test.ts and tests/cli-flags.test.ts, this is deliberately a SOURCE test:
// the bug is drift between hand-maintained declarations, and only reading the sources catches an
// enumeration someone re-introduces tomorrow.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A matcher is "open" when it constrains nothing: absent, or the empty string. */
const isOpenMatcher = (matcher: unknown): boolean => matcher === undefined || matcher === "";

describe("SessionStart matcher stays open across every install surface", () => {
  const pluginHooks = JSON.parse(read("hooks/hooks.json")) as {
    hooks: Record<string, { matcher?: unknown; hooks: unknown[] }[]>;
  };

  test("the plugin bundle matches every SessionStart source, not an enumerated list", () => {
    const groups = pluginHooks.hooks.SessionStart ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      // The regression: "startup|resume|clear|compact" is an exact string list under Claude Code,
      // so a source added by a later release (fork, v2.1.214) matches nothing at all.
      expect(isOpenMatcher(group.matcher)).toBe(true);
    }
  });

  test("UserPromptSubmit is open too (it has no source values to enumerate)", () => {
    for (const group of pluginHooks.hooks.UserPromptSubmit ?? []) {
      expect(isOpenMatcher(group.matcher)).toBe(true);
    }
  });

  test("no install surface enumerates SessionStart sources", () => {
    // Names any known source value in a matcher position. Catches a re-introduced list in the
    // plugin JSON and in either clone installer, whichever a future change reaches for.
    const enumerated = /"matcher"\s*:\s*"[^"]*\b(?:startup|resume|clear|compact|fork)\b/;
    for (const src of ["hooks/hooks.json", "src/daemon/wire.ts", "src/daemon/wire-codex.ts"]) {
      expect(read(src)).not.toMatch(enumerated);
    }
  });

  test("both clone installers write the same open matcher the plugin does", () => {
    // Source-level: each installer's hook group literal carries `matcher: ""`.
    for (const src of ["src/daemon/wire.ts", "src/daemon/wire-codex.ts"]) {
      expect(read(src)).toMatch(/matcher:\s*""/);
    }
  });
});
