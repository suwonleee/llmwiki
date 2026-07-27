#!/usr/bin/env bun
// Derive a routing fixture MECHANICALLY from a real transcript.
//
// Why this exists: stage-1 routing shipped a rule ("abandon the record when an unknown complex
// value appears") that every hand-written fixture satisfied and no real transcript did — 2,665 of
// 2,687 Claude sessions on the author's machine became unroutable while the suite stayed green.
// Fixtures written by the same hand that wrote the parser encode the same assumption twice.
//
// So the fixtures under tests/fixtures/real-shape/ are not authored. They are produced from a real
// transcript by keeping everything that decides routing and discarding everything else:
//
//   kept        — key names, key ORDER, nesting, value types, array shapes, string LENGTHS
//   replaced    — every string value (by `x` padding, capped) and every number
//   substituted — identity values, with obvious fixture constants the test asserts on
//
// The result carries no conversation content, no paths, no timestamps: only the shape that made
// real transcripts behave differently from invented ones.
//
// Usage:  bun tests/support/derive-fixture.ts <transcript.jsonl> <out.jsonl> --kind claude|codex
import { readFileSync, writeFileSync } from "node:fs";

/** Identity key paths per adapter, mirroring the IdentitySpec each source declares. */
const IDENTITY: Record<string, Record<string, string>> = {
  claude: {
    cwd: "/fixture/claude-repo",
    sessionId: "fixture-claude-session",
    session_id: "fixture-claude-session",
  },
  codex: {
    "payload.cwd": "/fixture/codex-repo",
    "payload.id": "fixture-codex-session",
    "payload.session_id": "fixture-codex-parent-session",
    "payload.git.repository_path": "/fixture/codex-repo",
  },
};

const MAX_STRING = 2048; // keep the shape, not the volume
const MAX_RECORDS = 8;

function scrubString(value: string): string {
  return "x".repeat(Math.min(value.length, MAX_STRING));
}

function scrub(node: unknown, path: string, identity: Record<string, string>): unknown {
  if (Array.isArray(node)) return node.map((item) => scrub(item, `${path}[]`, identity));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    // Object.entries preserves insertion order, which IS the property under test.
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const child = path ? `${path}.${key}` : key;
      out[key] = scrub(value, child, identity);
    }
    return out;
  }
  if (typeof node === "string") {
    const replacement = identity[path];
    return replacement ?? scrubString(node);
  }
  if (typeof node === "number") return 0;
  return node; // booleans and null carry no content
}

const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const kindFlag = process.argv.indexOf("--kind");
const kind = kindFlag >= 0 ? process.argv[kindFlag + 1] : "";
const identity = IDENTITY[kind ?? ""];
if (!input || !output || !identity) {
  console.error("usage: derive-fixture.ts <transcript.jsonl> <out.jsonl> --kind claude|codex");
  process.exit(2);
}

const lines = readFileSync(input, "utf-8").split("\n").filter(Boolean).slice(0, MAX_RECORDS);
const derived: string[] = [];
for (const line of lines) {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    continue; // a truncated tail contributes no shape
  }
  derived.push(JSON.stringify(scrub(record, "", identity)));
}
writeFileSync(output, derived.join("\n") + "\n");
console.log(`✓ ${derived.length} record(s) → ${output}`);
