// Incremental transcript extractor.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractIncrement, render } from "../src/engine/extract.ts";

function writeJsonl(path: string, records: any[]): Buffer {
  const data = Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  writeFileSync(path, data);
  return data;
}

describe("extractIncrement", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-ext-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("classification and filter", () => {
    const records = [
      { type: "user", cwd: "/repo/x", sessionId: "sess123", timestamp: "2026-06-14T10:00:00Z", message: { content: "do the thing please" } },
      { type: "assistant", timestamp: "2026-06-14T10:01:00Z", message: { content: [{ type: "text", text: "A".repeat(200) }] } },
      { type: "assistant", timestamp: "2026-06-14T10:02:00Z", message: { content: [{ type: "text", text: "short" }] } },
    ];
    const path = join(dir, "t.jsonl");
    writeJsonl(path, records);

    const inc = extractIncrement(path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.assistants.length).toBe(1); // short assistant filtered
    expect(inc.cwd).toBe("/repo/x");
    expect(inc.sessionId).toBe("sess123");
  });

  test("new_offset is start + raw byte length", () => {
    const records = [{ type: "user", cwd: "/r", sessionId: "s", message: { content: "hello" } }];
    const path = join(dir, "t.jsonl");
    const data = writeJsonl(path, records);
    const inc = extractIncrement(path, 0);
    expect(inc.newOffset).toBe(0 + data.length);
    expect(inc.newOffset).toBe(data.length);
  });

  test("start offset skips prefix", () => {
    const first = { type: "user", cwd: "/r", sessionId: "s", message: { content: "first instruction here" } };
    const second = { type: "user", message: { content: "second instruction here" } };
    const path = join(dir, "t.jsonl");
    writeJsonl(path, [first, second]);

    const firstLineBytes = Buffer.from(JSON.stringify(first), "utf-8").length + 1; // +newline
    const inc = extractIncrement(path, firstLineBytes);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("second");
  });

  test("render returns string", () => {
    const path = join(dir, "t.jsonl");
    writeJsonl(path, [{ type: "user", cwd: "/r", sessionId: "s", message: { content: "hi" } }]);
    const inc = extractIncrement(path, 0);
    const rendered = render(inc);
    expect(typeof rendered).toBe("string");
    expect(rendered).toContain("user utterances");
  });
});
