import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PATH = join(ROOT, "reference", "RELEASE_GATES.md");

function read(): string {
  return readFileSync(PATH, "utf8");
}

function gateRows(markdown: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^\| `([^`]+)` \| `([^`]+)` \|/);
    if (match) rows[match[1]!] = match[2]!;
  }
  return rows;
}

describe("public evaluation and release gates", () => {
  test("maps every completed and deferred gate to an explicit disposition", () => {
    expect(gateRows(read())).toEqual({
      "support-contract": "automated-pass-required",
      "full-loop-oracle": "automated-pass-required",
      "retrieval-baseline": "automated-pass-required",
      "retrieval-scale": "automated-pass-required",
      "privacy-boundary": "automated-pass-required",
      "docs-semantics": "automated-pass-required",
      "external-usability": "external-evidence-required",
    });
  });

  test("references runnable tracked evidence for every automated gate", () => {
    const markdown = read();
    const commands = [...markdown.matchAll(/`(bun test [^`]+|bun run typecheck|git diff --check)`/g)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const command of commands.filter((value) => value.startsWith("bun test "))) {
      for (const path of command.split(/\s+/).slice(2)) {
        expect(existsSync(join(ROOT, path)), `${path} referenced by ${command}`).toBe(true);
      }
    }
    for (const required of [
      "tests/support-contract.test.ts",
      "tests/fresh-public-loop.test.ts",
      "tests/bench-baseline.test.ts",
      "tests/bench-scale.test.ts",
      "tests/usability-study-validator.test.ts",
      "tests/onboarding-docs.test.ts",
      "tests/release-boundary.test.ts",
    ]) expect(markdown).toContain(required);
    expect(markdown).toContain("`bun src/plugin/preflight.ts`");
  });

  test("keeps external conclusions deferred until valid participant evidence exists", () => {
    const markdown = read();
    expect(markdown).toContain("Status for this release artifact: `deferred-no-results`");
    expect(markdown).toContain("No external results means no winner claim and no IA");
    expect(markdown).toContain("retain the current IA");
    expect(markdown).not.toMatch(/observed users (?:proved|preferred|selected)/i);
    expect(markdown).not.toMatch(/(?:agent-guided|manual-fallback) (?:wins|won|is superior)/i);
  });

  test("records the exact external study thresholds without turning them into automated claims", () => {
    const markdown = read();
    expect(markdown).toContain("at least 15 valid completed comparative runs per arm/cell");
    expect(markdown).toContain("≥80% unaided full");
    expect(markdown).toContain("median first value ≤20 minutes");
    expect(markdown).toContain("nearest-rank p90 ≤30 minutes excluding prerequisites");
    expect(markdown).toContain("median wrong-command count ≤1");
    expect(markdown).toContain("≥80% correctness for every comprehension item");
  });
});
