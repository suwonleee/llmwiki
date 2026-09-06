import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStructuredAsk, inspectCodexInstall } from "../src/engine/doctor.ts";

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

  test("a pre-guard install is detected: no additionalContextLimit on SessionStart", () => {
    const status = inspectCodexInstall(codexHome, home);

    expect(status.sessionHook).toBe(true);
    expect(status.sessionSpillGuard).toBe(false); // fixture hooks.json predates the spill guard
  });

  test("a guarded install reports sessionSpillGuard", () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: `bash '${ROOT}/hooks/sessionstart-inject.sh'`,
                  additionalContextLimit: 0,
                },
              ],
            },
          ],
          UserPromptSubmit: [
            { matcher: "", hooks: [{ type: "command", command: `bash '${ROOT}/hooks/userpromptsubmit-inject.sh'` }] },
          ],
        },
      }),
    );

    const status = inspectCodexInstall(codexHome, home);

    expect(status.sessionSpillGuard).toBe(true);
  });

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

  test("reports skills installed without a Codex invocation gate", () => {
    // The fixture writes SKILL.md only — exactly the shape that let Codex self-invoke $wiki-save
    // after unrelated work (measured across 16 sessions before the gate existed).
    expect(inspectCodexInstall(codexHome, home).ungatedSkills).toEqual([
      "wiki-save",
      "wiki-ask",
      "wiki-deep",
      "wiki-quiz",
      "wiki-doctor",
    ]);
  });

  test("a gated install reports no ungated skills", () => {
    for (const name of ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"]) {
      const agents = join(home, ".agents", "skills", name, "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    }
    expect(inspectCodexInstall(codexHome, home).ungatedSkills).toEqual([]);
  });

  test("reports legacy $llmwiki-* skill names for migration", () => {
    const legacy = join(home, ".agents", "skills", "llmwiki-fast");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "---\nname: llmwiki-fast\ndescription: legacy\n---\n");

    expect(inspectCodexInstall(codexHome, home).legacySkills).toEqual(["llmwiki-fast"]);
  });
});

describe("Codex structured-ask flag", () => {
  // `$wiki-quiz` prefers Codex's own prompt (`request_user_input`), but Codex allows the CALL only
  // in Plan mode unless `default_mode_request_user_input` is set — measured on 0.153.4. Doctor
  // reads that per home because Codex Desktop gives each signed-in account its own config.toml,
  // so a flag enabled in one home says nothing about another. Reading it wrong only ever prints
  // the wrong optional hint, which is why this is a narrow reader and not a TOML dependency.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-codex-ask-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (toml: string): string => {
    const home = join(dir, `home-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), toml);
    return home;
  };

  test("no config.toml is the stock state, and the stock state is off", () => {
    const home = join(dir, "bare");
    mkdirSync(home, { recursive: true });
    expect(codexStructuredAsk(home)).toBe("off");
  });

  test("the [features] table entry `codex features enable` writes is read as on", () => {
    expect(codexStructuredAsk(write("[features]\ndefault_mode_request_user_input = true\n"))).toBe("on");
  });

  test("a dotted top-level key is read as on too", () => {
    expect(codexStructuredAsk(write('model = "gpt-5.6-sol"\nfeatures.default_mode_request_user_input = true\n'))).toBe("on");
  });

  test("explicitly false is off", () => {
    expect(codexStructuredAsk(write("[features]\nhooks = true\ndefault_mode_request_user_input = false\n"))).toBe("off");
  });

  test("the key set true under a DIFFERENT table is not this flag", () => {
    // A real config.toml carries [hooks.state."<path>:session_start:0:0"] tables whose bodies are
    // `enabled = true` lines. Scoping by table is what keeps a stray key from reading as the flag.
    const toml = [
      "[features]",
      "hooks = true",
      "",
      '[hooks.state."/Users/x/.codex/hooks.json:session_start:0:0"]',
      "enabled = true",
      "default_mode_request_user_input = true",
      "",
    ].join("\n");
    expect(codexStructuredAsk(write(toml))).toBe("off");
  });

  test("a comment does not enable the flag", () => {
    expect(codexStructuredAsk(write("[features]\n# default_mode_request_user_input = true\n"))).toBe("off");
  });

  test("the inspected install carries the state of ITS home", () => {
    const home = write("[features]\ndefault_mode_request_user_input = true\n");
    expect(inspectCodexInstall(home, join(dir, "no-such-home")).structuredAsk).toBe("on");
  });
});
