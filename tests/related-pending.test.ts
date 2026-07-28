// Same-topic pending candidates (`llmwiki related`) — the close-out's optional weave-in surface.
//
// The precision property under test: matching is HUMAN-utterance-only. llmwiki's own injections
// (cold-start banner, turn-context pointers) and tool output appear in every transcript, so raw
// substring matching flagged 60 of 60 real pending sessions (measured 2026-07-28). A candidate
// whose ASSISTANT text is on-topic but whose human never mentioned the topic must not surface.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureRow } from "../src/engine/capture.ts";
import { relatedFromRows, renderUpdateNextCommand, scoreAgainst } from "../src/engine/related.ts";
import { extractTerms } from "../src/engine/turncontext.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-related-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeJsonl(name: string, records: any[]): string {
  const path = join(dir, name);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function row(path: string, session: string): CaptureRow {
  return {
    transcript_path: path,
    session_id: session,
    repo: "/r",
    byte_offset: 0,
    lines: 1,
    status: "pending",
    source_kind: "claude-jsonl",
    first_seen: "2026-07-28",
    distilled_at: null,
  };
}

const user = (sessionId: string, text: string) => ({
  type: "user",
  cwd: "/r",
  sessionId,
  timestamp: "2026-07-28T10:00:00Z",
  message: { content: text },
});

// Anchor session: the human worked on the codex adapter hooks.
const ANCHOR_TEXT =
  "코덱스 어댑터 훅 점검하고 additionalContextLimit 스필 가드 구현해줘. wire-codex 배선도 확인.";

describe("relatedFromRows", () => {
  test("a session whose HUMAN talked about the same topic surfaces; an off-topic one does not", () => {
    const on = writeJsonl("on.jsonl", [
      user("sess-on", "어제 하다 만 코덱스 어댑터 hooks.json 배선, wire-codex 재실행부터 이어서 보자"),
    ]);
    const off = writeJsonl("off.jsonl", [
      user("sess-off", "발표 자료 15번 슬라이드 이미지 비율 좀 다듬어줘"),
    ]);

    const terms = extractTerms(ANCHOR_TEXT);
    const out = relatedFromRows([row(on, "sess-on"), row(off, "sess-off")], "/anchor.jsonl", "sess-a", terms);

    expect(out.map((c) => c.sessionId)).toEqual(["sess-on"]);
    expect(out[0]!.score).toBeGreaterThanOrEqual(4);
  });

  test("assistant/tool text never votes: injected llmwiki context cannot make a session related", () => {
    const polluted = writeJsonl("polluted.jsonl", [
      user("sess-p", "스노우플레이크 대시보드 쿼리 최적화 부탁해"),
      {
        type: "assistant",
        timestamp: "2026-07-28T10:01:00Z",
        message: {
          content: [
            {
              type: "text",
              // The kind of text llmwiki itself injects into EVERY session — the measured
              // self-pollution channel. 200+ chars so the extractor keeps it as substantive.
              text: ("[llmwiki turn-context] 코덱스 어댑터 wire-codex additionalContextLimit 스필 콜드스타트 훅 배선 ").repeat(5),
            },
          ],
        },
      },
    ]);

    const out = relatedFromRows([row(polluted, "sess-p")], "/anchor.jsonl", "sess-a", extractTerms(ANCHOR_TEXT));

    expect(out).toEqual([]);
  });

  test("a skill body recorded as a user turn does not vote (harness-fed user-role text)", () => {
    const ranSave = writeJsonl("ran-save.jsonl", [
      user("sess-s", "발표 대본 다듬어줘"), // the human's actual (off-topic) ask
      // Invoking /wiki-save records the skill markdown as a USER turn — shared vocabulary that
      // made every close-out session look related to every other one (8/59 gate-passed on it).
      user("sess-s", "# /wiki-save — 코덱스 어댑터 wire-codex additionalContextLimit 스필 훅 배선 콜드스타트 규칙 ..."),
    ]);

    const out = relatedFromRows([row(ranSave, "sess-s")], "/anchor.jsonl", "sess-a", extractTerms(ANCHOR_TEXT));

    expect(out).toEqual([]);
  });

  test("the anchor's own transcript and session are never candidates", () => {
    const self = writeJsonl("self.jsonl", [user("sess-a", ANCHOR_TEXT)]);
    const twin = writeJsonl("twin.jsonl", [user("sess-a", ANCHOR_TEXT)]); // same session, other file

    const out = relatedFromRows([row(self, "sess-a"), row(twin, "sess-a")], self, "sess-a", extractTerms(ANCHOR_TEXT));

    expect(out).toEqual([]);
  });

  test("ranking caps at 3, most-related first", () => {
    const rows: CaptureRow[] = [];
    for (let i = 0; i < 5; i += 1) {
      // Increasing overlap with the anchor: later fixtures mention more anchor terms.
      const extra = ["어댑터", "wire-codex 배선", "additionalContextLimit 가드", "스필 콜드스타트"].slice(0, i).join(" ");
      const p = writeJsonl(`c${i}.jsonl`, [user(`sess-${i}`, `코덱스 훅 작업 이어가기 ${extra}`)]);
      rows.push(row(p, `sess-${i}`));
    }

    const out = relatedFromRows(rows, "/anchor.jsonl", "sess-a", extractTerms(ANCHOR_TEXT));

    expect(out.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < out.length; i += 1) expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
  });

  test("no anchor terms → no candidates (silence, not a scan)", () => {
    const p = writeJsonl("x.jsonl", [user("sess-x", "코덱스 어댑터")]);
    expect(relatedFromRows([row(p, "sess-x")], "/anchor.jsonl", "sess-a", [])).toEqual([]);
  });
});

describe("scoreAgainst", () => {
  test("weighted: a long specific term counts double, matching is case-insensitive", () => {
    const { score, matched } = scoreAgainst(["additionalContextLimit", "훅"], "ADDITIONALCONTEXTLIMIT 관련 훅 논의");
    expect(matched.length).toBe(2);
    expect(score).toBe(3); // 2 (specific ascii ≥8) + 1 (short dense)
  });
});

describe("renderUpdateNextCommand", () => {
  test("shell-quotes workspace and transcript paths as inert argv", () => {
    expect(renderUpdateNextCommand("/repo with spaces/it's", "/tmp/$(touch PWNED); `id`.jsonl")).toBe(
      `llmwiki update-next '/repo with spaces/it'"'"'s' '/tmp/$(touch PWNED); \`id\`.jsonl'`,
    );
  });
});
