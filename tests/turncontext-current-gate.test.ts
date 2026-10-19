import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { _turnStatePath, buildTurnContext } from "../src/engine/turncontext.ts";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(body: string, fillers = 0, title = "Archive"): { root: string; session: string } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-current-gate-"));
  cleanup.push(root);
  const dir = join(root, "docs/wiki/5_topic");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "archive.md"), `---\ntitle: ${title}\n---\n${body}\n`);
  for (let i = 0; i < fillers; i++) writeFileSync(join(dir, `other-${i}.md`), `---\ntitle: Other ${i}\n---\nlogs\n`);
  new WikiIndex(root).connect().close();
  const session = `${root}-session`;
  const state = _turnStatePath(root, session);
  cleanup.push(state);
  writeFileSync(state, JSON.stringify({ seen: [], terms: { zephyrmesh: 1 } }));
  return { root, session };
}

test("prior topic cannot turn one weak current body match into sufficient confidence", () => {
  const { root, session } = fixture("zephyrmesh logs");
  expect(buildTurnContext(root, "logs", "", { affinity: null })).toBe("");
  expect(buildTurnContext(root, "logs", session, { affinity: null })).toBe("");
});

test("history cannot lift a common current term past the corpus relevance floor", () => {
  const { root, session } = fixture("zephyrmesh logs", 24, "logs zephyrmesh");
  expect(buildTurnContext(root, "logs", session, { affinity: null })).toBe("");
});

test("a specific current query still receives relevant context with prior terms present", () => {
  const { root, session } = fixture("zephyrmesh serialization preserves retry ordering.");
  expect(buildTurnContext(root, "serialization", session, { affinity: null })).toContain("archive.md");
});
