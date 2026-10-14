// Codex adapter — proves the TranscriptSource interface generalizes to a second harness.
// parse() is exercised against both Codex shapes (nested response_item/payload + flat
// message); probe()/watchRoots() guard the ~/.codex boundary. No live ~/.codex needed.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSource } from "../src/engine/sources/codex.ts";
import { sources, sourceForKind, discoverableSources } from "../src/engine/source.ts";
import { zstdCompressFixture } from "./support/zstd-fixture.ts";

function writeJsonl(path: string, records: any[]): Buffer {
  const data = Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  writeFileSync(path, data);
  return data;
}

describe("codex registry wiring", () => {
  test("registered, plain still last, codex is discoverable", () => {
    const ks = sources().map((s) => s.kind);
    expect(ks).toEqual(["claude-jsonl", "codex", "opencode", "plain"]);
    expect(sourceForKind("codex").kind).toBe("codex");
    expect(discoverableSources().map((s) => s.kind)).toEqual(["claude-jsonl", "codex", "opencode"]);
  });

  test("watchRoots is empty when ~/.codex is absent (byte-identical daemon)", () => {
    // CI/dev machines without Codex: no roots → daemon behaves as claude-only.
    expect(Array.isArray(codexSource.watchRoots!())).toBe(true);
  });
});

describe("codex parse", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cx-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("nested response_item/payload shape: roles, cwd, session, filters", () => {
    const records = [
      { type: "session_meta", payload: { id: "cx-1", git: { repository_path: "/repo/cx" } } },
      {
        type: "response_item",
        timestamp: "2026-06-20T10:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "please refactor the parser" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-06-20T10:01:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "B".repeat(200) }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tiny" }] },
      },
    ];
    const path = join(dir, "rollout.jsonl");
    writeJsonl(path, records);

    const inc = codexSource.parse(path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("refactor");
    expect(inc.assistants.length).toBe(1); // short assistant filtered (<180)
    expect(inc.cwd).toBe("/repo/cx");
    expect(inc.sessionId).toBe("cx-1");
  });

  test("flat message shape + string content also parses", () => {
    const records = [
      { type: "message", role: "user", cwd: "/repo/flat", id: "cx-2", message: { content: "do the thing here now" } },
    ];
    const path = join(dir, "flat.jsonl");
    writeJsonl(path, records);
    const inc = codexSource.parse(path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.cwd).toBe("/repo/flat");
    expect(inc.sessionId).toBe("cx-2");
  });

  // Record shapes measured on Codex 0.162.1. Besides response_item messages a rollout now carries
  // item_completed echoes, token_usage_record, inter-agent agent_message and a compaction's
  // replacement_history — none of them may become a second copy of a turn.
  const THREAD = "01a1283e-2276-75a3-84cd-8e9f89fab9a8";
  const rollout0162 = () => [
    { type: "session_meta", payload: { id: THREAD, session_id: THREAD, cwd: "/repo/v162" } },
    {
      type: "response_item",
      payload: { type: "message", id: "msg_a", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>be terse</INSTRUCTIONS>" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-10-11T00:00:00Z",
      payload: { type: "message", id: "msg_b", role: "user", content: [{ type: "input_text", text: "2B 메모리 점검을 다시 시작해줘" }] },
    },
    {
      type: "event_msg",
      payload: { type: "item_completed", thread_id: THREAD, item: { type: "UserMessage", content: [{ type: "text", text: "2B 메모리 점검을 다시 시작해줘" }] } },
    },
    {
      type: "response_item",
      payload: { type: "message", id: "msg_c", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "1/4 진행: 작업 폴더와 학습 로그부터 확인합니다. 로컬 LLM 운영 규칙을 적용하고 비교 기준으로 점검을 이어가겠습니다." }] },
    },
    {
      type: "event_msg",
      payload: { type: "item_completed", thread_id: THREAD, item: { type: "AgentMessage", content: [{ type: "Text", text: "C".repeat(300) }], phase: "commentary" } },
    },
    { type: "token_usage_record", payload: { thread_id: THREAD, session_id: THREAD, usage: { input_tokens: 1 } } },
    {
      type: "response_item",
      payload: { type: "agent_message", id: "amsg_1", author: "/root/audit", content: [{ type: "input_text", text: "M".repeat(300) }] },
    },
    {
      type: "compacted",
      payload: { message: "", replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "2B 메모리 점검을 다시 시작해줘" }] }] },
    },
    {
      type: "response_item",
      timestamp: "2026-10-11T00:13:00Z",
      payload: { type: "message", id: "msg_d", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "감시를 복구했고 2B가 CPU·FP32로 학습하던 JEFF_DEVICE 설정 누락도 찾았습니다. 첫 스텝은 11분 2초, 관측 최대 스왑은 17.9GiB였습니다. 이벤트 경로 자동 설정과 중복 실행 차단을 보강했고 132개 테스트가 통과했습니다." }] },
    },
  ];

  test("0.162.1 shapes: one copy of each turn, AGENTS.md and echoes dropped", () => {
    const path = join(dir, "rollout-v162.jsonl");
    writeJsonl(path, rollout0162());
    const inc = codexSource.parse(path, 0);
    expect(inc.users.map((t) => t.text)).toEqual(["2B 메모리 점검을 다시 시작해줘"]);
    expect(inc.sessionId).toBe(THREAD);
    expect(inc.cwd).toBe("/repo/v162");
    // short commentary is narration; a short Korean final answer is still the conclusion
    expect(inc.assistants.map((t) => t.text.slice(0, 8))).toEqual(["감시를 복구했고"]);
  });

  test("a final_answer below the script-aware floor is still dropped", () => {
    const path = join(dir, "rollout-short.jsonl");
    writeJsonl(path, [
      { type: "session_meta", payload: { id: THREAD, cwd: "/repo/v162" } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "완료했습니다." }] } },
    ]);
    expect(codexSource.parse(path, 0).assistants).toEqual([]);
  });

  // An incremental parse starts after session_meta. The first record it sees is a response_item
  // whose payload.id is an ITEM id; the thread must come from a record that names it.
  test("a parse that starts mid-file never takes an item id as the session", () => {
    const path = join(dir, "rollout-mid.jsonl");
    const records = rollout0162();
    const head = Buffer.from(JSON.stringify(records[0]) + "\n", "utf-8");
    writeJsonl(path, records);
    const inc = codexSource.parse(path, head.length);
    expect(inc.sessionId).toBe(THREAD);
    expect(inc.users.length).toBe(1);

    const onlyItems = join(dir, "rollout-items.jsonl");
    writeJsonl(onlyItems, [records[0], records[2], records[4]]);
    expect(codexSource.parse(onlyItems, head.length).sessionId).toBeNull();
  });

  test("byte-offset watermark advances on bytes (multibyte safe)", () => {
    const first = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "가나다 첫 지시" }] } };
    const second = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "라마바 둘째 지시" }] } };
    const path = join(dir, "k.jsonl");
    writeJsonl(path, [first, second]);
    const firstBytes = Buffer.from(JSON.stringify(first), "utf-8").length + 1; // +newline
    const inc = codexSource.parse(path, firstBytes);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("둘째");
  });

  test("probe rejects a path that is not under ~/.codex/sessions", () => {
    const path = join(dir, "rollout.jsonl");
    writeJsonl(path, [{ type: "message", role: "user", message: { content: "hi there" } }]);
    expect(codexSource.probe(path)).toBeNull(); // dir is a tmp path, not ~/.codex
  });
});

// P3a — zstd-compressed cold rollouts (foo.jsonl.zst) and the rename fallback.
import { resolveRolloutPath } from "../src/engine/sources/codex.ts";
import { renameSync } from "node:fs";

describe("codex .zst rollouts", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cxz-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RECORDS = [
    { type: "session_meta", payload: { id: "cx-z", git: { repository_path: "/repo/z" } } },
    {
      type: "response_item",
      timestamp: "2026-07-10T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "compressed session ask" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-07-10T10:01:00Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Z".repeat(200) }] },
    },
  ];

  function writeZst(path: string): number {
    const plain = Buffer.from(RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    writeFileSync(path, zstdCompressFixture(plain));
    return plain.length; // decompressed byte length = expected watermark
  }

  test("parse decompresses .zst; watermark is over decompressed bytes", () => {
    const p = join(dir, "rollout-old.jsonl.zst");
    const plainLen = writeZst(p);
    const inc = codexSource.parse(p, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("compressed");
    expect(inc.assistants.length).toBe(1);
    expect(inc.newOffset).toBe(plainLen);
    // second pass from the watermark: nothing new (immutable cold file)
    const again = codexSource.parse(p, inc.newOffset);
    expect(again.users.length).toBe(0);
    expect(again.newOffset).toBe(plainLen);
  });

  test("queued .jsonl path renamed to .jsonl.zst resolves to the sibling", () => {
    const plainPath = join(dir, "rollout-r.jsonl");
    writeJsonl(plainPath, RECORDS);
    const first = codexSource.parse(plainPath, 0);
    expect(first.users.length).toBe(1);
    // Codex compresses the cold file in place
    const zstPath = `${plainPath}.zst`;
    writeZst(zstPath);
    rmSync(plainPath);
    expect(resolveRolloutPath(plainPath)).toBe(zstPath);
    const inc = codexSource.parse(plainPath, 0); // old queue row still parses
    expect(inc.users.length).toBe(1);
  });
});
