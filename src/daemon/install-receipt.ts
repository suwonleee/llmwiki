// Final setup certificate: only a fully successful setup may record that this clone HEAD owns the
// copied harness surfaces and the restarted daemon. update-check.ts keeps the cold-start reminder
// alive after `git pull` until this file is refreshed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OWNED_MARK } from "../engine/claude-commands.ts";
import { envValueOutsideRepoFiles } from "../engine/env-policy.ts";
import { claudeConfigDirs } from "../engine/sources/claude.ts";
import { INSTALL_COMPONENTS, recordInstallReceipt, type InstallComponent } from "../engine/update-check.ts";

function contains(path: string, marker: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(marker);
  } catch {
    return false;
  }
}

/** Discover pre-receipt installs so a first partial upgrade cannot certify their stale copies. */
function managedHarnesses(): InstallComponent[] {
  const home = process.env.HOME?.trim() || homedir();
  const found: InstallComponent[] = [];
  if (
    contains(join(home, ".agents", "skills", "wiki-save", "SKILL.md"), "llmwiki-codex-managed") ||
    contains(join(envValueOutsideRepoFiles("CODEX_HOME")?.trim() || join(home, ".codex"), "hooks.json"), "llmwiki")
  ) {
    found.push("codex");
  }
  if (
    claudeConfigDirs(home).some((profile) =>
      contains(join(profile, "commands", "wiki-save.md"), OWNED_MARK),
    )
  ) {
    found.push("claude");
  }
  const configRoot = envValueOutsideRepoFiles("XDG_CONFIG_HOME")?.trim() || join(home, ".config");
  if (
    contains(join(configRoot, "opencode", "plugin", "llmwiki.ts"), "llmwiki-opencode-managed") ||
    contains(join(configRoot, "opencode", "commands", "wiki-save.md"), "llmwiki-opencode-managed")
  ) {
    found.push("opencode");
  }
  return found;
}

const flags = process.argv.slice(2);
if (flags.length !== 3 || flags.some((flag) => flag !== "0" && flag !== "1")) {
  console.error("usage: install-receipt.ts <codex:0|1> <claude:0|1> <opencode:0|1>");
  process.exit(2);
}
const selected: InstallComponent[] = ["common"];
for (const [index, component] of (["codex", "claude", "opencode"] as const).entries()) {
  if (flags[index] === "1") selected.push(component);
}
if (
  selected.some((component) => !INSTALL_COMPONENTS.includes(component)) ||
  !recordInstallReceipt(undefined, undefined, selected, managedHarnesses())
) {
  console.error("🔴 failed to record the installed llmwiki revision; setup remains incomplete");
  process.exit(1);
}

console.log(`  [install] ✅ recorded this revision for: ${selected.join(", ")}`);
