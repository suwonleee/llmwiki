// The generated skill/command pages must still OPEN with their YAML frontmatter.
//
// This is the one property every harness requires and the one the wirings can break by string
// surgery. They used to find the end of the frontmatter with indexOf("\n---\n"), which never
// matches a CRLF source — and Git for Windows checks out CRLF by default. The fallback branch then
// prepended the ownership marker, so on a native Windows install Codex refused all five skills
// ("missing YAML frontmatter delimited by ---") while `llmwiki doctor` reported them present.
//
// Two layers are asserted here, because either alone leaves the failure reachable: the insertion
// itself must tolerate CRLF, and doctor must be able to SEE a page that does not parse.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAfterFrontmatter } from "../src/engine/frontmatter.ts";
import { inspectCodexInstall, inspectOpenCodeInstall } from "../src/engine/doctor.ts";
import { ENGINE_CLI_TOKEN, engineCliCommand, hookCliCommand } from "../src/engine/paths.ts";
import { renderOwnedCommand } from "../src/engine/claude-commands.ts";

const ROOT = join(import.meta.dir, "..");
const SKILLS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"] as const;
const MARKER = "\n<!-- llmwiki-managed -->\n";

describe("insertAfterFrontmatter", () => {
  test("LF page: the marker lands below the closing delimiter", () => {
    const out = insertAfterFrontmatter("---\ntitle: t\n---\nbody\n", MARKER);
    expect(out).toBe("---\ntitle: t\n---\n\n<!-- llmwiki-managed -->\nbody\n");
  });

  test("THE REGRESSION — a CRLF page keeps its frontmatter first", () => {
    const out = insertAfterFrontmatter("---\r\ntitle: t\r\n---\r\nbody\r\n", MARKER);
    expect(out.startsWith("---\r\n")).toBe(true);
    expect(out.indexOf("<!-- llmwiki-managed -->")).toBeGreaterThan(out.indexOf("---\r\ntitle"));
    expect(out).toBe("---\r\ntitle: t\r\n---\r\n\n<!-- llmwiki-managed -->\nbody\r\n");
  });

  test("a page without frontmatter still gets the marker, at the top", () => {
    expect(insertAfterFrontmatter("# plain\n", MARKER)).toBe(`${MARKER}# plain\n`);
  });

  test("a rule in the body is not mistaken for the closing delimiter", () => {
    const out = insertAfterFrontmatter("---\ntitle: t\n----\nstill frontmatter?\n---\nbody\n", MARKER);
    // The `----` line does not close the block; the real delimiter two lines down does.
    expect(out).toBe("---\ntitle: t\n----\nstill frontmatter?\n---\n\n<!-- llmwiki-managed -->\nbody\n");
  });

  test("frontmatter that ends the file appends rather than prepends", () => {
    expect(insertAfterFrontmatter("---\ntitle: t\n---", MARKER)).toBe(`---\ntitle: t\n---${MARKER}`);
  });

  test("every shipped skill survives being read as CRLF", () => {
    for (const name of SKILLS) {
      const source = readFileSync(join(ROOT, "skill", `${name}.md`), "utf8");
      const crlf = source.replace(/\r?\n/g, "\r\n");
      const out = insertAfterFrontmatter(crlf, MARKER);
      expect(/^---\r?\n/.test(out)).toBe(true);
      expect(out).toContain(MARKER.trim());
    }
  });
});

describe("the engine invocation a generated page carries", () => {
  test("is quoted, so a clone path with a space survives", () => {
    // `C:\Users\First Last` is what Windows gives anyone who typed their full name at setup. The
    // unquoted form truncated there — bun answered `Module not found ".../First"` and every engine
    // call in every skill failed.
    expect(engineCliCommand("/home/me/my llmwiki")).toBe('bun "/home/me/my llmwiki/src/cli.ts"');
    expect(hookCliCommand("/home/me/my llmwiki")).toBe('bun "/home/me/my llmwiki/src/hook-cli.ts"');
  });

  test("the token it replaces is the one the shipped skills actually use", () => {
    // If skill/*.md ever spells the invocation differently, the substitution silently stops
    // happening and every page ships `~/llmwiki` — a path that exists on nobody's machine.
    for (const name of SKILLS) {
      expect(readFileSync(join(ROOT, "skill", `${name}.md`), "utf8")).toContain(ENGINE_CLI_TOKEN);
    }
  });

  test("a Claude command comes out with the quoted spelling too", () => {
    const root = mkdtempSync(join(tmpdir(), "llmwiki-cli root-"));
    try {
      mkdirSync(join(root, "skill"), { recursive: true });
      writeFileSync(
        join(root, "skill", "wiki-save.md"),
        `---\ndescription: d\n---\nrun \`${ENGINE_CLI_TOKEN} index <repo>\`\n`,
      );
      const rendered = renderOwnedCommand("wiki-save.md", root);
      expect(rendered).toContain(`${engineCliCommand(root)} index <repo>`);
      expect(rendered).not.toContain(ENGINE_CLI_TOKEN);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("doctor sees a page that does not parse", () => {
  let dir: string;
  let home: string;

  const writeCodexSkill = (name: string, body: string): void => {
    const skillDir = join(home, ".agents", "skills", name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), body);
  };
  const writeOpenCodeCommand = (name: string, body: string): void => {
    const commands = join(dir, "config", "opencode", "commands");
    mkdirSync(commands, { recursive: true });
    writeFileSync(join(commands, `${name}.md`), body);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-frontmatter-"));
    home = join(dir, "home");
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a Codex skill whose marker sits above the frontmatter is unloadable, not present", () => {
    for (const name of SKILLS) writeCodexSkill(name, `---\nname: ${name}\n---\nbody\n`);
    expect(inspectCodexInstall(join(dir, "codex"), home).malformedSkills).toEqual([]);

    writeCodexSkill("wiki-save", "\n<!-- llmwiki-codex-managed -->\n---\nname: wiki-save\n---\nbody\n");
    const status = inspectCodexInstall(join(dir, "codex"), home);
    // Still "installed" by every prior measure — that is exactly why presence was not enough.
    expect(status.missingSkills).toEqual([]);
    expect(status.malformedSkills).toEqual(["wiki-save"]);
  });

  test("a Codex hook is recognized in EITHER spelling — adapter script or direct CLI", () => {
    // Windows wires the second form: `bash` is not on the Windows PATH and Codex runs hook commands
    // through PowerShell, so `bash '<script>'` only ever produced "hook exited with code 1". An
    // install written in either spelling must read as wired, or re-running setup becomes the
    // standing advice for a hook that works.
    const codexHome = join(dir, "codex");
    mkdirSync(codexHome, { recursive: true });
    const hooksFor = (session: string, turn: string): string =>
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: session }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: turn }] }],
        },
      });
    const root = ROOT.replaceAll("\\", "/");

    writeFileSync(
      join(codexHome, "hooks.json"),
      hooksFor(`bash '${root}/hooks/sessionstart-inject.sh'`, `bash '${root}/hooks/userpromptsubmit-inject.sh'`),
    );
    const viaAdapter = inspectCodexInstall(codexHome, home);
    expect([viaAdapter.sessionHook, viaAdapter.turnHook]).toEqual([true, true]);

    writeFileSync(
      join(codexHome, "hooks.json"),
      hooksFor(
        `bun "${root}/src/cli.ts" context --hook-event SessionStart`,
        `bun "${root}/src/cli.ts" turn-context --hook-event UserPromptSubmit`,
      ),
    );
    const viaCli = inspectCodexInstall(codexHome, home);
    expect([viaCli.sessionHook, viaCli.turnHook]).toEqual([true, true]);

    writeFileSync(
      join(codexHome, "hooks.json"),
      hooksFor(
        `bun "${root}/src/cli.ts" context --hook-event SessionStart`,
        `bun "${root}/src/hook-cli.ts" turn-context-hook`,
      ),
    );
    const viaHookCli = inspectCodexInstall(codexHome, home);
    expect([viaHookCli.sessionHook, viaHookCli.turnHook]).toEqual([true, true]);

    // Another clone's hook is still another clone's hook.
    writeFileSync(
      join(codexHome, "hooks.json"),
      hooksFor(
        `bun "/somewhere/else/src/cli.ts" context --hook-event SessionStart`,
        `bun "/somewhere/else/src/cli.ts" turn-context --hook-event UserPromptSubmit`,
      ),
    );
    const foreign = inspectCodexInstall(codexHome, home);
    expect([foreign.sessionHook, foreign.turnHook]).toEqual([false, false]);
  });

  test("an OpenCode command is judged the same way", () => {
    for (const name of SKILLS) writeOpenCodeCommand(name, `---\ndescription: d\n---\nbody\n`);
    expect(inspectOpenCodeInstall(join(dir, "config"), home).malformedCommands).toEqual([]);

    writeOpenCodeCommand("wiki-ask", "\n<!-- llmwiki-opencode-managed -->\n---\ndescription: d\n---\nbody\n");
    const status = inspectOpenCodeInstall(join(dir, "config"), home);
    expect(status.missingCommands).toEqual([]);
    expect(status.malformedCommands).toEqual(["wiki-ask"]);
  });
});
