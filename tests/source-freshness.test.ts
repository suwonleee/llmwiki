import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";
import { acknowledgeFreshness, freshnessSnapshot, sourceChangedPages } from "../src/engine/source-freshness.ts";
import { searchWiki } from "../src/engine/page-rank.ts";
import { buildTurnContext, currencyMark, pageCurrency } from "../src/engine/turncontext.ts";
import { projectStatePath } from "../src/engine/project-state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-source-currency-")); roots.push(root);
  mkdirSync(join(root, "docs/wiki/5_topic"), { recursive: true });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 1;\n");
  writeFileSync(join(root, "docs/wiki/5_topic/retries.md"),
    "---\ntype: Topic\ntitle: Retry policy\nsources:\n  - id: policy\n    resource: src/policy.ts\n---\n\n## Retry policy\nThe retry policy allows exactly ONE_ATTEMPT.[^policy]\n\n[^policy]: implementation\n");
  return root;
}

const WARN = "⚠ cited source changed after this was written";

test("changed citation stays searchable, is marked in explicit lookup and carries its claim behind a recheck warning", () => {
  const root = fixture();
  const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  expect(buildTurnContext(root, "retry policy")).toContain("ONE_ATTEMPT");
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n");
  index.indexAll();
  const page = searchWiki(root, "retry policy", 1)[0]!.page;
  expect(page.sourceChanged).toBe(true);
  expect(currencyMark(pageCurrency(root, `docs/wiki/${page.rel}`))).toContain("source changed; recheck required");
  const context = buildTurnContext(root, "retry policy");
  expect(context).toContain("docs/wiki/5_topic/retries.md");
  expect(context).toContain("source changed; recheck required");
  expect(context).toContain("ONE_ATTEMPT");
  expect(context.indexOf(WARN)).toBeGreaterThan(-1);
  expect(context.indexOf(WARN)).toBeLessThan(context.indexOf("ONE_ATTEMPT"));
  expect(context.length).toBeLessThanOrEqual(1600);
});

test("a changed source still withholds a declared rule, which would be injected as an instruction", () => {
  const root = fixture();
  writeFileSync(join(root, "docs/wiki/5_topic/retries.md"),
    "---\ntype: Decision\ntitle: Retry policy\nsources:\n  - id: policy\n    resource: src/policy.ts\nx-llmwiki:\n  applies_to: [\"src/**\"]\n  rule: \"Retry policy calls retry exactly RULE_ONCE\"\n---\n\n## Retry policy\nThe retry policy allows exactly ONE_ATTEMPT.[^policy]\n\n[^policy]: implementation\n");
  const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  expect(buildTurnContext(root, "retry policy")).toContain("RULE_ONCE");
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n"); index.indexAll();
  const context = buildTurnContext(root, "retry policy");
  expect(context).toContain("docs/wiki/5_topic/retries.md");
  expect(context).not.toContain("RULE_ONCE");
  expect(context).not.toContain(WARN);
});

test("formatting an already-stale wiki page does not certify its source claims", () => {
  const root = fixture();
  const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n");
  index.indexAll();
  const path = join(root, "docs/wiki/5_topic/retries.md");
  writeFileSync(path, readFileSync(path, "utf8") + "\n<!-- formatting-only edit -->\n");
  index.indexAll();
  expect(sourceChangedPages(root).has("docs/wiki/5_topic/retries.md")).toBe(true);
  expect(buildTurnContext(root, "retry policy")).toContain(WARN);
});

test("unindexed wiki search creates no index and preserves discovery", () => {
  const root = fixture(); const path = projectStatePath(root, "index.db");
  expect(sourceChangedPages(root).size).toBe(0);
  expect(searchWiki(root, "retry policy", 1)).toHaveLength(1);
  expect(existsSync(path)).toBe(false);
});

test("unreadable index and symlinked index are ignored without following outside state", () => {
  const root = fixture();
  mkdirSync(join(root, ".llmwiki"));
  writeFileSync(join(root, ".llmwiki/index.db"), "corrupt");
  expect(sourceChangedPages(root).size).toBe(0);
  rmSync(join(root, ".llmwiki/index.db"));
  symlinkSync(join(root, "src/policy.ts"), join(root, ".llmwiki/index.db"));
  expect(sourceChangedPages(root).size).toBe(0);
  expect(searchWiki(root, "retry policy", 1)).toHaveLength(1);
});

test("explicit revision-bound acknowledgement clears warning; inspect alone does not", () => {
  const root = fixture(); const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n"); index.indexAll();
  const snapshot = freshnessSnapshot(root, "docs/wiki/5_topic/retries.md");
  expect(snapshot.dependencies).toHaveLength(1);
  expect(sourceChangedPages(root).size).toBe(1);
  const receipt = acknowledgeFreshness(root, snapshot, { verifiedBy: "test-verifier", evidence: "Manually checked policy source and historical wording" });
  expect(receipt.cleared).toBe(true);
  expect(sourceChangedPages(root).size).toBe(0);
  const db = index.connect();
  expect((db.query("SELECT count(*) AS n FROM freshness_verifications").get() as { n: number }).n).toBe(1); db.close();
});

test("acknowledgement rejects page and source edits after snapshot, including index divergence", () => {
  const root = fixture(); const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n"); index.indexAll();
  const snapshot = freshnessSnapshot(root, "docs/wiki/5_topic/retries.md");
  const verification = { verifiedBy: "test-verifier", evidence: "checked sources" };
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 999;\n");
  expect(() => acknowledgeFreshness(root, snapshot, verification)).toThrow("Index differs from disk");
  index.indexAll();
  expect(() => acknowledgeFreshness(root, snapshot, verification)).toThrow("snapshot changed");
  const second = freshnessSnapshot(root, snapshot.page.path);
  writeFileSync(join(root, snapshot.page.path), readFileSync(join(root, snapshot.page.path), "utf8") + "\nNew claim.\n");
  expect(() => acknowledgeFreshness(root, second, verification)).toThrow("Index differs from disk");
  index.indexAll();
  expect(() => acknowledgeFreshness(root, second, verification)).toThrow("snapshot changed");
  expect(sourceChangedPages(root).size).toBe(1);
});

test("inspection rejects a stale materialized dependency graph and malformed acknowledgements", () => {
  const root = fixture(); const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  const path = "docs/wiki/5_topic/retries.md";
  writeFileSync(join(root, "src/other.ts"), "export const OTHER = 2;\n");
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + "\nSee [other](../../../src/other.ts).\n");
  index.indexAll();
  expect(() => freshnessSnapshot(root, path)).toThrow("Reference graph differs");
  expect(() => acknowledgeFreshness(root, {} as any, { verifiedBy: "test", evidence: "checked" })).toThrow("Invalid freshness snapshot");
  rebuildReferenceGraph(index);
  expect(freshnessSnapshot(root, path).dependencies).toHaveLength(2);
});

test("same-pass source change and formatting-only wiki edit cannot bypass freshness warning", () => {
  const root = fixture(); const index = new WikiIndex(root); index.indexAll(); rebuildReferenceGraph(index);
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n");
  const path = join(root, "docs/wiki/5_topic/retries.md");
  writeFileSync(path, readFileSync(path, "utf8") + "\n<!-- formatting-only co-edit -->\n");
  index.indexAll();
  expect(sourceChangedPages(root).has("docs/wiki/5_topic/retries.md")).toBe(true);
  expect(buildTurnContext(root, "retry policy")).toContain(WARN);
});

test("transcript citations do not block revision-bound acknowledgement", () => {
  const root = fixture();
  const path = "docs/wiki/5_topic/retries.md";
  writeFileSync(join(root, path), readFileSync(join(root, path), "utf8") + "\nDecided in session.[^s1]\n\n[^s1]: 701c5a6b-session.jsonl\n");
  const index = new WikiIndex(root);
  index.registerTranscript(join(tmpdir(), "701c5a6b-session.jsonl"), "701c5a6b");
  index.indexAll(); rebuildReferenceGraph(index);
  const db = index.connect();
  const cited = db.query("SELECT count(*) AS n FROM document_references r JOIN documents t ON t.id=r.target_document_id WHERE t.source_kind='transcript'").get() as { n: number };
  db.close();
  expect(cited.n).toBe(1);
  writeFileSync(join(root, "src/policy.ts"), "export const RETRIES = 100;\n"); index.indexAll();
  const snapshot = freshnessSnapshot(root, path);
  expect(snapshot.dependencies.map((d) => d.path)).toEqual(["src/policy.ts"]);
  expect(acknowledgeFreshness(root, snapshot, { verifiedBy: "test-verifier", evidence: "checked policy source" }).cleared).toBe(true);
  expect(sourceChangedPages(root).size).toBe(0);
});
