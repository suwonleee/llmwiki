#!/usr/bin/env bun
import { join } from "node:path";

export type CheckMode = "quick" | "full";

export type CheckStep = {
  readonly label: string;
  readonly argv: readonly string[];
};

const ROOT = join(import.meta.dir, "..", "..");
const BUN = process.execPath;
const SHELL_FILES = [
  "setup.sh",
  "daemon/install.sh",
  "daemon/autoupdate-all.sh",
  "daemon/autoupdate-schedule.sh",
  "hooks/sessionstart-inject.sh",
  "hooks/userpromptsubmit-inject.sh",
] as const;
const FOCUSED_TESTS = [
  "tests/cli-flags.test.ts",
  "tests/contributor-docs.test.ts",
  "tests/onboarding-docs.test.ts",
  "tests/plugin-assets.test.ts",
  "tests/release-boundary.test.ts",
  "tests/repo-io-static-boundary.test.ts",
] as const;

export function checkPlan(mode: CheckMode): CheckStep[] {
  return [
    { label: "typecheck", argv: [BUN, "run", "typecheck"] },
    mode === "quick"
      ? { label: "focused tests", argv: [BUN, "test", ...FOCUSED_TESTS] }
      : { label: "full test suite", argv: [BUN, "test"] },
    // One `bash -n` per file. `bash -n a.sh b.sh` parses ONLY a.sh — everything after the first
    // path becomes a positional argument to it, so the shipped hook and daemon scripts were
    // silently unchecked while the step reported green. CI never had the bug because it loops.
    {
      label: "shell syntax",
      argv: ["bash", "-c", 'for script in "$@"; do bash -n "$script" || exit 1; done', "check", ...SHELL_FILES],
    },
    { label: "publish boundary", argv: [BUN, "src/plugin/preflight.ts"] },
    { label: "diff whitespace", argv: ["git", "diff", "HEAD", "--check"] },
  ];
}

export function runCheck(mode: CheckMode): void {
  for (const step of checkPlan(mode)) {
    console.log(`\n=== ${step.label} ===`);
    const result = Bun.spawnSync([...step.argv], {
      cwd: ROOT,
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  }
  console.log(`\n✓ ${mode} contributor check passed`);
}

if (import.meta.main) {
  const argument = process.argv[2];
  if (argument !== undefined && argument !== "--quick") {
    console.error("usage: bun run src/dev/check.ts [--quick]");
    process.exit(2);
  }
  runCheck(argument === "--quick" ? "quick" : "full");
}
