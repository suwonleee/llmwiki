// P0 "yesterday bridge" — claude adapter recapFor(): reuse harness-written ai-title /
// last-prompt jsonl records for a deterministic 1-line session recap (0 LLM, bounded I/O).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-recap-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(lines: string[]): string {
  const p = join(dir, "session.jsonl");
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("claude recapFor", () => {
  test("ai-title wins over last-prompt and user text", () => {
    const p = write([
      JSON.stringify({ type: "user", message: { content: "첫 지시입니다 이걸로 시작" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "회의실 예약 명칭 변경", sessionId: "s1" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "마지막 프롬프트", sessionId: "s1" }),
    ]);
    expect(claudeJsonlSource.recapFor!(p)).toBe("회의실 예약 명칭 변경");
  });

  test("falls back to last-prompt, then first user text", () => {
    const p1 = write([
      JSON.stringify({ type: "user", message: { content: "첫 지시" } }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "가장 최근 프롬프트", sessionId: "s1" }),
    ]);
    expect(claudeJsonlSource.recapFor!(p1)).toBe("가장 최근 프롬프트");

    const p2 = write([
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "배열형 첫 지시" }] } }),
      JSON.stringify({ type: "assistant", message: { content: "답변" } }),
    ]);
    expect(claudeJsonlSource.recapFor!(p2)).toBe("배열형 첫 지시");
  });

  test("skips harness-injected pseudo-user lines; truncates long text; null on empty/garbage", () => {
    const p = write([
      JSON.stringify({ type: "user", message: { content: "<system-reminder>주입</system-reminder>" } }),
      JSON.stringify({ type: "user", message: { content: "[hook] 주입 라인" } }),
      JSON.stringify({ type: "user", message: { content: "진짜 사용자 지시 " + "가".repeat(200) } }),
    ]);
    const r = claudeJsonlSource.recapFor!(p)!;
    expect(r.startsWith("진짜 사용자 지시")).toBe(true);
    expect(r.length).toBeLessThanOrEqual(72);
    expect(r.endsWith("…")).toBe(true);

    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    expect(claudeJsonlSource.recapFor!(empty)).toBeNull();
    expect(claudeJsonlSource.recapFor!(join(dir, "nope.jsonl"))).toBeNull();
  });

  test("large file: latest tail record wins over head (bounded I/O path)", () => {
    // >16KB head forces the head/tail split; the tail's last-prompt must win.
    const filler = JSON.stringify({ type: "assistant", message: { content: "x".repeat(400) } });
    const lines = [
      JSON.stringify({ type: "last-prompt", lastPrompt: "옛날 프롬프트", sessionId: "s1" }),
      ...Array(60).fill(filler),
      JSON.stringify({ type: "last-prompt", lastPrompt: "최신 프롬프트", sessionId: "s1" }),
    ];
    const p = write(lines);
    expect(claudeJsonlSource.recapFor!(p)).toBe("최신 프롬프트");
  });
});

// P2 — summaryFor: reuse harness-written summaries (session-memory / compact / rollout).
import { mkdirSync } from "node:fs";
import { codexSource } from "../src/engine/sources/codex.ts";

describe("claude summaryFor", () => {
  test("session-memory summary.md wins when present", () => {
    const p = write([JSON.stringify({ type: "user", message: { content: "지시" } })]);
    const smDir = join(dir, "session", "session-memory"); // session.jsonl → session/
    mkdirSync(smDir, { recursive: true });
    writeFileSync(join(smDir, "summary.md"), "# Session Title\n요약 본문입니다\n");
    expect(claudeJsonlSource.summaryFor!(p)).toContain("요약 본문입니다");
  });

  test("falls back to LATEST inline compact summary; null when neither exists", () => {
    const p = write([
      JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "옛 컴팩트 요약" } }),
      JSON.stringify({ type: "assistant", message: { content: "작업" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { content: [{ type: "text", text: "최신 컴팩트 요약" }] } }),
    ]);
    expect(claudeJsonlSource.summaryFor!(p)).toBe("최신 컴팩트 요약");

    const p2 = write([JSON.stringify({ type: "user", message: { content: "요약 없음" } })]);
    expect(claudeJsonlSource.summaryFor!(p2)).toBeNull();
  });
});

describe("codex summaryFor", () => {
  test("matches rollout thread id against memories/rollout_summaries header", () => {
    const prev = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = dir; // lazy env read in summaryFor
      const tid = "0a1b2c3d-1111-2222-3333-444455556666";
      const rsDir = join(dir, "memories", "rollout_summaries");
      mkdirSync(rsDir, { recursive: true });
      writeFileSync(
        join(rsDir, "2026-07-10T09-00-00-0a1b.md"),
        `thread_id: ${tid}\nrollout_path: /x/rollout.jsonl\ncwd: /repo\n\n코덱스가 써둔 세션 요약`,
      );
      const rollout = `/x/rollout-2026-07-10T09-00-00-${tid}.jsonl`;
      expect(codexSource.summaryFor!(rollout)).toContain("코덱스가 써둔 세션 요약");
      expect(codexSource.summaryFor!(`/x/rollout-2026-07-10T09-00-00-${tid}.jsonl.zst`)).toContain("코덱스");
      expect(codexSource.summaryFor!("/x/rollout-2026-07-10T09-00-00-9999dead-1111-2222-3333-444455556666.jsonl")).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});
