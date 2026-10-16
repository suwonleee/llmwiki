import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";
import { Linter, type WikiDoc, type WikiIndexLike } from "../src/engine/lint.ts";
import { citationDeclarations, resolveCitation, rebuildReferenceGraph } from "../src/engine/refs.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "okf-provenance-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function put(path: string, text: string) {
  const target = join(root, "docs/wiki", path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
function doc(sources: string, body: string) {
  return `---\ntype: Decision\ntitle: Decision\nsources:\n${sources}\n---\n${body}\n`;
}
function inspect(content: string) {
  put("decisions/a.md", content);
  put("references/policy.md", "---\ntype: Reference\ntitle: Policy\n---\nPolicy\n");
  put("other/policy.md", "---\ntype: Reference\ntitle: Collision\n---\nDifferent\n");
  const index = new WikiIndex(root);
  index.indexAll();
  rebuildReferenceGraph(index);
  const conn = index.connect();
  try {
    const docs = index.listDocumentsWithContent(conn) as unknown as WikiDoc[];
    const page = docs.find((d) => d.relative_path === "docs/wiki/decisions/a.md")!;
    const linter = new Linter(index as unknown as WikiIndexLike, conn);
    const lookup = linter._sourceLookup(docs);
    return {
      issues: [...linter._citations("/docs/wiki/decisions/a.md", content, lookup), ...linter._graph(page, content, lookup)],
      targets: index.getForwardReferences(conn, String(page.id)).filter((r) => r.reference_type === "cites").map((r) => docs.find((d) => String(d.id) === String(r.id))!.relative_path),
      transcripts: docs.filter((d) => d.source_kind === "transcript"),
    };
  } finally { conn.close(); }
}

test("stable source IDs resolve descriptive labels, independent of sources order", () => {
  const policy = "  - {id: policy, resource: references/policy.md}";
  const web = "  - {id: web, resource: 'https://example.org/policy.md'}";
  for (const sources of [`${policy}\n${web}`, `${web}\n${policy}`]) {
    const result = inspect(doc(sources, "Decision[^policy].\n[^policy]: Authoritative policy description"));
    expect(result.targets).toEqual(["docs/wiki/references/policy.md"]);
    expect(result.issues).toEqual([]);
  }
});

test("bundle absolute and explicit document relative resources resolve without basename collisions", () => {
  for (const path of ["/references/policy.md", "../references/policy.md"]) {
    const result = inspect(doc(`  - {id: p, resource: '${path}'}`, "Text[^p]\n[^p]: Label"));
    expect(result.targets).toEqual(["docs/wiki/references/policy.md"]);
    expect(result.issues).toEqual([]);
  }
});

test("external URLs and scope descriptors are provenance, not missing files", () => {
  for (const resource of ["https://example.org/policy.md", "all queries in BigQuery project X", "urn:policy:rules", "//example.org/policy.md"]) {
    const result = inspect(doc(`  - {id: p, resource: '${resource}'}`, "Text[^p]\n[^p]: policy.md"));
    expect(result.targets).toEqual([]);
    expect(result.issues).toEqual([]);
  }
});

test("missing local paths and traversal cannot bind a same-name page", () => {
  for (const resource of ["missing/policy.md", "../../references/policy.md", "/../references/policy.md", "%2e%2e/%2e%2e/references/policy.md"]) {
    const result = inspect(doc(`  - {id: p, resource: '${resource}'}`, "Text[^p]\n[^p]: policy.md"));
    expect(result.targets).toEqual([]);
    expect(result.issues.map((i) => i.code)).toEqual(["unresolved-citation"]);
  }
});

test("duplicate source IDs are ambiguous and never fall back to footnote text", () => {
  const result = inspect(doc("  - {id: p, resource: references/policy.md}\n  - {id: p, resource: other/policy.md}", "Text[^p]\n[^p]: policy.md"));
  expect(result.targets).toEqual([]);
  expect(result.issues.map((i) => i.code)).toEqual(["ambiguous-source-id"]);
});

test("absent declaration retains legacy transcript citation resolution", () => {
  const result = inspect(doc("  - {id: unrelated, resource: https://example.org}", "Text[^legacy]\n[^legacy]: legacy-session.jsonl"));
  expect(result.transcripts.map((d) => d.filename)).toEqual(["legacy-session.jsonl"]);
  expect(result.targets).toHaveLength(1);
  expect(result.issues).toEqual([]);
});

test("declared rotated transcript keeps actual identifier rather than description", () => {
  const result = inspect(doc("  - {id: session, resource: actual-session.jsonl}", "Text[^session]\n[^session]: Meeting transcript"));
  expect(result.transcripts.map((d) => d.filename)).toEqual(["actual-session.jsonl"]);
  expect(result.targets).toHaveLength(1);
  expect(result.issues).toEqual([]);
});

test("declared imported Markdown transcript resolves only when explicitly registered", () => {
  const citation = citationDeclarations(doc("  - {id: session, resource: session.md}", "[^session]: Imported meeting notes"))[0]!;
  const transcript = { relative_path: "__transcript__/session.md", filename: "session.md", source_kind: "transcript" };
  expect(resolveCitation(citation, "decisions", { "session.md": transcript })).toEqual(transcript);
  expect(resolveCitation(citation, "decisions", {})).toBeUndefined();
  expect(resolveCitation(citation, "decisions", {
    "session.md": { relative_path: "elsewhere/session.md", filename: "session.md", source_kind: "source" },
  })).toBeUndefined();
});

test("fenced examples create no provenance declarations or virtual transcripts", () => {
  const result = inspect(doc("  - {id: p, resource: references/policy.md}", "```md\n[^p]: label\n[^fake]: fake-session.jsonl\n```"));
  expect(result.targets).toEqual([]);
  expect(result.transcripts).toEqual([]);
});

test("declared missing resource never binds descriptive text; unknown IDs stay legacy", () => {
  const citations = citationDeclarations(doc("  - {id: p}", "[^p]: policy.md\n[^other]: legacy.jsonl"));
  expect(citations[0]!.kind).toBe("invalid");
  expect(citations[1]!.declared).toBe(false);
  expect(resolveCitation(citations[0]!, "decisions", {})).toBeUndefined();
});

test("converter-style repository code resources use exact path, never a basename", () => {
  const lookup = {
    "src/api.ts": { relative_path: "src/api.ts", filename: "api.ts" },
    "api.ts": { relative_path: "elsewhere/api.ts", filename: "api.ts" },
  };
  const exact = citationDeclarations(doc("  - {id: code, resource: src/api.ts}", "[^code]: API implementation"))[0]!;
  expect(resolveCitation(exact, "decisions", lookup)).toEqual(lookup["src/api.ts"]);
  const missing = citationDeclarations(doc("  - {id: code, resource: missing/api.ts}", "[^code]: API implementation"))[0]!;
  expect(resolveCitation(missing, "decisions", lookup)).toBeUndefined();
});

test("declared code resource retains its line locator independently of label", () => {
  const lookup = { "src/api.ts": { id: "api", relative_path: "src/api.ts", filename: "api.ts" } };
  for (const resource of ["src/api.ts:123", "src/api.ts:123-125"]) {
    const citation = citationDeclarations(doc(`  - {id: code, resource: '${resource}'}`, "[^code]: unrelated.ts:999"))[0]!;
    expect(citation.filename).toBe("src/api.ts");
    expect(citation.page).toBe(123);
    expect(resolveCitation(citation, "decisions", lookup)).toEqual(lookup["src/api.ts"]);
  }
  const remote = citationDeclarations(doc("  - {id: code, resource: 'https://example.org/api.ts:123'}", "[^code]: API"))[0]!;
  expect(remote.kind).toBe("external");
  expect(remote.page).toBeNull();
});

test("declared bundle paths cannot resolve a vendored nested wiki", () => {
  const vendor = { relative_path: "vendor/docs/wiki/references/policy.md", filename: "policy.md" };
  const lookup = { "vendor/docs/wiki/references/policy.md": vendor };
  for (const resource of ["references/policy.md", "/references/policy.md", "../references/policy.md"]) {
    const citation = citationDeclarations(doc(`  - {id: p, resource: '${resource}'}`, "[^p]: policy.md"))[0]!;
    expect(resolveCitation(citation, "decisions", lookup)).toBeUndefined();
  }
});
