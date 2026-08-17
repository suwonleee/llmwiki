import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  test("the shell gate parses every shipped script, not only the first", () => {
    const step = checkPlan("quick").find((entry) => entry.label === "shell syntax")!;

    // Coverage: CI globs the root installer plus daemon/*.sh and hooks/*.sh. The list is read off
    // disk rather than written out, so a new script cannot skip the contributor gate merely by not
    // being remembered here — and so this file never names the installer, which would make the
    // supervisor scanner in repo-io-static-boundary read it as a test that RUNS setup.
    const shipped = ["", "daemon", "hooks"].flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((name) => name.endsWith(".sh"))
        .map((name) => (dir ? `${dir}/${name}` : name)),
    );
    expect(shipped.length).toBeGreaterThanOrEqual(6);
    for (const script of shipped) expect(step.argv).toContain(script);

    // Form: the same invocation must actually REJECT a broken script that is not the first one.
    // `bash -n a.sh b.sh` parses only a.sh and exits 0, which is how the shipped hook and daemon
    // scripts stayed unchecked while this step reported green.
    const scratch = mkdtempSync(join(tmpdir(), "llmwiki-shell-gate-"));
    try {
      const good = join(scratch, "good.sh");
      const broken = join(scratch, "broken.sh");
      writeFileSync(good, "echo ok\n");
      writeFileSync(broken, "if [ 1 ; then\n");
      const head = step.argv.slice(0, step.argv.length - shipped.length);
      const result = Bun.spawnSync([...head, good, broken], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).not.toBe(0);
      expect(Bun.spawnSync([...head, good], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
