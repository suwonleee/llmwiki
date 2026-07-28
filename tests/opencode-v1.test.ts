// OpenCode v1 (legacy `message`+`part`) capture — the schema every INSTALLED OpenCode session
// actually uses. The 2026-07-28 audit found the adapter read only `session_message`, which is
// empty on a real 1.18.4 machine (all conversation rows in message/part) — so auto-capture
// exported nothing while every synthetic-fixture test passed. These fixtures mirror the real
// projection shape (both tables present, `session_message` EMPTY) and pin:
//   - user/assistant dialog exports from `message`+`part` following MessageV2's hydrate rules
//   - the settled boundary: a mid-generation sweep never advances the cursor past an
//     unfinished assistant, so the FINAL answer text is never lost (both schemas)
//   - per-session schema choice when both projections carry rows in one DB
//   - idempotent re-sweeps and journal-recovered interrupted appends (no duplicate lines)
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeSource, setExportDir } from "../src/engine/sources/opencode.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";
import * as capture from "../src/engine/capture.ts";

let dir: string;
let dbPath: string;
let prevEnv: string | undefined;
let repo: string;

const OLD = 1720000000000; // fixed 2024-07 timestamp — far past the streaming grace

function userData(created = OLD): string {
  return JSON.stringify({ role: "user", time: { created }, agent: "build", model: { providerID: "p", modelID: "m" } });
}

function assistantData(opts: { created?: number; completed?: number; error?: any; summary?: boolean } = {}): string {
  const time: any = { created: opts.created ?? OLD };
  if (opts.completed) time.completed = opts.completed;
  const data: any = {
    role: "assistant",
    time,
    parentID: "msg_p",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  if (opts.error) data.error = opts.error;
  if (opts.summary) data.summary = true;
  return JSON.stringify(data);
}

function textPart(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "text", text, ...extra });
}

/** Both projection tables exist — exactly like the installed 1.18.4 DB — but only v1 has rows. */
function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
}

function insertMessage(db: Database, id: string, session: string, data: string, created = OLD): void {
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(id, session, created, created, data);
}

function insertPart(db: Database, id: string, messageId: string, session: string, data: string): void {
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(id, messageId, session, OLD, OLD, data);
}

function bodyLines(path: string): string[] {
  return readFileSync(path, "utf-8").split("\n").filter(Boolean);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-ocv1-"));
  dbPath = join(dir, "opencode.db");
  prevEnv = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;
  setExportDir(join(dir, "state", "opencode-export"));
  repo = enrollRepo(makeGitRepo(join(dir, "repo")));
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode v1 (message+part) capture", () => {
  test("real-shape DB (empty session_message) exports dialog under MessageV2's rules", () => {
    const db = new Database(dbPath);
    createSchema(db);
    db.run("INSERT INTO session VALUES ('ses_v1', ?, '레거시 스키마 세션', 1000, NULL)", [repo]);
    insertMessage(db, "msg_01", "ses_v1", userData());
    insertPart(db, "prt_01a", "msg_01", "ses_v1", textPart("레거시 스키마로 캡처 테스트"));
    insertMessage(db, "msg_02", "ses_v1", assistantData({ completed: OLD + 500 }));
    insertPart(db, "prt_02a", "msg_02", "ses_v1", textPart("첫 문단."));
    insertPart(db, "prt_02b", "msg_02", "ses_v1", JSON.stringify({ type: "reasoning", text: "생각 중" }));
    insertPart(db, "prt_02c", "msg_02", "ses_v1", textPart("둘째 문단."));
    // an `ignored` user part is dropped; the remaining text still exports
    insertMessage(db, "msg_03", "ses_v1", userData());
    insertPart(db, "prt_03a", "msg_03", "ses_v1", textPart("무시되어야 함", { ignored: true }));
    insertPart(db, "prt_03b", "msg_03", "ses_v1", textPart("이어서 진행"));
    // a non-aborted errored assistant never becomes dialog (MessageV2 drops it from replay too)
    insertMessage(db, "msg_04", "ses_v1", assistantData({ error: { name: "APIError", data: { message: "boom" } } }));
    insertPart(db, "prt_04a", "msg_04", "ses_v1", textPart("에러난 응답"));
    // an aborted assistant that still carries text stays — the human interrupted, the text exists
    insertMessage(db, "msg_05", "ses_v1", assistantData({ error: { name: "MessageAbortedError", data: { message: "" } } }));
    insertPart(db, "prt_05a", "msg_05", "ses_v1", textPart("중단 전까지의 답변"));
    // the compaction summary (assistant summary=true) is summaryFor's material, never dialog
    insertMessage(db, "msg_06", "ses_v1", assistantData({ completed: OLD + 900, summary: true }));
    insertPart(db, "prt_06a", "msg_06", "ses_v1", textPart("여기까지의 압축 요약"));
    db.close();

    const found = opencodeSource.discover();
    expect(found).toHaveLength(1);
    const s = found[0]!;
    expect(s.sessionId).toBe("ses_v1");
    const lines = bodyLines(s.path);
    expect(JSON.parse(lines[0]!).kind).toBe("opencode-meta");
    const dialog = lines.slice(1).map((l) => JSON.parse(l));
    expect(dialog.map((d) => [d.role, d.text])).toEqual([
      ["user", "레거시 스키마로 캡처 테스트"],
      ["assistant", "첫 문단. 둘째 문단."],
      ["user", "이어서 진행"],
      ["assistant", "중단 전까지의 답변"],
    ]);
    // idempotent: a re-sweep adds nothing
    opencodeSource.discover();
    expect(bodyLines(s.path)).toHaveLength(lines.length);
    // the compaction summary is surfaced separately
    expect(opencodeSource.summaryFor?.(s.path)).toBe("여기까지의 압축 요약");
  });

  test("mid-generation sweep never loses the final assistant text (v1 settled boundary)", () => {
    const now = Date.now();
    const db = new Database(dbPath);
    createSchema(db);
    db.run("INSERT INTO session VALUES ('ses_live', ?, '생성 중 세션', 1000, NULL)", [repo]);
    insertMessage(db, "msg_01", "ses_live", userData(now - 60_000), now - 60_000);
    insertPart(db, "prt_01a", "msg_01", "ses_live", textPart("긴 작업 요청 — 아직 답변 생성 중"));
    // the answer is STREAMING: row exists, partial text, no time.completed, no later row
    insertMessage(db, "msg_02", "ses_live", assistantData({ created: now - 30_000 }), now - 30_000);
    insertPart(db, "prt_02a", "msg_02", "ses_live", textPart("부분 답변"));
    db.close();

    const dbReal = realpathSync(dbPath);
    const first = opencodeSource.discover()[0]!;
    let dialog = bodyLines(first.path).slice(1).map((l) => JSON.parse(l));
    expect(dialog.map((d) => d.role)).toEqual(["user"]); // assistant not settled → not exported
    expect(capture.getOpenCodeV1Progress(dbReal, "ses_live")).toBe("msg_01");

    // the turn finishes: same row, same id — data gains time.completed, part gains the full text
    const db2 = new Database(dbPath);
    db2.run("UPDATE message SET data = ? WHERE id = 'msg_02'", [
      assistantData({ created: now - 30_000, completed: now }),
    ]);
    db2.run("UPDATE part SET data = ? WHERE id = 'prt_02a'", [textPart("최종 완성 답변 전체 텍스트")]);
    db2.close();

    const second = opencodeSource.discover()[0]!;
    dialog = bodyLines(second.path).slice(1).map((l) => JSON.parse(l));
    expect(dialog.map((d) => [d.role, d.text])).toEqual([
      ["user", "긴 작업 요청 — 아직 답변 생성 중"],
      ["assistant", "최종 완성 답변 전체 텍스트"],
    ]);
    expect(capture.getOpenCodeV1Progress(dbReal, "ses_live")).toBe("msg_02");
    // and the completed row is exported exactly once
    opencodeSource.discover();
    expect(bodyLines(second.path).join("\n").match(/최종 완성 답변 전체 텍스트/g)?.length).toBe(1);
  });

  test("per-session schema choice: session_message rows win for their session, v1 for theirs", () => {
    const db = new Database(dbPath);
    createSchema(db);
    db.run("INSERT INTO session VALUES ('ses_next', ?, '새 프로젝션', 2000, NULL)", [repo]);
    db.run("INSERT INTO session VALUES ('ses_old', ?, '레거시 프로젝션', 1000, NULL)", [repo]);
    const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    ins.run("m1", "ses_next", "user", 1, JSON.stringify({ text: "새 스키마 사용자 메시지" }), OLD);
    ins.run(
      "m2",
      "ses_next",
      "assistant",
      2,
      JSON.stringify({ content: [{ type: "text", text: "새 스키마 답변" }], time: { created: OLD, completed: OLD + 1 } }),
      OLD,
    );
    insertMessage(db, "msg_01", "ses_old", userData());
    insertPart(db, "prt_01a", "msg_01", "ses_old", textPart("레거시 스키마 사용자 메시지"));
    insertMessage(db, "msg_02", "ses_old", assistantData({ completed: OLD + 1 }));
    insertPart(db, "prt_02a", "msg_02", "ses_old", textPart("레거시 스키마 답변"));
    db.close();

    const found = opencodeSource.discover();
    const byId = new Map(found.map((s) => [s.sessionId, s]));
    expect([...byId.keys()].sort()).toEqual(["ses_next", "ses_old"]);
    const nextDialog = bodyLines(byId.get("ses_next")!.path).slice(1).map((l) => JSON.parse(l).text);
    const oldDialog = bodyLines(byId.get("ses_old")!.path).slice(1).map((l) => JSON.parse(l).text);
    expect(nextDialog).toEqual(["새 스키마 사용자 메시지", "새 스키마 답변"]);
    expect(oldDialog).toEqual(["레거시 스키마 사용자 메시지", "레거시 스키마 답변"]);
  });

  test("session_message: an in-place-updated empty assistant row keeps its seq until settled", () => {
    const now = Date.now();
    const db = new Database(dbPath);
    createSchema(db);
    db.run("INSERT INTO session VALUES ('ses_seq', ?, 'seq 커서 세션', 1000, NULL)", [repo]);
    const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    ins.run("m1", "ses_seq", "user", 1, JSON.stringify({ text: "스트리밍 중 sweep 테스트" }), now - 60_000);
    // step.started appended an EMPTY assistant row; deltas will update it under the SAME seq
    ins.run("m2", "ses_seq", "assistant", 2, JSON.stringify({ content: [], time: { created: now - 30_000 } }), now - 30_000);
    db.close();

    const dbReal = realpathSync(dbPath);
    const first = opencodeSource.discover()[0]!;
    expect(bodyLines(first.path).slice(1).map((l) => JSON.parse(l).role)).toEqual(["user"]);
    expect(capture.getOpenCodeProgress(dbReal, "ses_seq")).toBe(1); // NOT 2 — the row is not settled

    const db2 = new Database(dbPath);
    db2.run("UPDATE session_message SET data = ? WHERE session_id = 'ses_seq' AND seq = 2", [
      JSON.stringify({
        content: [{ type: "text", text: "완성된 최종 답변" }],
        time: { created: now - 30_000, completed: now },
      }),
    ]);
    db2.close();

    const second = opencodeSource.discover()[0]!;
    const dialog = bodyLines(second.path).slice(1).map((l) => JSON.parse(l));
    expect(dialog.map((d) => [d.role, d.text])).toEqual([
      ["user", "스트리밍 중 sweep 테스트"],
      ["assistant", "완성된 최종 답변"],
    ]);
    expect(capture.getOpenCodeProgress(dbReal, "ses_seq")).toBe(2);
    opencodeSource.discover();
    expect(bodyLines(second.path).join("\n").match(/완성된 최종 답변/g)?.length).toBe(1);
  });

  test("an interrupted v1 append resumes from its body-free journal without duplication", () => {
    const db = new Database(dbPath);
    createSchema(db);
    db.run("INSERT INTO session VALUES ('ses_v1', ?, '복구 세션', 1000, NULL)", [repo]);
    insertMessage(db, "msg_01", "ses_v1", userData());
    insertPart(db, "prt_01a", "msg_01", "ses_v1", textPart("첫 메시지"));
    insertMessage(db, "msg_02", "ses_v1", assistantData({ completed: OLD + 1 }));
    insertPart(db, "prt_02a", "msg_02", "ses_v1", textPart("첫 답변"));
    db.close();
    const first = opencodeSource.discover()[0]!;

    const db2 = new Database(dbPath);
    insertMessage(db2, "msg_03", "ses_v1", userData(OLD + 4000), OLD + 4000);
    insertPart(db2, "prt_03a", "msg_03", "ses_v1", textPart("중단 뒤 복구할 메시지"));
    db2.close();
    const ts = new Date(OLD + 4000).toISOString().slice(0, 16);
    const appended = JSON.stringify({ role: "user", text: "중단 뒤 복구할 메시지", ts }) + "\n";
    const bytes = Buffer.from(appended);
    const dbReal = realpathSync(dbPath);
    capture.beginOpenCodeV1Append(dbReal, "ses_v1", {
      exportPath: first.path,
      baseSize: statSync(first.path).size,
      fromMessageId: "msg_02",
      throughMessageId: "msg_03",
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    appendFileSync(first.path, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const recovered = opencodeSource.discover()[0]!;
    const body = readFileSync(recovered.path, "utf-8");
    expect(body.match(/중단 뒤 복구할 메시지/g)?.length).toBe(1);
    expect(capture.getOpenCodeV1Append(dbReal, "ses_v1")).toBeNull();
    expect(capture.getOpenCodeV1Progress(dbReal, "ses_v1")).toBe("msg_03");
  });

  test("a DB with no session_message table at all still captures via v1", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.run("INSERT INTO session VALUES ('ses_only', ?, '테이블 자체가 없는 DB', 1000, NULL)", [repo]);
    insertMessage(db, "msg_01", "ses_only", userData());
    insertPart(db, "prt_01a", "msg_01", "ses_only", textPart("드리프트 내성 확인"));
    insertMessage(db, "msg_02", "ses_only", assistantData({ completed: OLD + 1 }));
    insertPart(db, "prt_02a", "msg_02", "ses_only", textPart("정상 캡처"));
    db.close();

    const found = opencodeSource.discover();
    expect(found).toHaveLength(1);
    const dialog = bodyLines(found[0]!.path).slice(1).map((l) => JSON.parse(l).text);
    expect(dialog).toEqual(["드리프트 내성 확인", "정상 캡처"]);
  });
});
