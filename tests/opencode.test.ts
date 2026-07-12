// OpenCode adapter — DB-backed harness via export materialization: discover() appends new
// session_message rows to an append-only neutral jsonl, so the byte-offset watermark core
// stays unchanged. Fixture = a real bun:sqlite DB mimicking OpenCode's projection tables.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeSource, setExportDir, opencodeDbPaths } from "../src/engine/sources/opencode.ts";

let dir: string;
let dbPath: string;
let prevEnv: string | undefined;

function seedDb(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER);
  `);
  db.exec(`INSERT INTO session VALUES ('s-oc-1', '/repo/oc', '결제 모듈 리팩터링', 1000, NULL)`);
  db.exec(`INSERT INTO session VALUES ('s-oc-archived', '/repo/oc', '지난 세션', 900, 999)`);
  const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
  ins.run("m1", "s-oc-1", "user", 1, JSON.stringify({ text: "결제 모듈 리팩터링 시작해줘" }), 1720000000000);
  ins.run("m2", "s-oc-1", "assistant", 2, JSON.stringify({ content: [{ type: "text", text: "A".repeat(200) }] }), 1720000001000);
  ins.run("m3", "s-oc-1", "tool", 3, JSON.stringify({ state: "completed" }), 1720000002000);
  ins.run("m4", "s-oc-1", "compaction", 4, JSON.stringify({ summary: "여기까지의 압축 요약", recent: "..." }), 1720000003000);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-oc-"));
  dbPath = join(dir, "opencode.db");
  prevEnv = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;
  setExportDir(join(dir, "export"));
  seedDb();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode adapter", () => {
  test("db discovery honors $OPENCODE_DB; absent db → no sessions", () => {
    expect(opencodeDbPaths()).toEqual([dbPath]);
    process.env.OPENCODE_DB = join(dir, "nope.db");
    expect(opencodeDbPaths()).toEqual([]);
    expect(opencodeSource.discover()).toEqual([]);
  });

  test("discover materializes an append-only export; archived sessions skipped", () => {
    const found = opencodeSource.discover();
    expect(found.length).toBe(1); // archived one skipped
    const s = found[0]!;
    expect(s.sessionId).toBe("s-oc-1");
    expect(s.repo).toBe("/repo/oc");
    const lines = readFileSync(s.path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(3); // meta + user + assistant (tool/compaction not dialog)
    expect(JSON.parse(lines[0]!).kind).toBe("opencode-meta");

    // incremental: re-discover adds nothing (seq watermark in sidecar)
    const again = opencodeSource.discover();
    const lines2 = readFileSync(again[0]!.path, "utf-8").split("\n").filter(Boolean);
    expect(lines2.length).toBe(3);

    // new row appears → exactly one appended line
    const db = new Database(dbPath);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(
      "m5", "s-oc-1", "user", 5, JSON.stringify({ text: "이어서 진행해줘" }), 1720000004000);
    db.close();
    opencodeSource.discover();
    const lines3 = readFileSync(s.path, "utf-8").split("\n").filter(Boolean);
    expect(lines3.length).toBe(4);
  });

  test("probe + parse roundtrip over the export file", () => {
    const s = opencodeSource.discover()[0]!;
    const probed = opencodeSource.probe(s.path);
    expect(probed?.sessionId).toBe("s-oc-1");
    expect(probed?.repo).toBe("/repo/oc");
    expect(opencodeSource.probe("/elsewhere/foo.jsonl")).toBeNull();

    const inc = opencodeSource.parse(s.path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("결제 모듈");
    expect(inc.assistants.length).toBe(1);
    expect(inc.cwd).toBe("/repo/oc");
    expect(inc.sessionId).toBe("s-oc-1");
    // watermark: nothing new on a second pass
    const again = opencodeSource.parse(s.path, inc.newOffset);
    expect(again.users.length).toBe(0);
  });

  test("summaryFor reuses the latest compaction row; recapFor uses the session title", () => {
    const s = opencodeSource.discover()[0]!;
    expect(opencodeSource.summaryFor!(s.path)).toBe("여기까지의 압축 요약");
    expect(opencodeSource.recapFor!(s.path)).toBe("결제 모듈 리팩터링");
  });
});
