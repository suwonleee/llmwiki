import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexInstall } from "../src/engine/doctor.ts";

const ROOT = join(import.meta.dir, "..");

describe("Codex doctor status", () => {
  let dir: string;
  let home: string;
  let codexHome: string;
  let hooksPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-codex-doctor-"));
    home = join(dir, "home");
    codexHome = join(dir, "codex");
    hooksPath = join(codexHome, "hooks.json");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "", hooks: [{ type: "command", command: `bash '${ROOT}/hooks/sessionstart-inject.sh'` }] },
          ],
          UserPromptSubmit: [
            { matcher: "", hooks: [{ type: "command", command: `bash '${ROOT}/hooks/userpromptsubmit-inject.sh'` }] },
          ],
        },
      }),
    );
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      const skillDir = join(home, ".agents", "skills", name);
      mkdirSync(skillDir, { recursive: true });
      const hash = createHash("sha256")
        .update(readFileSync(join(ROOT, "skill", `${name}.md`)))
        .digest("hex");
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: test\n---\n<!-- llmwiki-codex-managed root=${ROOT} source_sha256=${hash} -->\n`,
      );
    }
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "llmwiki"), `#!/bin/sh\n# llmwiki launcher\n# ${ROOT}\n`);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an unrelated hook trust record is not accepted", () => {
    writeFileSync(join(codexHome, "config.toml"), '[hooks.state."unrelated-hook"]\ntrusted_hash="x"\n');

    const status = inspectCodexInstall(codexHome, home);

    expect(status.sessionHook).toBe(true);
    expect(status.turnHook).toBe(true);
    expect(status.reviewRecords).toBe(false);
    expect(status.missingSkills).toEqual([]);
    expect(status.staleSkills).toEqual([]);
    expect(status.legacySkills).toEqual([]);
    expect(status.launcher).toBe("managed");
  });

  test("requires review records for both exact llmwiki hook locations", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        `[hooks.state."${hooksPath}:session_start:0:0"]`,
        'trusted_hash="session"',
        `[hooks.state."${hooksPath}:user_prompt_submit:0:0"]`,
        'trusted_hash="turn"',
      ].join("\n"),
    );

    expect(inspectCodexInstall(codexHome, home).reviewRecords).toBe(true);
  });

  test("inspects an explicitly configured launcher directory", () => {
    const customBin = join(dir, "custom-bin");
    mkdirSync(customBin, { recursive: true });
    writeFileSync(join(customBin, "llmwiki"), `#!/bin/sh\n# llmwiki launcher\n# ${ROOT}\n`);

    expect(inspectCodexInstall(codexHome, home, customBin).launcher).toBe("managed");
  });

  test("malformed hook event shapes are reported incomplete instead of crashing", () => {
    writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionStart: { hooks: [] } } }));

    const status = inspectCodexInstall(codexHome, home);

    expect(status.hooksValid).toBe(true);
    expect(status.sessionHook).toBe(false);
    expect(status.turnHook).toBe(false);
  });

  test("detects an installed skill generated from stale source content", () => {
    writeFileSync(
      join(home, ".agents", "skills", "wiki-save", "SKILL.md"),
      "---\nname: wiki-save\ndescription: stale\n---\n<!-- llmwiki-codex-managed root=old -->\n",
    );

    expect(inspectCodexInstall(codexHome, home).staleSkills).toEqual(["wiki-save"]);
  });

  test("reports legacy $llmwiki-* skill names for migration", () => {
    const legacy = join(home, ".agents", "skills", "llmwiki-fast");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "---\nname: llmwiki-fast\ndescription: legacy\n---\n");

    expect(inspectCodexInstall(codexHome, home).legacySkills).toEqual(["llmwiki-fast"]);
  });
});
