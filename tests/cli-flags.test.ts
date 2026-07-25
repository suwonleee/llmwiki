// CLI flag parsing — guards a silent-failure class, not a crash.
//
// parseArgs decides "does this flag take a value?" from a hand-maintained allowlist. Forget to add
// a flag and nothing breaks loudly: the flag becomes boolean `true`, its value falls through to
// positionals, and the command runs with a default. Two commands shipped that way — `excerpt
// --offset N` minted quotes from byte 0 of a transcript instead of N, and `migrate --map old=new`
// applied no mapping at all. Both printed a normal, successful-looking result.
//
// So the test is deliberately a SOURCE test rather than a behaviour test: the bug is drift between
// the parser declaration and command readers, and only reading that boundary can catch a flag someone adds tomorrow.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MissingCliFlagValueError, parseCliArgs } from "../src/cli-args.ts";

const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
const ARGUMENT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli-args.ts"), "utf8");
const MAINTENANCE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "commands", "maintenance.ts"), "utf8");
const SRC = `${CLI_SOURCE}\n${MAINTENANCE_SOURCE}`;
const ROOT = join(import.meta.dir, "..");

function declaredValueFlags(): Set<string> {
  const block = ARGUMENT_SOURCE.match(/const VALUE_FLAG_NAMES = \[([\s\S]*?)\] as const/);
  if (!block) throw new Error("value flag allowlist not found in cli-args.ts — did parseCliArgs change shape?");
  return new Set(Array.from(block[1]!.matchAll(/"(--[a-z-]+)"/g), (m) => m[1]!));
}

// Flags whose VALUE is read (as opposed to mere presence, e.g. `!!p.flags["--commit"]`).
function valueReadFlags(): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /p\.flags\["(--[a-z-]+)"\]\s*(?:\?\?[^)]*?)?\s*as string/g, // ... as string
    /String\(p\.flags\["(--[a-z-]+)"\]/g, // String(...)
    /parseInt\(p\.flags\["(--[a-z-]+)"\]/g, // parseInt(...)
    /getFlagValue\(args, "(--[a-z-]+)"\)/g,
  ];
  for (const re of patterns) for (const m of SRC.matchAll(re)) out.add(m[1]!);
  return out;
}

describe("cli flag allowlist", () => {
  test("prints the established command list when help is requested", () => {
    // Given: the real executable entrypoint in the repository root.
    // When: a caller asks for CLI help.
    const result = Bun.spawnSync([process.execPath, "src/cli.ts", "--help"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Then: help succeeds and advertises an existing public command.
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain("commands:");
    expect(new TextDecoder().decode(result.stdout)).toContain("excerpt");
  });

  test("delegates argument parsing to the typed CLI boundary", () => {
    expect(CLI_SOURCE).toContain('import { MissingCliFlagValueError, parseCliArgs, type ParsedCliArgs as Parsed } from "./cli-args.ts";');
    expect(CLI_SOURCE).not.toMatch(/function parseArgs\(/);
  });

  test("registers maintenance commands through their focused boundary", () => {
    expect(CLI_SOURCE).toContain('import { createMaintenanceHandlers } from "./commands/maintenance.ts";');
    expect(MAINTENANCE_SOURCE).toContain("export function createMaintenanceHandlers");
    expect(CLI_SOURCE).not.toMatch(/function cmdMigrate\(/);
  });

  test("rejects a value flag with no value", () => {
    expect(() => parseCliArgs(["turn-context", "--prompt"])).toThrow(MissingCliFlagValueError);
  });

  test("every flag read as a value is declared as a value flag", () => {
    const declared = declaredValueFlags();
    const missing = [...valueReadFlags()].filter((f) => !declared.has(f)).sort();

    // A miss here means that flag silently parses as `true` and its argument becomes a positional.
    expect(missing).toEqual([]);
  });

  test("the two flags that actually regressed stay declared", () => {
    const declared = declaredValueFlags();
    expect(declared.has("--offset")).toBe(true); // excerpt: quoted from byte 0, not the watermark
    expect(declared.has("--map")).toBe(true); // migrate: applied no old=new mapping
  });

  test("the guard can actually fail (it is reading real source, not an empty string)", () => {
    expect(CLI_SOURCE.length).toBeGreaterThan(1000);
    expect(declaredValueFlags().size).toBeGreaterThan(5);
    expect(valueReadFlags().size).toBeGreaterThan(5);
  });
});
