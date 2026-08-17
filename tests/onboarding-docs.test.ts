import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("public onboarding documentation", () => {
  test("keeps the agent setup contract exact and executable", () => {
    const contract = read("setup_text.md");
    expect(contract).toContain("reference/INSTALLATION_FLOW.md");
    expect(contract).toContain("./setup.sh --dry-run --harness claude");
    expect(contract).toContain("./setup.sh --harness claude");
    expect(contract).toContain("./setup.sh --harness codex");
    expect(contract).toContain("./setup.sh --harness opencode");
    expect(contract).toContain("`llmwiki doctor --harness codex`");
    expect(contract).toContain("`llmwiki doctor --harness opencode`");
    expect(contract).toContain("`llmwiki config <project-path>`");
    expect(contract).toContain("`llmwiki verify <absolute-project-path> --harness <harness>`");
    expect(contract).toContain("Open `/hooks`");
    expect(contract).toContain("`llmwiki wiki-doctor <project-path>`");
    expect(contract).toContain("$wiki-doctor");
    expect(contract).toContain("`$CODEX_HOME/config.toml`");
    expect(contract).toContain("`developer_instructions`");
    expect(contract).toContain("another orchestrator's state");
  });

  test("keeps the README human-first and moves conditional installation detail to the agent flow", () => {
    const readme = read("README.md");
    const flow = read("reference/INSTALLATION_FLOW.md");

    expect(readme).toContain("Read setup_text.md and install llmwiki");
    expect(readme).toContain("reference/INSTALLATION_FLOW.md");
    expect(readme).toContain("stay in the same setup session");
    expect(flow).toContain("Read the shared flow plus the active harness section only");
    expect(flow).toContain("Every harness install includes the same user-level `llmwiki` launcher");
    expect(flow).toContain("`llmwiki doctor --harness codex`");
    expect(flow).toContain("`llmwiki doctor --harness opencode`");
    expect(flow).toContain("Inspect and trust both current llmwiki hook hashes");
    expect(flow).toContain("llmwiki does not edit `$CODEX_HOME/config.toml`");
    expect(flow).toContain("another orchestrator's runtime or preflight state");
    expect(flow).toContain("Restart OpenCode after initial setup or clone re-pointing");
    expect(flow).toContain("Do not migrate automatically");
  });

  test("keeps every README linked to the setup contract and current attribution rule", () => {
    const readmes = [
      ["README.md", "authorship is derived from git history"],
      ["readmes/README.ko.md", "작성자 정보는"],
      ["readmes/README.ja.md", "著者情報は"],
      ["readmes/README.zh.md", "作者信息"],
    ] as const;
    for (const [path, attributionRule] of readmes) {
      const content = read(path);
      expect(content).toContain("setup_text.md");
      expect(content).toContain("INSTALLATION_FLOW.md");
      expect(content).toContain("support-contract.json");
      expect(content).toContain("wiki-doctor");
      expect(content).toContain(attributionRule);
      expect(content).not.toContain("unattended writes stamp `author:`");
      expect(content).not.toContain("무인 작성 페이지에 `author:`");
      expect(content).not.toContain("無人作成ページに `author:`");
      expect(content).not.toContain("无人值守写入的页面自动盖上 `author:`");
    }
  });

  test("every language documents enrollment, unified uninstall, and opt-in generation", () => {
    for (const path of [
      "README.md",
      "readmes/README.ko.md",
      "readmes/README.ja.md",
      "readmes/README.zh.md",
    ]) {
      const content = read(path);
      expect(content).toContain("llmwiki init");
      expect(content).toContain("llmwiki --help");
      expect(content).toContain("llmwiki <command> --help");
      expect(content).toContain("llmwiki --version");
      expect(content).toContain("./setup.sh --uninstall");
      expect(content).toContain("LLMWIKI_LLM_CMD");
      expect(content).toContain("LLMWIKI_STATE_DIR");
      expect(content).toContain("https://github.com/suwonleee/llmwiki/releases");
      expect(content).not.toContain("git checkout <");
    }
  });

  test("keeps retired command names out of current user-facing surfaces", () => {
    const surfaces = [
      "README.md",
      "readmes/README.ko.md",
      "readmes/README.ja.md",
      "readmes/README.zh.md",
      "reference/INSTALLATION_FLOW.md",
      "setup_text.md",
      "skill/wiki-save.md",
      "skill/wiki-deep.md",
    ];
    for (const path of surfaces) expect(read(path)).not.toContain("wiki-fast");
  });
});
