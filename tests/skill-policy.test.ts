import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_GATE, FRONTMATTER_GATE, SKILL_POLICY_REL, skillPolicyYaml } from "../src/engine/skill-policy.ts";
import { buildAssets } from "../src/plugin/build-assets.ts";

const ROOT = join(import.meta.dir, "..");
const WIRE = join(ROOT, "src", "daemon", "wire-codex.ts");
const SKILLS = ["wiki-save", "wiki-ask", "wiki-deep", "wiki-quiz", "wiki-doctor"] as const;

// Two surfaces install these skills and a plugin install never runs the wiring, so the gate has to
// leave BOTH by both spellings. This file is the guard against fixing one and forgetting the other.
describe("skill invocation policy", () => {
  test("the shared body carries the Codex gate and quotes the skill's own description", () => {
    const yaml = skillPolicyYaml("---\ndescription: does a thing\n---\n", "wiki-save", "owner-mark");
    expect(yaml).toContain(CODEX_GATE);
    expect(yaml).toContain("# owner-mark");
    expect(yaml).toContain('display_name: "$wiki-save"');
    expect(yaml).toContain('short_description: "does a thing"');
  });

  test("a long description is truncated rather than wrapped onto a second YAML line", () => {
    const long = `---\ndescription: ${"x".repeat(200)}\n---\n`;
    const body = skillPolicyYaml(long, "wiki-deep", "owner-mark");
    const line = body.split("\n").find((l) => l.startsWith("  short_description:"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(130);
    expect(body.split("\n").filter((l) => l.trim().startsWith("policy:")).length).toBe(1);
  });

  test("the plugin bundle ships both spellings for every skill", () => {
    for (const name of SKILLS) {
      expect(readFileSync(join(ROOT, "skills", name, "SKILL.md"), "utf-8")).toContain(FRONTMATTER_GATE);
      expect(readFileSync(join(ROOT, "skills", name, SKILL_POLICY_REL), "utf-8")).toContain(CODEX_GATE);
    }
  });

  test("the clone install ships both spellings for every skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-skill-policy-"));
    try {
      const home = join(dir, "home");
      const codexHome = join(dir, "codex");
      mkdirSync(home, { recursive: true });
      mkdirSync(codexHome, { recursive: true });
      const run = Bun.spawnSync(["bun", WIRE], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.exitCode).toBe(0);
      for (const name of SKILLS) {
        const skillDir = join(home, ".agents", "skills", name);
        expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain(FRONTMATTER_GATE);
        expect(readFileSync(join(skillDir, SKILL_POLICY_REL), "utf-8")).toContain(CODEX_GATE);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildAssets writes a policy file next to every SKILL.md it emits", () => {
    const written = buildAssets(ROOT);
    expect(written.filter((p) => p.endsWith("SKILL.md"))).toHaveLength(SKILLS.length);
    expect(written.filter((p) => p.endsWith("openai.yaml"))).toHaveLength(SKILLS.length);
  });
});
