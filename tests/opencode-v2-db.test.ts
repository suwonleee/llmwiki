// OpenCode 2 database capture. 2.0.27 migrates the 1.x database IN PLACE (measured on a copy of a
// real 1.19 DB): every session is copied into `session_v2` with its message ids kept in
// `session_message`, new sessions are written only to the V2 tables, and the legacy
// `session`/`message`/`part` tables stay behind, frozen. These fixtures pin:
//   - a session that exists only in session_v2 is discovered and exported
//   - an assistant row rewritten in place still changes the poll revision
//   - a session exported through the 1.x cursor hands over to the seq cursor once it gets turns
//     after the upgrade — exactly the new turns, nothing twice — while an untouched one stays put
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import {
  discoverOpenCodeRoutes,
  isOpenCodeChildSession,
  opencodeSource,
  setExportDir,
} from "../src/engine/sources/opencode.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";
import * as capture from "../src/engine/capture.ts";

let dir: string;
let dbPath: string;
let prevEnv: string | undefined;
let repo: string;

const OLD = 1720000000000;

const V2_TABLES = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT NOT NULL,
    title TEXT, time_created INTEGER, time_updated INTEGER NOT NULL, time_archived INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;
const LEGACY_TABLES = `
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, time_archived INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT);
`;

function v2Row(db: Database, id: string, session: string, seq: number, type: "user" | "assistant", text: string): void {
  const data =
    type === "user"
      ? { time: { created: OLD + seq }, text, files: [] }
      : { time: { created: OLD + seq, completed: OLD + seq + 1 }, content: [{ type: "text", text }] };
  db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(
    id,
    session,
    type,
    seq,
    OLD + seq,
    OLD + seq,
    JSON.stringify(data),
  );
}

function legacyTurn(db: Database, id: string, session: string, role: "user" | "assistant", text: string, at: number): void {
  const data = role === "user" ? { role, time: { created: at } } : { role, time: { created: at, completed: at + 1 } };
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(id, session, at, at, JSON.stringify(data));
  db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(`prt_${id}`, id, session, at, at, JSON.stringify({ type: "text", text }));
}

function dialog(path: string): [string, string][] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .slice(1)
    .map((l) => JSON.parse(l))
    .map((d) => [d.role, d.text]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-ocv2-"));
  dbPath = join(dir, "opencode.db");
  prevEnv = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;
  setExportDir(join(dir, "state", "opencode-export"));
  repo = enrollRepo(makeGitRepo(join(dir, "repo")));
});
afterEach(() => {
  setEffectiveStateRoot(null);
  if (prevEnv === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode 2 database", () => {
  test("a session that exists only in session_v2 is discovered and exported", () => {
    const db = new Database(dbPath);
    db.exec(V2_TABLES);
    db.run("INSERT INTO session_v2 VALUES ('ses_new', 'p', NULL, ?, '새 세션', ?, ?, NULL)", [repo, OLD, OLD]);
    db.run("INSERT INTO session_v2 VALUES ('ses_child', 'p', 'ses_new', ?, 'task', ?, ?, NULL)", [repo, OLD, OLD]);
    v2Row(db, "msg_a", "ses_new", 0, "user", "V2 스키마 캡처 확인");
    v2Row(db, "msg_b", "ses_new", 1, "assistant", "확인했습니다.");
    db.close();

    const found = opencodeSource.discover().filter((s) => s.sessionId === "ses_new");
    expect(found).toHaveLength(1);
    expect(dialog(found[0]!.path)).toEqual([
      ["user", "V2 스키마 캡처 확인"],
      ["assistant", "확인했습니다."],
    ]);
    expect(isOpenCodeChildSession(found[0]!.path, [realpathSync(dbPath)])).toBe(false);
  });

  test("an expanded /wiki-* command template is not a human turn", () => {
    const db = new Database(dbPath);
    db.exec(V2_TABLES);
    db.run("INSERT INTO session_v2 VALUES ('ses_cmd', 'p', NULL, ?, 'cmd', ?, ?, NULL)", [repo, OLD, OLD]);
    v2Row(db, "msg_a", "ses_cmd", 0, "user", "실제 사람의 지시");
    v2Row(db, "msg_b", "ses_cmd", 1, "user", "<!-- llmwiki-opencode-managed root=/x source_sha256=y -->\n\n# /wiki-save");
    db.close();
    const s = opencodeSource.discover().find((x) => x.sessionId === "ses_cmd")!;
    expect(opencodeSource.parse(s.path, 0).users.map((u) => u.text)).toEqual(["실제 사람의 지시"]);
  });

  test("an assistant row rewritten in place changes the poll revision", () => {
    const db = new Database(dbPath);
    db.exec(V2_TABLES);
    db.run("INSERT INTO session_v2 VALUES ('ses_rev', 'p', NULL, ?, 'rev', ?, ?, NULL)", [repo, OLD, OLD]);
    v2Row(db, "msg_a", "ses_rev", 0, "assistant", "부분");
    db.close();
    const initial = discoverOpenCodeRoutes([realpathSync(dbPath)])[0]!;
    expect(initial.revision).toBeDefined();
    expect(initial.alwaysMaterialize).toBeUndefined();
    expect(discoverOpenCodeRoutes([realpathSync(dbPath)])[0]!.revision).toBe(initial.revision);

    const streamed = new Database(dbPath);
    streamed.run("UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'msg_a'", [
      JSON.stringify({ content: [{ type: "text", text: "완성" }] }),
      OLD + 99,
    ]);
    streamed.close();
    expect(discoverOpenCodeRoutes([realpathSync(dbPath)])[0]!.revision).not.toBe(initial.revision);
  });

  test("a 1.x-exported session hands over to the seq cursor after the upgrade", () => {
    // Before the upgrade: a 1.x database, both sessions exported through the message-id cursor.
    const db = new Database(dbPath);
    db.exec(LEGACY_TABLES);
    for (const id of ["ses_cont", "ses_idle"]) {
      db.run("INSERT INTO session VALUES (?, ?, ?, 1000, NULL)", [id, repo, id]);
      legacyTurn(db, `msg_${id}_1`, id, "user", `${id} 첫 지시`, OLD + 1);
      legacyTurn(db, `msg_${id}_2`, id, "assistant", `${id} 첫 답변`, OLD + 2);
    }
    db.close();
    const before = opencodeSource.discover();
    const dbReal = realpathSync(dbPath);
    expect(capture.getOpenCodeV1Progress(dbReal, "ses_cont")).toBe("msg_ses_cont_2");
    const contPath = before.find((s) => s.sessionId === "ses_cont")!.path;

    // The upgrade: sessions and messages copied into the V2 tables with ids kept; then ses_cont
    // continues in OpenCode 2, which writes only to session_message.
    const up = new Database(dbPath);
    up.exec(V2_TABLES);
    for (const id of ["ses_cont", "ses_idle"]) {
      up.run("INSERT INTO session_v2 VALUES (?, 'p', NULL, ?, ?, ?, ?, NULL)", [id, repo, id, OLD, OLD + 5]);
      v2Row(up, `msg_${id}_1`, id, 0, "user", `${id} 첫 지시`);
      v2Row(up, `msg_${id}_2`, id, 1, "assistant", `${id} 첫 답변`);
    }
    v2Row(up, "msg_v2_user", "ses_cont", 2, "user", "업그레이드 뒤 이어서");
    v2Row(up, "msg_v2_asst", "ses_cont", 3, "assistant", "새 턴 답변");
    up.close();

    opencodeSource.discover();
    expect(dialog(contPath)).toEqual([
      ["user", "ses_cont 첫 지시"],
      ["assistant", "ses_cont 첫 답변"],
      ["user", "업그레이드 뒤 이어서"],
      ["assistant", "새 턴 답변"],
    ]);
    expect(capture.getOpenCodeProgress(dbReal, "ses_cont")).toBe(3);
    // the untouched session keeps its original cursor
    expect(capture.getOpenCodeProgress(dbReal, "ses_idle")).toBeNull();
    // idempotent
    opencodeSource.discover();
    expect(dialog(contPath)).toHaveLength(4);
  });

  // Review finding: 2.0.27 does not migrate compaction-summary assistants (measured: the only 3
  // legacy rows missing from session_message on a real database), and the 1.x cursor can rest on one.
  test("a 1.x cursor resting on an unmigrated summary row still hands over, by time", () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_TABLES);
    db.run("INSERT INTO session VALUES ('ses_sum', ?, 'sum', 1000, NULL)", [repo]);
    legacyTurn(db, "msg_1", "ses_sum", "user", "요약 전 지시", OLD + 1);
    legacyTurn(db, "msg_2", "ses_sum", "assistant", "요약 전 답변", OLD + 2);
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
      "msg_3",
      "ses_sum",
      OLD + 3,
      OLD + 3,
      JSON.stringify({ role: "assistant", summary: true, time: { created: OLD + 3, completed: OLD + 4 } }),
    );
    db.close();
    const path = opencodeSource.discover().find((s) => s.sessionId === "ses_sum")!.path;
    const dbReal = realpathSync(dbPath);
    expect(capture.getOpenCodeV1Progress(dbReal, "ses_sum")).toBe("msg_3");

    const up = new Database(dbPath);
    up.exec(V2_TABLES);
    up.run("INSERT INTO session_v2 VALUES ('ses_sum', 'p', NULL, ?, 'sum', ?, ?, NULL)", [repo, OLD, OLD + 9]);
    v2Row(up, "msg_1", "ses_sum", 1, "user", "요약 전 지시");
    v2Row(up, "msg_2", "ses_sum", 2, "assistant", "요약 전 답변");
    v2Row(up, "msg_new", "ses_sum", 5, "user", "업그레이드 뒤 지시");
    up.close();

    opencodeSource.discover();
    expect(dialog(path)).toEqual([
      ["user", "요약 전 지시"],
      ["assistant", "요약 전 답변"],
      ["user", "업그레이드 뒤 지시"],
    ]);
  });

  // Review finding: the seq cursor is written before the sidecar; a crash between the two left a
  // 1.x-format sidecar that the seq branch refused forever.
  test("a 1.x sidecar left behind by an interrupted handover does not wedge the session", () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_TABLES);
    db.run("INSERT INTO session VALUES ('ses_crash', ?, 'crash', 1000, NULL)", [repo]);
    legacyTurn(db, "msg_1", "ses_crash", "user", "첫 지시", OLD + 1);
    db.close();
    const path = opencodeSource.discover().find((s) => s.sessionId === "ses_crash")!.path;
    const up = new Database(dbPath);
    up.exec(V2_TABLES);
    up.run("INSERT INTO session_v2 VALUES ('ses_crash', 'p', NULL, ?, 'crash', ?, ?, NULL)", [repo, OLD, OLD + 9]);
    v2Row(up, "msg_1", "ses_crash", 0, "user", "첫 지시");
    v2Row(up, "msg_new", "ses_crash", 1, "user", "이어진 지시");
    up.close();
    capture.advanceOpenCodeProgress(realpathSync(dbPath), "ses_crash", 0); // cursor moved, sidecar not

    opencodeSource.discover();
    expect(dialog(path)).toEqual([
      ["user", "첫 지시"],
      ["user", "이어진 지시"],
    ]);
  });

  test("with the legacy tables gone, every remaining row counts as post-upgrade", () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_TABLES);
    db.run("INSERT INTO session VALUES ('ses_gone', ?, 'gone', 1000, NULL)", [repo]);
    legacyTurn(db, "msg_1", "ses_gone", "user", "첫 지시", OLD + 1);
    db.close();
    const path = opencodeSource.discover().find((s) => s.sessionId === "ses_gone")!.path;
    const up = new Database(dbPath);
    up.exec(V2_TABLES);
    up.run("INSERT INTO session_v2 VALUES ('ses_gone', 'p', NULL, ?, 'gone', ?, ?, NULL)", [repo, OLD, OLD + 9]);
    v2Row(up, "msg_1", "ses_gone", 0, "user", "첫 지시");
    v2Row(up, "msg_new", "ses_gone", 1, "user", "레거시 삭제 뒤 지시");
    up.exec("DROP TABLE part; DROP TABLE message; DROP TABLE session;");
    up.close();

    opencodeSource.discover();
    expect(dialog(path)).toEqual([
      ["user", "첫 지시"],
      ["user", "레거시 삭제 뒤 지시"],
    ]);
  });

  test("discovery on a 2.x database never falls back to the frozen 1.x session table", () => {
    const db = new Database(dbPath);
    db.exec(LEGACY_TABLES);
    db.run("INSERT INTO session VALUES ('ses_old', ?, 'old', 1000, NULL)", [repo]);
    // a 2.x release whose session_message has no time_updated: the revision query fails
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);`);
    db.run("INSERT INTO session_v2 VALUES ('ses_old', ?, 1, NULL), ('ses_new', ?, 2, NULL)", [repo, repo]);
    db.close();
    const routes = discoverOpenCodeRoutes([realpathSync(dbPath)]);
    expect(routes.map((r) => r.sessionId).sort()).toEqual(["ses_new", "ses_old"]);
    expect(routes.every((r) => r.alwaysMaterialize)).toBe(true);
  });
});

