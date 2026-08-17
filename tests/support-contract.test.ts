import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PLATFORM_IDS = ["macos", "linux", "windows-native", "windows-wsl2"] as const;
const HARNESS_IDS = ["claude", "codex", "opencode"] as const;

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

type PlatformSupport = {
  installation: "supported";
  setup_shell: "posix" | "git-bash" | "posix-wsl2";
  daemon: "launchd" | "systemd-or-cron-nohup" | "per-user-startup-folder";
  ci: "full-suite" | "platform-contract" | "linux-suite";
};

type MatrixCell = {
  install: string;
  verify: string;
  init: string;
  manual_actions: string[];
  public_surfaces: string[];
};

type SupportContract = {
  contract_version: number;
  runtime: { bun_minimum: string; git_required_for_capture: boolean };
  harness_compatibility: Record<
    string,
    {
      policy: string;
      install_probes: string[];
      installed_surface_canary: string;
      verified_projection?: string;
      poll_revision_fallbacks?: string[];
    }
  >;
  platforms: Record<string, PlatformSupport>;
  support_matrix: Record<string, Record<string, MatrixCell>>;
  manual_actions: Record<string, string[]>;
  privacy: {
    local_first: boolean;
    project_enrollment_required: boolean;
    generative_subprocess_opt_in_env: string;
    transcript_store_access: string;
    managed_configuration_writes: {
      allowed: boolean;
      scope: string;
      preserve_unrelated_configuration: boolean;
    };
  };
};

function contract(): SupportContract {
  return JSON.parse(read("reference/support-contract.json")) as SupportContract;
}

function setupSupportTable(markdown: string): Record<string, PlatformSupport> {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) =>
    /^\|\s*contract target\s*\|\s*installation\s*\|\s*setup shell\s*\|\s*daemon\s*\|\s*CI evidence\s*\|$/.test(line),
  );
  if (header < 0) throw new Error("setup_text.md has no public support table");
  const rows: Record<string, PlatformSupport> = {};
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim().replace(/^`|`$/g, ""));
    if (cells.length !== 5) throw new Error(`invalid support row: ${line}`);
    const [target, installation, setup_shell, daemon, ci] = cells;
    rows[target!] = { installation, setup_shell, daemon, ci } as PlatformSupport;
  }
  return rows;
}

function harnessSection(markdown: string, harness: string): string {
  const headings: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
  const start = markdown.indexOf(`## ${headings[harness]}`);
  if (start < 0) throw new Error(`missing ${harness} section`);
  const end = markdown.indexOf("\n## ", start + 4);
  return markdown.slice(start, end < 0 ? undefined : end);
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`missing ${heading} section`);
  const end = markdown.indexOf("\n## ", start + 4);
  return markdown.slice(start, end < 0 ? undefined : end);
}

function nestedBullets(section: string, label: string): string[] {
  const lines = section.split(/\r?\n/);
  const start = lines.indexOf(`- ${label}`);
  if (start < 0) throw new Error(`missing ${label}`);
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("    - ")) bullets.push(line.slice(6));
    else if (line.startsWith("- ") || line.startsWith("## ")) break;
  }
  return bullets;
}

function commandAfter(section: string, label: string): string {
  const [command] = nestedBullets(section, label);
  if (!command) throw new Error(`missing command after ${label}`);
  return command.replace(/^`|`$/g, "").replaceAll('"<absolute-project-path>"', "<absolute-project-path>")
    .replaceAll('"<absolute-clone-path>/src/cli.ts"', "<absolute-clone-path>/src/cli.ts");
}

function surfaceIds(section: string): string[] {
  const ids: string[] = [];
  for (const line of nestedBullets(section, "Installed surfaces")) {
    if (line === "Local capture daemon") ids.push("capture-daemon");
    if (line.includes("`SessionStart` and `UserPromptSubmit` hooks")) ids.push("sessionstart-hook", "userpromptsubmit-hook");
    if (line.includes("read-injection plugin")) ids.push("read-injection-plugin");
    if (line.includes("`$wiki-save`")) ids.push("wiki-skills");
    if (line.includes("`/wiki-save`")) ids.push("wiki-commands");
    if (line.includes("User-level `llmwiki` launcher")) ids.push("user-launcher");
  }
  return ids;
}

describe("public machine-readable support contract", () => {
  test("has a complete OS by harness command/action/surface matrix", () => {
    const value = contract();
    expect(value.contract_version).toBe(3);
    expect(Object.keys(value.platforms).sort()).toEqual(PLATFORM_IDS.slice().sort());
    expect(Object.keys(value.support_matrix).sort()).toEqual(PLATFORM_IDS.slice().sort());
    for (const platform of PLATFORM_IDS) {
      expect(Object.keys(value.support_matrix[platform]!).sort()).toEqual(HARNESS_IDS.slice().sort());
      for (const harness of HARNESS_IDS) {
        const cell = value.support_matrix[platform]![harness]!;
        expect(cell.install).toBe(`./setup.sh --harness ${harness}`);
        expect(cell.verify).toMatch(new RegExp(`doctor --harness ${harness}$`));
        expect(cell.init).toMatch(/ init <absolute-project-path>$/);
        expect(cell.public_surfaces).toContain("capture-daemon");
        expect(cell.manual_actions).toEqual(harness === "codex" ? ["codex-hook-trust"] : harness === "opencode" ? ["opencode-restart"] : []);
      }
    }
  });

  test("pins capability probes, executable canaries, and OpenCode schema fallback policy", () => {
    const value = contract();
    expect(Object.keys(value.harness_compatibility).sort()).toEqual(HARNESS_IDS.slice().sort());
    expect(value.harness_compatibility.claude).toMatchObject({
      policy: "capability-gated",
      install_probes: ["cli-present"],
      installed_surface_canary: "fresh-public-loop",
    });
    expect(value.harness_compatibility.codex).toMatchObject({
      install_probes: ["hook-trust-cli", "stable-hooks-feature"],
      installed_surface_canary: "fresh-public-harness-loop",
    });
    expect(value.harness_compatibility.opencode).toMatchObject({
      policy: "capability-and-schema-gated",
      install_probes: ["custom-command-cli"],
      installed_surface_canary: "fresh-public-harness-loop",
      verified_projection: "1.18.4-message-part",
      poll_revision_fallbacks: ["session-time-updated", "message-part-metadata", "conservative-materialization"],
    });

    const setup = read("setup.sh");
    expect(setup).toContain("command -v claude");
    expect(setup).toContain("--dangerously-bypass-hook-trust");
    expect(setup).toContain("codex features list");
    expect(setup).toContain("opencode run --help");
    expect(read("tests/fresh-public-loop.test.ts")).toContain("SessionStart");
    expect(read("tests/fresh-public-harness-loop.test.ts")).toContain("experimental.chat.system.transform");
  });

  test("keeps setup_text platform rows and installation-flow harness claims equal to the JSON contract", () => {
    const value = contract();
    expect(setupSupportTable(read("setup_text.md"))).toEqual(value.platforms);
    const flow = read("reference/INSTALLATION_FLOW.md");
    for (const harness of HARNESS_IDS) {
      const section = harnessSection(flow, harness);
      const posix = value.support_matrix.macos![harness]!;
      expect({
        install: commandAfter(section, "Install"),
        verify: commandAfter(section, "Verify"),
        init: commandAfter(section, "Initialize a project"),
      }).toEqual({ install: posix.install, verify: posix.verify, init: posix.init });
      expect(surfaceIds(section)).toEqual(posix.public_surfaces);

      const native = value.support_matrix["windows-native"]![harness]!;
      const expectedNativeSurfaces = posix.public_surfaces.map((surface) =>
        surface === "user-launcher" ? "git-bash-launcher" : surface,
      );
      expect(native.public_surfaces).toEqual(expectedNativeSurfaces);
      expect(native.verify.startsWith("bun <absolute-clone-path>/src/cli.ts")).toBe(true);
      expect(native.init.startsWith("bun <absolute-clone-path>/src/cli.ts")).toBe(true);
    }
  });

  test("keeps manual-action catalogs equal to public flow and setup output", () => {
    const value = contract();
    const flow = read("reference/INSTALLATION_FLOW.md");
    expect(nestedBullets(harnessSection(flow, "codex"), "Required manual activation")).toEqual(
      value.manual_actions["codex-hook-trust"],
    );
    expect(nestedBullets(harnessSection(flow, "opencode"), "Activation")).toEqual(
      value.manual_actions["opencode-restart"],
    );
    const setup = read("setup.sh");
    expect(setup).toMatch(/One-time Codex activation:.*\/hooks.*trust both llmwiki hooks/);
    expect(setup).toMatch(/OpenCode activation: restart OpenCode after initial setup or clone re-pointing/);
  });

  test("matches runtime metadata, checked platform mechanisms, and bounded privacy writes", () => {
    const value = contract();
    const pkg = JSON.parse(read("package.json")) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(`>=${value.runtime.bun_minimum}`);
    expect(value.privacy).toEqual({
      local_first: true,
      project_enrollment_required: true,
      generative_subprocess_opt_in_env: "LLMWIKI_LLM_CMD",
      transcript_store_access: "read-only",
      managed_configuration_writes: {
        allowed: true,
        scope: "llmwiki-owned hooks, plugins, commands, skills, launchers, and service definitions",
        preserve_unrelated_configuration: true,
      },
    });
    const installer = read("daemon/install.sh");
    const workflow = read(".github/workflows/ci.yml");
    expect(installer).toMatch(/MINGW\*\|MSYS\*\|CYGWIN\*/);
    expect(installer).toMatch(/STARTUP_DIR=.*Start Menu\/Programs\/Startup/);
    expect(workflow).toMatch(/^  windows:\n(?:^[ \t].*\n)*?    name: windows-latest · platform contract$/m);
    expect(read("setup_text.md")).toMatch(/Do not overwrite unrelated user configuration/);
  });

  test("publishes native-Windows Bun setup without retired service instructions in every language", () => {
    for (const path of ["readmes/README.ja.md", "readmes/README.zh.md"]) {
      expect(read(path)).toContain("irm bun.sh/install.ps1 \\| iex");
    }
    for (const path of ["setup_text.md", "reference/INSTALLATION_FLOW.md", "README.md", "readmes/README.ko.md", "readmes/README.ja.md", "readmes/README.zh.md"]) {
      const content = read(path);
      expect(content).not.toMatch(/Do not attempt a native-Windows install/i);
      expect(content).not.toMatch(/native Windows.*(?:Task Scheduler|NSSM).*manual/i);
      expect(content).not.toMatch(/ネイティブWindows.*(?:Task Scheduler|NSSM).*手動/);
      expect(content).not.toMatch(/原生 Windows.*(?:Task Scheduler|NSSM).*手动/);
    }
  });

  test("keeps every README manual fallback aligned with native-Windows commands and OpenCode restart", () => {
    const value = contract();
    for (const harness of HARNESS_IDS) {
      const native = value.support_matrix["windows-native"]![harness]!;
      expect(native.verify.startsWith("bun <absolute-clone-path>/src/cli.ts")).toBe(true);
      expect(native.init.startsWith("bun <absolute-clone-path>/src/cli.ts")).toBe(true);
    }

    const localized = [
      { path: "README.md", heading: "Manual fallback", native: /Native Windows, every harness: explicit `bun <clone>\/src\/cli\.ts …`/, restart: /OpenCode: restart it after initial setup or clone re-pointing/ },
      { path: "readmes/README.ko.md", heading: "수동 설치 대안", native: /네이티브 Windows의 모든 하네스: 명시적 `bun <clone>\/src\/cli\.ts …`/, restart: /OpenCode: 최초 설치 또는 clone 경로 변경 후 재시작/ },
      { path: "readmes/README.ja.md", heading: "手動インストールの代替", native: /ネイティブWindowsの全ハーネス: 明示的な `bun <clone>\/src\/cli\.ts …`/, restart: /OpenCode: 初回セットアップまたはclone再指定後に再起動/ },
      { path: "readmes/README.zh.md", heading: "手动安装备选", native: /原生 Windows 的所有harness: 显式使用 `bun <clone>\/src\/cli\.ts …`/, restart: /OpenCode: 初次setup或clone重新指向后重启/ },
    ];
    for (const item of localized) {
      const fallback = markdownSection(read(item.path), item.heading);
      expect(fallback).toMatch(item.native);
      expect(fallback).toMatch(item.restart);
      expect(fallback).toContain("PowerShell");
      expect(fallback).toContain("WSL2");
    }
  });
});
