// The plugin distribution surface: manifests, hooks config, generated skills. These are the files
// a marketplace reviewer and two harness loaders see first, so the guards here are the rejection
// checklist made executable — version sync, no leaked personal paths, sources-in-sync, hook
// scripts that actually exist and execute.
import { describe, expect, test } from "bun:test";
import { accessSync, constants, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLONE_ROOT } from "../src/engine/paths.ts";
import { CLAUDE_COMMANDS } from "../src/engine/claude-commands.ts";
import { buildAssets } from "../src/plugin/build-assets.ts";
import { classify, isPrivate, trackedFiles } from "../src/plugin/preflight.ts";
import { git, makeGitRepo, tempDir } from "./support/git-repo.ts";

const SKILLS = CLAUDE_COMMANDS.map((n) => n.replace(/\.md$/, ""));

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(CLONE_ROOT, rel), "utf-8"));
}

describe("plugin distribution surface", () => {
  test("one version across package.json, both plugin manifests and the marketplace entry", () => {
    // `claude plugin tag` refuses to tag a release unless plugin.json and the enclosing
    // marketplace entry agree, so a drift here is a release blocker, not a cosmetic issue.
    // The Codex manifest matters just as much: measured, Codex reads .codex-plugin/plugin.json
    // in preference to the Claude one (a 9.9.9 there installed as 9.9.9), so a drift would ship
    // two different versions of the same plugin depending on which harness installed it.
    const plugin = readJson(".claude-plugin/plugin.json");
    const codex = readJson(".codex-plugin/plugin.json");
    const marketplace = readJson(".claude-plugin/marketplace.json");
    const pkg = readJson("package.json");
    const entry = marketplace.plugins.find((p: any) => p.name === plugin.name);
    expect(plugin.name).toBe("llmwiki");
    expect(codex.name).toBe(plugin.name);
    expect(entry, "marketplace has no entry for this plugin").toBeDefined();
    expect(plugin.version).toBe(pkg.version);
    expect(codex.version).toBe(pkg.version);
    expect(entry.version).toBe(pkg.version);
    expect(marketplace.metadata?.version).toBe(pkg.version);
  });

  test("the Codex manifest carries the interface block its UI renders", () => {
    // Without `interface`, Codex shows defaults where the sibling projects (oh-my-codex,
    // oh-my-opencode) show a name, a one-liner and a description.
    const codex = readJson(".codex-plugin/plugin.json");
    for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
      expect(codex.interface?.[field], `interface.${field} missing`).toBeTruthy();
    }
    expect(codex.skills).toBe("./skills/");
    expect(codex.hooks).toBe("./hooks/hooks.codex.json"); // its own hook config — see the spill test
  });

  test("the manifests declare their component paths, and those paths exist", () => {
    // Auto-discovery works, but declaring the paths keeps the shipped inventory deterministic
    // (measured: Skills 5 / Hooks 2) instead of dependent on what happens to sit in the tree.
    const plugin = readJson(".claude-plugin/plugin.json");
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.hooks).toBe("./hooks/hooks.json");
    for (const rel of ["skills", "hooks/hooks.json"]) accessSync(join(CLONE_ROOT, rel));
  });

  test("distributed files leak no personal or machine paths", () => {
    const files = [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "hooks/hooks.json",
      ...SKILLS.map((s) => `skills/${s}/SKILL.md`),
    ];
    for (const rel of files) {
      const text = readFileSync(join(CLONE_ROOT, rel), "utf-8");
      expect(text.includes("/Users/"), `${rel} carries a personal path`).toBe(false);
      expect(text.includes(CLONE_ROOT), `${rel} carries this clone's path`).toBe(false);
    }
  });

  test("committed skills are exactly what build-assets renders from skill/ (no drift)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "llmwiki-plugin-build-"));
    cpSync(join(CLONE_ROOT, "skill"), join(tmp, "skill"), { recursive: true });
    buildAssets(tmp);
    for (const s of SKILLS) {
      const rendered = readFileSync(join(tmp, "skills", s, "SKILL.md"), "utf-8");
      const committed = readFileSync(join(CLONE_ROOT, "skills", s, "SKILL.md"), "utf-8");
      expect(committed, `skills/${s}/SKILL.md drifted — re-run bun src/plugin/build-assets.ts`).toBe(rendered);
    }
  });

  test("every skill has name + description frontmatter and the plugin-root resolution rule", () => {
    for (const s of SKILLS) {
      const text = readFileSync(join(CLONE_ROOT, "skills", s, "SKILL.md"), "utf-8");
      expect(text.startsWith(`---\nname: ${s}\n`)).toBe(true);
      expect(text).toContain("description:");
      expect(text).toContain('bun "<plugin-root>/src/cli.ts"');
      // The clone-form invocation must be gone: a plugin copy has no ~/llmwiki.
      expect(text.includes("bun ~/llmwiki/src/cli.ts")).toBe(false);
    }
  });

  test("publish preflight blocks the private surface and allows its one exception", () => {
    // Installing from a git marketplace copies the TRACKED tree, so `git ls-files` is the
    // shipping manifest and publishing from the wrong clone would hand every user this
    // project's working wiki.
    expect(isPrivate("docs/wiki/5_topic/x.md")).toBe(true);
    expect(isPrivate("docs/eval-results/goldens.tsv")).toBe(true);
    expect(isPrivate("githooks/pre-push")).toBe(true);
    expect(isPrivate(".mailmap")).toBe(true);
    expect(isPrivate("experiments/build-commit-golden.ts")).toBe(true);
    expect(isPrivate("configs/team-balcony.toml")).toBe(true);
    expect(isPrivate("reference/notes.md")).toBe(true);
    expect(isPrivate("reference/INSTALLATION_FLOW.md")).toBe(false); // the shipped contract
    expect(isPrivate("src/cli.ts")).toBe(false);
    expect(isPrivate("skills/wiki-save/SKILL.md")).toBe(false);
  });

  test("preflight reports what a fixture repo would ship, and why it would fail", () => {
    const repo = makeGitRepo(tempDir("llmwiki-preflight-"));
    const write = (rel: string, body: string) => {
      const full = join(repo, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    };
    write("src/cli.ts", "// engine\n");
    write("package.json", JSON.stringify({ name: "llmwiki", version: "9.9.9" }));
    write(".claude-plugin/plugin.json", JSON.stringify({ name: "llmwiki", version: "0.0.1" }));
    write("docs/wiki/5_topic/private.md", "secret working notes\n");
    write("tests/big.test.ts", "x".repeat(4096));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "fixture"]);

    const r = classify(repo, trackedFiles(repo));
    expect(r.privateHits).toEqual(["docs/wiki/5_topic/private.md"]);
    // Required plugin files that are absent are named, not silently tolerated.
    expect(r.missing).toContain(".claude-plugin/marketplace.json");
    expect(r.missing).toContain("hooks/hooks.json");
    expect(r.missing).not.toContain("src/cli.ts");
    // A version drift between package.json and the manifest is caught before it ships.
    expect(r.versionMismatch).toContain("9.9.9");
    // Dead weight is measured, not fatal.
    expect(r.deadWeight.find((d) => d.prefix.startsWith("tests"))?.bytes).toBeGreaterThan(4000);
    expect(r.files).toBe(5);
  });

  test("both hook configs point at scripts that exist, execute, and take no absolute path", () => {
    // Codex exports CLAUDE_PLUGIN_ROOT alongside its own PLUGIN_ROOT
    // (codex-rs/hooks/src/engine/discovery.rs), so one spelling serves both harnesses.
    for (const rel of ["hooks/hooks.json", "hooks/hooks.codex.json"]) {
      const cfg = readJson(rel);
      const entries = [...(cfg.hooks.SessionStart ?? []), ...(cfg.hooks.UserPromptSubmit ?? [])]
        .flatMap((m: any) => m.hooks ?? []);
      expect(entries.length, `${rel} should wire exactly two hooks`).toBe(2);
      for (const h of entries) {
        expect(h.type).toBe("command");
        const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?)"/.exec(h.command);
        expect(m, `hook command must resolve under CLAUDE_PLUGIN_ROOT: ${h.command}`).not.toBeNull();
        accessSync(join(CLONE_ROOT, m![1]!), constants.X_OK); // exists AND executable
      }
    }
  });

  test("the Codex hook config disables the stdout spill the Claude one cannot declare", () => {
    // Codex replaces hook output over ~10,000 bytes with a head/tail preview; a large cold start
    // would silently arrive truncated. `additionalContextLimit: 0` opts out — and it lives in a
    // separate file because Claude's --strict validation rejects fields it does not know.
    const codex = readJson("hooks/hooks.codex.json");
    const entries = [...codex.hooks.SessionStart, ...codex.hooks.UserPromptSubmit].flatMap((m: any) => m.hooks);
    for (const h of entries) expect(h.additionalContextLimit).toBe(0);
    expect(readJson(".codex-plugin/plugin.json").hooks).toBe("./hooks/hooks.codex.json");
    expect(JSON.stringify(readJson("hooks/hooks.json"))).not.toContain("additionalContextLimit");
  });

  test("the plugin hooks stand down when a clone install is already wired — for BOTH harnesses", () => {
    // Running plugin + clone install together delivered every block twice (measured). The clone
    // wins because it carries the capture daemon; the guard has to know both wiring files.
    for (const script of ["hooks/sessionstart-inject.sh", "hooks/userpromptsubmit-inject.sh"]) {
      const body = readFileSync(join(CLONE_ROOT, script), "utf-8");
      expect(body).toContain("CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json");
      expect(body, `${script} must also detect the Codex clone wiring`).toContain("CODEX_HOME:-$HOME/.codex}/hooks.json");
    }
  });

  test("the disclosure sheet states the facts a reviewer checks", () => {
    const text = readFileSync(join(CLONE_ROOT, "PLUGIN.md"), "utf-8");
    for (const claim of ["zero bytes", "no network requests", "docs/wiki/", "Bun", "stat"]) {
      expect(text, `PLUGIN.md should address: ${claim}`).toContain(claim);
    }
    // Both manifests must point at it, or it is a file nobody finds.
    expect(readJson(".claude-plugin/plugin.json").description).toContain("PLUGIN.md");
    expect(readJson(".codex-plugin/plugin.json").interface.longDescription).toContain("PLUGIN.md");
  });
});
