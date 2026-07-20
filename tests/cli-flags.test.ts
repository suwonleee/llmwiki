// CLI flag parsing — guards a silent-failure class, not a crash.
//
// parseArgs decides "does this flag take a value?" from a hand-maintained allowlist. Forget to add
// a flag and nothing breaks loudly: the flag becomes boolean `true`, its value falls through to
// positionals, and the command runs with a default. Two commands shipped that way — `excerpt
// --offset N` minted quotes from byte 0 of a transcript instead of N, and `migrate --map old=new`
// applied no mapping at all. Both printed a normal, successful-looking result.
//
// So the test is deliberately a SOURCE test rather than a behaviour test: the bug is drift between
// two places in one file, and only reading the file can catch a flag someone adds tomorrow.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");

function declaredValueFlags(): Set<string> {
  const block = SRC.match(/const valueFlags = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("valueFlags allowlist not found in cli.ts — did parseArgs change shape?");
  return new Set(Array.from(block[1]!.matchAll(/"(--[a-z-]+)"/g), (m) => m[1]!));
}

// Flags whose VALUE is read (as opposed to mere presence, e.g. `!!p.flags["--commit"]`).
function valueReadFlags(): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /p\.flags\["(--[a-z-]+)"\]\s*(?:\?\?[^)]*?)?\s*as string/g, // ... as string
    /String\(p\.flags\["(--[a-z-]+)"\]/g, // String(...)
    /parseInt\(p\.flags\["(--[a-z-]+)"\]/g, // parseInt(...)
  ];
  for (const re of patterns) for (const m of SRC.matchAll(re)) out.add(m[1]!);
  return out;
}

describe("cli flag allowlist", () => {
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
    expect(SRC.length).toBeGreaterThan(1000);
    expect(declaredValueFlags().size).toBeGreaterThan(5);
    expect(valueReadFlags().size).toBeGreaterThan(5);
  });
});
