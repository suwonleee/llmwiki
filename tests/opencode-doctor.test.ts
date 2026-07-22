import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOpenCodeInstall } from "../src/engine/doctor.ts";

const ROOT = join(import.meta.dir, "..");
const COMMANDS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz"] as const;

describe("OpenCode doctor status", () => {
  let dir: string;
  let home: string;
  let configRoot: string;
  let opencodeRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-opencode-doctor-"));
    home = join(dir, "home");
    configRoot = join(dir, "config");
    opencodeRoot = join(configRoot, "opencode");
    mkdirSync(join(opencodeRoot, "plugin"), { recursive: true });
    mkdirSync(join(opencodeRoot, "commands"), { recursive: true });
    const pluginSource = join(ROOT, "adapters", "opencode", "llmwiki.ts");
    const pluginHash = createHash("sha256").update(readFileSync(pluginSource)).digest("hex");
    writeFileSync(
      join(opencodeRoot, "plugin", "llmwiki.ts"),
      `// llmwiki-opencode-managed root=${ROOT} source_sha256=${pluginHash}\n`,
    );
    for (const name of COMMANDS) {
      const source = join(ROOT, "skill", `${name}.md`);
      const hash = createHash("sha256").update(readFileSync(source)).digest("hex");
      writeFileSync(
        join(opencodeRoot, "commands", `${name}.md`),
        `---\ndescription: test\n---\n<!-- llmwiki-opencode-managed root=${ROOT} source_sha256=${hash} -->\n`,
      );
    }
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "llmwiki"), `#!/bin/sh\n# llmwiki launcher\n# ${ROOT}\n`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("recognizes a current plugin, commands, and launcher", () => {
    const status = inspectOpenCodeInstall(configRoot, home);
    expect(status.plugin).toBe("current");
    expect(status.missingCommands).toEqual([]);
    expect(status.staleCommands).toEqual([]);
    expect(status.launcher).toBe("managed");
  });

  test("detects stale command content", () => {
    writeFileSync(
      join(opencodeRoot, "commands", "wiki-save.md"),
      "---\ndescription: stale\n---\n<!-- llmwiki-opencode-managed root=old source_sha256=old -->\n",
    );

    expect(inspectOpenCodeInstall(configRoot, home).staleCommands).toEqual(["wiki-save"]);
  });

  test("classifies the pre-installer plugin as stale instead of current", () => {
    writeFileSync(
      join(opencodeRoot, "plugin", "llmwiki.ts"),
      "// llmwiki OpenCode plugin\nconst ROOT = process.env.LLMWIKI_ROOT ?? '/old';\n",
    );

    expect(inspectOpenCodeInstall(configRoot, home).plugin).toBe("stale");
  });
});
