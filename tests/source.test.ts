// TranscriptSource abstraction — registry routing, plain adapter parse (byte-offset on
// multibyte), and claude probe rejection of non-~/.claude paths.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sources, sourceForKind, sourceForPath } from "../src/engine/source.ts";
import { plainSource } from "../src/engine/sources/plain.ts";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";

describe("source registry", () => {
  test("registry order: greedy plain is LAST", () => {
    const ks = sources().map((s) => s.kind);
    expect(ks).toContain("claude-jsonl");
    expect(ks[ks.length - 1]).toBe("plain");
  });

  test("sourceForKind: known + unknown→claude fallback", () => {
    expect(sourceForKind("plain").kind).toBe("plain");
    expect(sourceForKind("claude-jsonl").kind).toBe("claude-jsonl");
    expect(sourceForKind("does-not-exist").kind).toBe("claude-jsonl");
  });

  test("plain never auto-discovers", () => {
    expect(plainSource.discover()).toEqual([]);
  });
});

describe("plain adapter", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-plain-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("probe claims a non-empty file, rejects a missing one", () => {
    const p = join(dir, "drop.md");
    writeFileSync(p, "# Title\nbody\n");
    const d = plainSource.probe(p);
    expect(d).not.toBeNull();
    expect(d!.sessionId).toBeNull();
    expect(d!.lines).toBe(3); // 2 newlines + 1
    expect(plainSource.probe(join(dir, "nope.md"))).toBeNull();
  });

  test("parse = whole tail as one user turn", () => {
    const p = join(dir, "drop.md");
    writeFileSync(p, "alpha beta gamma");
    const inc = plainSource.parse(p, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.assistants.length).toBe(0);
    expect(inc.users[0]!.text).toBe("alpha beta gamma");
    expect(inc.sessionId).toBeNull();
  });

  test("byte-offset watermark honored on multibyte (한글)", () => {
    const p = join(dir, "k.md");
    const first = "가나다\n"; // 3×3 bytes + newline = 10 bytes
    writeFileSync(p, first + "라마바");
    const firstBytes = Buffer.from(first, "utf-8").length;
    expect(firstBytes).toBe(10);

    const full = plainSource.parse(p, 0);
    expect(full.newOffset).toBe(Buffer.from(first + "라마바", "utf-8").length);

    const tail = plainSource.parse(p, firstBytes);
    expect(tail.users[0]!.text).toBe("라마바"); // resumes cleanly on a char boundary
  });
});

describe("claude adapter probe", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cl-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("rejects a .jsonl that is NOT under ~/.claude*/projects", () => {
    const p = join(dir, "fake.jsonl");
    writeFileSync(p, '{"type":"user","message":{"content":"hi"}}\n');
    expect(claudeJsonlSource.probe(p)).toBeNull();
  });

  test("rejects an arbitrary .md", () => {
    const p = join(dir, "notes.md");
    writeFileSync(p, "# notes\n");
    expect(claudeJsonlSource.probe(p)).toBeNull();
  });

  test("sourceForPath falls back to plain for both", () => {
    const j = join(dir, "fake.jsonl");
    const m = join(dir, "notes.md");
    writeFileSync(j, '{"type":"user","message":{"content":"hi"}}\n');
    writeFileSync(m, "# notes\n");
    expect(sourceForPath(j).kind).toBe("plain");
    expect(sourceForPath(m).kind).toBe("plain");
  });
});
