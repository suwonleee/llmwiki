import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPlan } from "../src/dev/check.ts";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("contributor entry contract", () => {
  test("links the contributor and architecture guides from the public entry point", () => {
    const readme = read("README.md");
    const contributing = read("CONTRIBUTING.md");
    const architecture = read("ARCHITECTURE.md");

    expect(readme).toContain("CONTRIBUTING.md");
    expect(contributing).toContain("ARCHITECTURE.md");
    expect(contributing).toContain("reference/RELEASE_GATES.md");
    expect(contributing).toContain("SUPPORT.md");
    expect(architecture).toContain("src/engine/repo-write.ts");
    expect(architecture).toContain("src/commands/catalog.ts");
  });

  test("documents the generated skill boundary and its deterministic rebuild", () => {
    const contributing = read("CONTRIBUTING.md");
    expect(contributing).toContain("`skill/*.md` is the source");
    expect(contributing).toContain("`skills/*/SKILL.md` is generated");
    expect(contributing).toContain("bun src/plugin/build-assets.ts");
  });

  test("exposes quick and full checks through package scripts", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:quick"]).toBe("bun run src/dev/check.ts --quick");
    expect(pkg.scripts.check).toBe("bun run src/dev/check.ts");
  });

  test("keeps both check plans explicit and fail-fast", () => {
    const quick = checkPlan("quick");
    const full = checkPlan("full");

    expect(quick.map((step) => step.label)).toEqual([
      "typecheck",
      "focused tests",
      "shell syntax",
      "publish boundary",
      "diff whitespace",
    ]);
    expect(full.map((step) => step.label)).toEqual([
      "typecheck",
      "full test suite",
      "shell syntax",
      "publish boundary",
      "diff whitespace",
    ]);
    expect(quick.find((step) => step.label === "focused tests")?.argv).toContain(
      "tests/contributor-docs.test.ts",
    );
    expect(full.find((step) => step.label === "full test suite")?.argv).toEqual([
      process.execPath,
      "test",
    ]);
  });
});
