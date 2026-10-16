// Diagnostic of OKF §5.1 source-ID joins, independent of retrieval and model inference.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [engineArg, output] = process.argv.slice(2);
if (!engineArg || !output) throw new Error("usage: bun provenance.ts ENGINE_ROOT OUTPUT.json");
const temp = mkdtempSync(join(tmpdir(), "llmwiki-source-eval-"));
process.env.LLMWIKI_STATE_DIR = join(temp, "state");
const engine = resolve(engineArg);
try {
  const { WikiIndex } = await import(join(engine, "src/engine/db.ts"));
  const { rebuildReferenceGraph } = await import(join(engine, "src/engine/refs.ts"));
  const { Linter } = await import(join(engine, "src/engine/lint.ts"));
  const cases = [
    { id: "bundle-source", resource: "/references/policy.md", expected: "policy.md" },
    { id: "relative-source", resource: "../references/policy.md", expected: "policy.md" },
    { id: "transcript-source", resource: "session-example.jsonl", expected: "session-example.jsonl" },
  ];
  const results = [];
  for (const c of cases) {
    const root = join(temp, c.id);
    mkdirSync(join(root, "docs/wiki/decisions"), { recursive: true });
    mkdirSync(join(root, "docs/wiki/references"), { recursive: true });
    const content = `---\ntype: Decision\ntitle: Request limits\nsources:\n  - {id: policy, resource: ${JSON.stringify(c.resource)}}\n---\nUse explicit limits.[^policy]\n\n[^policy]: Human-readable policy description\n`;
    writeFileSync(join(root, "docs/wiki/decisions/limits.md"), content);
    writeFileSync(join(root, "docs/wiki/references/policy.md"), "---\ntype: Reference\ntitle: Service policy\n---\nAll calls must have limits.\n");
    const index = new WikiIndex(root);
    index.indexAll();
    rebuildReferenceGraph(index);
    const db = index.connect();
    try {
      const docs = index.listDocumentsWithContent(db);
      const page = docs.find((d: any) => d.relative_path === "docs/wiki/decisions/limits.md");
      const targets = index.getForwardReferences(db, String(page.id)).filter((d: any) => d.reference_type === "cites").map((d: any) => d.filename);
      const linter = new Linter(index, db);
      const issues = linter._citations("/docs/wiki/decisions/limits.md", content, linter._sourceLookup(docs));
      results.push({ id: c.id, expected: c.expected, targets, resolved: targets.includes(c.expected), citationIssues: issues.map((i: any) => i.code) });
    } finally { db.close(); }
  }
  const report = { scope: "Three synthetic provenance joins, not retrieval or model accuracy.", summary: { cases: results.length, resolved: results.filter((r) => r.resolved).length, citationIssues: results.reduce((n, r) => n + r.citationIssues.length, 0) }, results };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary));
} finally { rmSync(temp, { recursive: true, force: true }); }
