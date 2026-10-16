import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTests } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";

const roots: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(pages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-okf-context-"));
  roots.push(root);
  mkdirSync(join(root, "docs/wiki"), { recursive: true });
  for (const [name, text] of Object.entries(pages)) writeFileSync(join(root, "docs/wiki", name), text);
  new WikiIndex(root).indexAll();
  return root;
}

test("turn context keeps lexical order for varied question intents regardless of type", () => {
  const content = (type: string) => `---\ntype: ${type}\ntitle: Quartz scheduler\n---\nQuartz scheduler worker coordination.`;
  const root = fixture({
    "a.md": content("Topic"), "z.md": content("Decision"),
    "unrelated.md": "---\ntype: Decision\ntitle: Typography\n---\nUse serif fonts.",
  });
  const swapped = fixture({ "a.md": content("Decision"), "z.md": content("Topic"),
    "unrelated.md": "---\ntype: Topic\ntitle: Typography\n---\nUse serif fonts.",
  });
  for (const query of ["Why Quartz scheduler?", "Why does Quartz scheduler fail?",
    "Explain the decision to use Quartz scheduler", "Quartz scheduler 왜 실패하나?",
    "Explain Quartz scheduler", "How does Quartz scheduler work?"]) {
    for (const repo of [root, swapped]) {
      const out = buildTurnContext(repo, query, "", { affinity: null });
      expect(out).toContain("docs/wiki/a.md");
      expect(out).toContain("docs/wiki/z.md");
      expect(out.indexOf("docs/wiki/a.md")).toBeLessThan(out.indexOf("docs/wiki/z.md"));
      expect(out).not.toContain("unrelated.md");
      expect(out.length).toBeLessThanOrEqual(1600);
    }
  }
});

test("tag retrieval delivers a rule without pretending the tag was its title", () => {
  const root = fixture({
    "rule.md": "---\ntype: Decision\ntitle: Request policy\ntags: [figma]\nx-llmwiki:\n  rule: Always set a timeout.\n---\nOutbound calls must terminate.",
    "retired.md": "---\ntype: Decision\ntitle: Old request policy\ntags: [figma]\nstatus: deprecated\nx-llmwiki:\n  rule: Wait forever.\n---\nOld policy.",
  });
  const out = buildTurnContext(root, "figma", "", { affinity: null });
  expect(out).toContain("rule.md");
  expect(out).toContain("Always set a timeout.");
  expect(out).not.toContain("titled: figma");
  expect(out).not.toContain("retired.md");
  expect(out).not.toContain("Wait forever.");
  expect(buildTurnContext(root, "thanks", "", { affinity: null })).toBe("");
});
