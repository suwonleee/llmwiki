// Incremental transcript extractor.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractIncrement, render, substantiveFloor } from "../src/engine/extract.ts";

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

// "Substantive" is a claim about meaning, and one raw character count measures it differently in
// every script. Hangul/Han carry roughly twice the meaning per character English does, so a flat
// floor held Korean sessions to twice the standard and dropped real conclusions for being written
// densely — measured on this author's transcripts: 27.6% of Korean assistant messages cleared 180,
// with a further 17.8% sitting between 90 and 180.
describe("substantive floor is measured in meaning, not characters", () => {
  test("a dense-script conclusion clears at half the ascii floor, and ascii is unchanged", () => {
    expect(substantiveFloor("한국어 결론 문장", 180)).toBe(90);
    expect(substantiveFloor("an english conclusion", 180)).toBe(180);
  });

  test("a 100-character Korean conclusion survives extraction; a 100-character English one does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-floor-"));
    try {
      const p = join(dir, "s.jsonl");
      writeJsonl(p, [
        { type: "assistant", timestamp: "2026-07-27T10:00:00Z", message: { content: [{ type: "text", text: "결".repeat(100) }] } },
        { type: "assistant", timestamp: "2026-07-27T10:01:00Z", message: { content: [{ type: "text", text: "e".repeat(100) }] } },
      ]);

      const inc = extractIncrement(p, 0);

      expect(inc.assistants.length).toBe(1);
      expect(inc.assistants[0]!.text.startsWith("결")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Rows that parse as ordinary turns but are nobody's words: a compact-summary row is the
// harness's machine-written recap, and a sidechain "user" turn is the orchestrator's task prompt
// to a subagent. Both flow into `excerpt --kind judgment`, whose one promise is "a verbatim HUMAN
// utterance" — a decision page quoting either is grounded on something no human said.
describe("synthetic rows never become utterances", () => {
  test("compact summaries and sidechain turns are excluded from both roles", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-synth-"));
    try {
      const p = join(dir, "s.jsonl");
      writeJsonl(p, [
        { type: "user", isCompactSummary: true, timestamp: "2026-07-27T10:00:00Z",
          message: { content: "This session is being continued from a previous conversation. ".repeat(5) } },
        { type: "user", isSidechain: true, timestamp: "2026-07-27T10:01:00Z",
          message: { content: [{ type: "text", text: "저장소 규칙: checkout 금지, 로그만 볼 것. 이제 작업을 시작하라." }] } },
        { type: "assistant", isSidechain: true, timestamp: "2026-07-27T10:02:00Z",
          message: { content: [{ type: "text", text: "결".repeat(120) }] } },
        { type: "user", timestamp: "2026-07-27T10:03:00Z",
          message: { content: [{ type: "text", text: "이 결정을 기록해두자." }] } },
      ]);

      const inc = extractIncrement(p, 0);

      expect(inc.users.length).toBe(1);
      expect(inc.users[0]!.text).toBe("이 결정을 기록해두자.");
      expect(inc.assistants.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
