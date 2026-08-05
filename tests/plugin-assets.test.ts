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

  test("the Codex manifest satisfies the public directory listing contract", () => {
    // Without `interface`, Codex shows defaults where the sibling projects (oh-my-codex,
    // oh-my-opencode) show a name, a one-liner and a description.
    const codex = readJson(".codex-plugin/plugin.json");
    for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
      expect(codex.interface?.[field], `interface.${field} missing`).toBeTruthy();
    }
    expect(codex.interface.displayName.length).toBeLessThanOrEqual(30);
    expect(codex.interface.shortDescription.length).toBeLessThanOrEqual(30);
    expect(codex.interface.longDescription.length).toBeLessThanOrEqual(4000);
    expect(codex.interface.capabilities.length).toBeGreaterThan(0);
    expect(codex.interface.defaultPrompt).toHaveLength(3);
    for (const prompt of codex.interface.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128);
    for (const field of ["websiteURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(codex.interface[field]).toStartWith("https://");
    }
    // Raster, not the SVG source: the listing surfaces render a bitmap, and the directory's
    // asset check only requires the file to exist inside the archive.
    for (const field of ["composerIcon", "logo"]) {
      expect(codex.interface[field]).toBe("./assets/llmwiki-plugin.png");
      accessSync(join(CLONE_ROOT, codex.interface[field]));
    }
    expect(codex.skills).toBe("./skills/");
    // The public directory's ingestion schema accepts only name/version/description/skills/apps/
    // mcpServers/interface/author/homepage/repository/license/keywords — a `hooks` key is a
    // rejection at intake (openai/codex plugin-creator validate_plugin.py). Hooks still load:
    // with no `hooks` declared, Codex falls back to the default hooks/hooks.json.
    expect(codex.hooks).toBeUndefined();
    for (const key of Object.keys(codex)) {
      expect(
        ["name", "version", "description", "skills", "apps", "mcpServers", "interface", "author", "homepage", "repository", "license", "keywords"],
        `.codex-plugin/plugin.json field "${key}" is not accepted by directory ingestion`,
      ).toContain(key);
    }
  });

  test("Claude auto-discovers its default hooks exactly once", () => {
    // Claude Code 2.1.220 rejects a manifest that explicitly points at the default
    // hooks/hooks.json because that same file is already auto-discovered.
    const plugin = readJson(".claude-plugin/plugin.json");
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.hooks).toBeUndefined();
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

  test("the resolution rule survives a host that copies skills OUT of the plugin", () => {
    // Claude Code and Codex install the plugin WHOLE, so "two levels up" always lands on the
    // engine. OpenClaw's `skills install`, Hermes, and `npx skills add` copy the skill FOLDER
    // into their own skills root instead — there, step 1 resolves to the host's skills directory
    // and there is no engine. The later steps are what keep those hosts working, and the
    // no-guessing line is what stops a wrong root from writing pages into another repository.
    for (const s of SKILLS) {
      const text = readFileSync(join(CLONE_ROOT, "skills", s, "SKILL.md"), "utf-8");
      const rule = text.slice(0, text.indexOf("\n#")); // the note sits between frontmatter and body
      expect(rule, `skills/${s}: step 1 must stay first`).toContain('1. `bun "<plugin-root>/src/cli.ts"`');
      expect(rule, `skills/${s}: missing LLMWIKI_ROOT fallback`).toContain('`bun "$LLMWIKI_ROOT/src/cli.ts"`');
      expect(rule, `skills/${s}: missing PATH fallback`).toContain("`llmwiki` on PATH");
      expect(rule, `skills/${s}: guessing must be forbidden`).toContain("Do NOT guess a path");
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

  test("the hook config points at scripts that exist, execute, and take no absolute path", () => {
    // Codex exports CLAUDE_PLUGIN_ROOT alongside its own PLUGIN_ROOT
    // (codex-rs/hooks/src/engine/discovery.rs), so one spelling serves both harnesses.
    for (const rel of ["hooks/hooks.json"]) {
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

  test("the shared hook config disables the Codex stdout spill without disturbing Claude", () => {
    // Codex replaces hook output over ~10,000 bytes with a head/tail preview; a large cold start
    // would silently arrive truncated. `additionalContextLimit: 0` opts out. It lives in the
    // SHARED file — the split that used to hold it was removed with the manifest `hooks` key the
    // directory rejects. Measured on Claude Code 2.1.x: both fields are ignored, the hook still
    // runs, and its stdout still reaches the model (probe: a passphrase printed by SessionStart
    // came back in the reply). Neither is a field Claude declares, so re-measure before trusting.
    const cfg = readJson("hooks/hooks.json");
    const entries = [...cfg.hooks.SessionStart, ...cfg.hooks.UserPromptSubmit].flatMap((m: any) => m.hooks);
    for (const h of entries) expect(h.additionalContextLimit).toBe(0);
    // Claude's SessionStart sources include `compact`, which Codex does not emit; the union is a
    // matcher alternation, so the extra branch simply never fires there.
    expect(cfg.hooks.SessionStart[0].matcher).toContain("compact");
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

  test("public submission policy and support pages cover the directory requirements", () => {
    const privacy = readFileSync(join(CLONE_ROOT, "PRIVACY.md"), "utf-8");
    for (const claim of ["Data processed", "Purpose", "Recipients", "Retention", "Your controls"]) {
      expect(privacy).toContain(claim);
    }
    accessSync(join(CLONE_ROOT, "TERMS.md"));
    accessSync(join(CLONE_ROOT, "SUPPORT.md"));
    const submission = readFileSync(join(CLONE_ROOT, "PLUGIN_SUBMISSION.md"), "utf-8");
    expect(submission.match(/^### Positive /gm)).toHaveLength(5);
    expect(submission.match(/^### Negative /gm)).toHaveLength(3);
  });
});
