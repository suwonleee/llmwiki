// Which clone paths make the installed harness copies stale (and so the cold-start setup notice
// fire). Pure classification — no git, no installer run.
import { test, expect } from "bun:test";
import { needsSetup } from "../src/engine/update-check.ts";

test("setup inputs: installers and the renderers of installed copies, not the engine running in place", () => {
  for (const path of ["setup.sh", "skill/wiki-save.md", "adapters/opencode/llmwiki.ts", "daemon/install.sh", "package.json",
    "src/daemon/wire-codex.ts", "src/engine/claude-commands.ts", "src/plugin/build-assets.ts"]) {
    expect(`${path}: ${needsSetup(path)}`).toBe(`${path}: true`);
  }
  for (const path of ["hooks/sessionstart-inject.sh", "githooks/pre-push", "src/daemon/watch.ts", "src/engine/lint.ts",
    "tests/lint.test.ts", "docs/x.md", "ARCHITECTURE.md", "skill/ref/topic-page.md"]) {
    expect(`${path}: ${needsSetup(path)}`).toBe(`${path}: false`);
  }
});
