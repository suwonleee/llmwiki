// OpenCode adapter — DB-backed harness via export materialization: discover() appends new
// session_message rows to an append-only neutral jsonl, so the byte-offset watermark core
// stays unchanged. Fixture = a real bun:sqlite DB mimicking OpenCode's projection tables.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeSource, setExportDir, opencodeDbPaths } from "../src/engine/sources/opencode.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";
import { ensureOwnedStateRoot } from "../src/engine/state-dir.ts";
import * as capture from "../src/engine/capture.ts";

let dir: string;
let dbPath: string;
let prevEnv: string | undefined;
let repo: string;

function seedDb(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER);
  `);
  db.run("INSERT INTO session VALUES ('s-oc-1', ?, '결제 모듈 리팩터링', 1000, NULL)", [repo]);
  db.run("INSERT INTO session VALUES ('s-oc-archived', ?, '지난 세션', 900, 999)", [repo]);
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
  setExportDir(join(dir, "state", "opencode-export"));
  repo = enrollRepo(makeGitRepo(join(dir, "repo")));
  seedDb();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("opencode adapter", () => {
  test("db discovery honors $OPENCODE_DB; absent db → no sessions", () => {
    expect(opencodeDbPaths()).toEqual([realpathSync(dbPath)]);
    process.env.OPENCODE_DB = join(dir, "nope.db");
    expect(opencodeDbPaths()).toEqual([]);
    expect(opencodeSource.discover()).toEqual([]);
  });

  test("discover materializes an append-only export; archived sessions skipped", () => {
    const found = opencodeSource.discover();
    expect(found.length).toBe(1); // archived one skipped
    const s = found[0]!;
    expect(s.sessionId).toBe("s-oc-1");
    expect(s.repo).toBe(realpathSync(repo));
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

  test("a matching v0.8 body migrates only its progress and new content uses a modern identity", () => {
    const stateRoot = join(dir, "state");
    const exportDir = join(stateRoot, "opencode-export");
    ensureOwnedStateRoot(stateRoot);
    mkdirSync(exportDir);
    const legacyPath = join(exportDir, "s-oc-1.jsonl");
    const legacyProgress = join(exportDir, "s-oc-1.meta.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        kind: "opencode-meta",
        sessionID: "s-oc-1",
        directory: realpathSync(repo),
        title: "결제 모듈 리팩터링",
      }) +
        "\n" +
        JSON.stringify({ role: "user", text: "결제 모듈 리팩터링 시작해줘", ts: "2024-07-03T09:46" }) +
        "\n" +
        JSON.stringify({ role: "assistant", text: "A".repeat(200), ts: "2024-07-03T09:46" }) +
        "\n",
    );
    writeFileSync(legacyProgress, JSON.stringify({ lastSeq: 4 }));

    const legacyBefore = readFileSync(legacyPath, "utf-8");
    expect(opencodeSource.discover()).toEqual([]);
    expect(capture.getOpenCodeProgress(realpathSync(dbPath), "s-oc-1")).toBe(4);
    expect(readdirSync(exportDir).sort()).toEqual(["s-oc-1.jsonl", "s-oc-1.meta.json"]);
    expect(readFileSync(legacyProgress, "utf-8")).toBe(JSON.stringify({ lastSeq: 4 }));
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBefore);

    const db = new Database(dbPath);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(
      "m5",
      "s-oc-1",
      "user",
      5,
      JSON.stringify({ text: "이어서 진행해줘" }),
      1720000004000,
    );
    db.close();
    const second = opencodeSource.discover()[0]!;

    expect(second.path).not.toBe(realpathSync(legacyPath));
    const modernLines = readFileSync(second.path, "utf-8").split("\n").filter(Boolean);
    expect(modernLines).toHaveLength(2);
    expect(modernLines[1]).toContain("이어서 진행해줘");
    expect(modernLines.join("\n")).not.toContain("결제 모듈 리팩터링 시작해줘");
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBefore);
  });

  test("a colliding foreign DB processed first cannot claim or modify a matching legacy export", () => {
    const stateRoot = join(dir, "state");
    const exportDir = join(stateRoot, "opencode-export");
    ensureOwnedStateRoot(stateRoot);
    mkdirSync(exportDir);
    const legacyPath = join(exportDir, "s-oc-1.jsonl");
    const legacyProgress = join(exportDir, "s-oc-1.meta.json");
    const legacyBody =
      JSON.stringify({
        kind: "opencode-meta",
        sessionID: "s-oc-1",
        directory: realpathSync(repo),
        title: "결제 모듈 리팩터링",
      }) +
      "\n" +
      JSON.stringify({ role: "user", text: "결제 모듈 리팩터링 시작해줘", ts: "2024-07-03T09:46" }) +
      "\n" +
      JSON.stringify({ role: "assistant", text: "A".repeat(200), ts: "2024-07-03T09:46" }) +
      "\n";
    writeFileSync(legacyPath, legacyBody);
    writeFileSync(legacyProgress, JSON.stringify({ lastSeq: 4 }));

    const otherDbPath = join(dir, "opencode-other.db");
    const other = new Database(otherDbPath);
    other.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER);
    `);
    other.run("INSERT INTO session VALUES ('s-oc-1', ?, 'other database', 1000, NULL)", [repo]);
    other.run(
      "INSERT INTO session_message VALUES ('other-m1', 's-oc-1', 'user', 1, ?, 1720000000000)",
      [JSON.stringify({ text: "FROM-OTHER-DATABASE" })],
    );
    other.run(
      "INSERT INTO session_message VALUES ('other-m2', 's-oc-1', 'assistant', 2, ?, 1720000001000)",
      [JSON.stringify({ content: [{ type: "text", text: "C".repeat(200) }] })],
    );
    other.run(
      "INSERT INTO session_message VALUES ('other-m3', 's-oc-1', 'tool', 3, ?, 1720000002000)",
      [JSON.stringify({ state: "completed" })],
    );
    other.run(
      "INSERT INTO session_message VALUES ('other-m4', 's-oc-1', 'compaction', 4, ?, 1720000003000)",
      [JSON.stringify({ summary: "other" })],
    );
    other.close();
    process.env.OPENCODE_DB = otherDbPath;

    const fromOther = opencodeSource.discover()[0]!;
    expect(fromOther.path).not.toBe(realpathSync(legacyPath));
    expect(readFileSync(legacyPath, "utf-8")).not.toContain("FROM-OTHER-DATABASE");
    expect(readFileSync(fromOther.path, "utf-8")).toContain("FROM-OTHER-DATABASE");

    process.env.OPENCODE_DB = dbPath;
    expect(opencodeSource.discover()).toEqual([]);
    expect(capture.getOpenCodeProgress(realpathSync(dbPath), "s-oc-1")).toBe(4);
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyBody);
    expect(readFileSync(legacyProgress, "utf-8")).toBe(JSON.stringify({ lastSeq: 4 }));
  });

  test("TTL removes transcript bodies but the durable ledger exports only later messages", () => {
    const first = opencodeSource.discover()[0]!;
    const progressPath = first.path.replace(/\.jsonl$/, ".meta.json");
    expect(readFileSync(first.path, "utf-8")).toContain("결제 모듈 리팩터링 시작해줘");
    expect(capture.getOpenCodeProgress(realpathSync(dbPath), "s-oc-1")).toBe(4);
    capture.enqueue(first.path, "s-oc-1", realpathSync(repo), first.lines, "opencode");
    capture.mark(first.path, statSync(first.path).size, "distilled");
    const ancient = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(first.path, ancient, ancient);
    utimesSync(progressPath, ancient, ancient);

    expect(capture.pruneExports().pairs).toBe(1);
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(progressPath)).toBe(false);

    const db = new Database(dbPath);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(
      "m5",
      "s-oc-1",
      "user",
      5,
      JSON.stringify({ text: "TTL 이후 새 메시지" }),
      1720000004000,
    );
    db.close();

    const next = opencodeSource.discover()[0]!;
    // Simulate a process dying after the new export file is durable but before daemon enqueue.
    // A restart/materialize pass must leave enough identity for enqueue to reopen the old row.
    expect(opencodeSource.discover()[0]!.path).toBe(next.path);
    capture.enqueue(next.path, "s-oc-1", realpathSync(repo), next.lines, "opencode");
    const lines = readFileSync(next.path, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("TTL 이후 새 메시지");
    expect(lines.join("\n")).not.toContain("결제 모듈 리팩터링 시작해줘");
    expect(capture.pending(realpathSync(repo)).map((row) => row.transcript_path)).toEqual([next.path]);
  });

  test("an interrupted append resumes from its durable body-free journal without duplication", () => {
    const first = opencodeSource.discover()[0]!;
    const db = new Database(dbPath);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(
      "m5",
      "s-oc-1",
      "user",
      5,
      JSON.stringify({ text: "중단 뒤 복구할 메시지" }),
      1720000004000,
    );
    db.close();
    const appended =
      JSON.stringify({ role: "user", text: "중단 뒤 복구할 메시지", ts: "2024-07-03T09:46" }) + "\n";
    const bytes = Buffer.from(appended);
    const baseSize = statSync(first.path).size;
    capture.beginOpenCodeAppend(realpathSync(dbPath), "s-oc-1", {
      exportPath: first.path,
      baseSize,
      fromSeq: 4,
      throughSeq: 5,
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    appendFileSync(first.path, bytes.subarray(0, Math.floor(bytes.length / 2)));

    const recovered = opencodeSource.discover()[0]!;
    const body = readFileSync(recovered.path, "utf-8");

    expect(body.match(/중단 뒤 복구할 메시지/g)?.length).toBe(1);
    expect(capture.getOpenCodeAppend(realpathSync(dbPath), "s-oc-1")).toBeNull();
    expect(capture.getOpenCodeProgress(realpathSync(dbPath), "s-oc-1")).toBe(5);
  });

  test("a live append owner cannot be mistaken for a crashed writer", async () => {
    const first = opencodeSource.discover()[0]!;
    const db = new Database(dbPath);
    db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(
      "m5",
      "s-oc-1",
      "user",
      5,
      JSON.stringify({ text: "동시 작성 보호" }),
      1720000004000,
    );
    db.close();
    const appended = JSON.stringify({ role: "user", text: "동시 작성 보호", ts: "2024-07-03T09:46" }) + "\n";
    const bytes = Buffer.from(appended);
    const owner = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    capture.beginOpenCodeAppend(realpathSync(dbPath), "s-oc-1", {
      exportPath: first.path,
      baseSize: statSync(first.path).size,
      fromSeq: 4,
      throughSeq: 5,
      expectedBytes: bytes.length,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    }, capture.openCodeOwner(owner.pid));

    expect(() => opencodeSource.discover()).toThrow("live or unverifiable process");
    expect(readFileSync(first.path, "utf-8")).not.toContain("동시 작성 보호");

    owner.kill();
    await owner.exited;
    const recovered = opencodeSource.discover()[0]!;
    expect(readFileSync(recovered.path, "utf-8").match(/동시 작성 보호/g)?.length).toBe(1);
  });

  test("only one contender can atomically claim a dead append owner", () => {
    const first = opencodeSource.discover()[0]!;
    const dead = { pid: -1, token: "legacy-unclaimed" };
    capture.beginOpenCodeAppend(
      realpathSync(dbPath),
      "s-oc-1",
      {
        exportPath: first.path,
        baseSize: statSync(first.path).size,
        fromSeq: 4,
        throughSeq: 4,
        expectedBytes: 0,
        expectedSha256: createHash("sha256").update("").digest("hex"),
      },
      dead,
    );
    const firstClaim = { pid: process.pid, token: "winner" };
    const secondClaim = { pid: process.pid, token: "loser" };

    expect(capture.claimOpenCodeAppend(realpathSync(dbPath), "s-oc-1", dead, firstClaim)).toBe(true);
    expect(capture.claimOpenCodeAppend(realpathSync(dbPath), "s-oc-1", dead, secondClaim)).toBe(false);
    expect(capture.getOpenCodeAppend(realpathSync(dbPath), "s-oc-1")?.ownerToken).toBe("winner");
  });

  test("append owner identity is stable across caller locales", () => {
    const originalLocale = process.env.LC_ALL;
    try {
      process.env.LC_ALL = "ko_KR.UTF-8";
      const korean = capture.openCodeOwner();
      process.env.LC_ALL = "fr_FR.UTF-8";
      const french = capture.openCodeOwner();

      expect(korean.token).toStartWith("ps-lstart-c-v1:");
      expect(french.token).toBe(korean.token);
      expect(capture.openCodeOwnerLive(korean)).toBe(true);
    } finally {
      if (originalLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLocale;
    }
  });

  test("a long legacy session keeps lifetime eligibility when its modern export is only a short tail", () => {
    const stateRoot = join(dir, "state");
    const exportDir = join(stateRoot, "opencode-export");
    ensureOwnedStateRoot(stateRoot);
    mkdirSync(exportDir);
    const id = "s-oc-long";
    const db = new Database(dbPath);
    db.run("INSERT INTO session VALUES (?, ?, 'long migration', 2000, NULL)", [id, repo]);
    const insert = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    const bodyLines: string[] = [];
    for (let seq = 1; seq <= 60; seq++) {
      const text = `legacy-${seq}`;
      insert.run(`long-${seq}`, id, "user", seq, JSON.stringify({ text }), 1720000000000 + seq);
      bodyLines.push(JSON.stringify({ role: "user", text, ts: "2024-07-03T09:46" }));
    }
    db.close();
    writeFileSync(
      join(exportDir, `${id}.jsonl`),
      JSON.stringify({ kind: "opencode-meta", sessionID: id, directory: realpathSync(repo), title: "long migration" }) +
        "\n" +
        bodyLines.join("\n") +
        "\n",
    );
    writeFileSync(join(exportDir, `${id}.meta.json`), JSON.stringify({ lastSeq: 60 }));

    expect(opencodeSource.discover().some((session) => session.sessionId === id)).toBe(false);
    const reopened = new Database(dbPath);
    reopened
      .prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)")
      .run("long-61", id, "user", 61, JSON.stringify({ text: "short modern tail" }), 1720000000061);
    reopened.close();

    const tail = opencodeSource.discover().find((session) => session.sessionId === id)!;
    const physicalLines = readFileSync(tail.path, "utf-8").split("\n").filter(Boolean);

    expect(physicalLines).toHaveLength(2);
    expect(tail.lines).toBe(62);
  });

  test("a daemon cycle migrates before retention and enqueues a short tail from a long legacy session", () => {
    const stateRoot = join(dir, "state");
    const exportDir = join(stateRoot, "opencode-export");
    ensureOwnedStateRoot(stateRoot);
    mkdirSync(exportDir);
    const id = "s-oc-daemon-long";
    const db = new Database(dbPath);
    db.run("INSERT INTO session VALUES (?, ?, 'daemon migration', 3000, NULL)", [id, repo]);
    const insert = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    const bodyLines: string[] = [];
    for (let seq = 1; seq <= 60; seq++) {
      const text = `daemon-legacy-${seq}`;
      insert.run(`daemon-${seq}`, id, "user", seq, JSON.stringify({ text }), 1720000000000 + seq);
      bodyLines.push(JSON.stringify({ role: "user", text, ts: "2024-07-03T09:46" }));
    }
    insert.run("daemon-61", id, "user", 61, JSON.stringify({ text: "daemon modern tail" }), 1720000000061);
    db.close();
    const legacyPath = join(exportDir, `${id}.jsonl`);
    const legacyMeta = join(exportDir, `${id}.meta.json`);
    writeFileSync(
      legacyPath,
      JSON.stringify({ kind: "opencode-meta", sessionID: id, directory: realpathSync(repo), title: "daemon migration" }) +
        "\n" +
        bodyLines.join("\n") +
        "\n",
    );
    writeFileSync(legacyMeta, JSON.stringify({ lastSeq: 60 }));
    const ancient = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(legacyPath, ancient, ancient);
    utimesSync(legacyMeta, ancient, ancient);

    const daemon = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "..", "src", "daemon", "watch.ts"), "--once"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: dir,
          CODEX_HOME: join(dir, "codex"),
          CLAUDE_CONFIG_DIR: join(dir, "claude"),
          OPENCODE_DB: dbPath,
          LLMWIKI_STATE_DIR: stateRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = daemon.stdout.toString() + daemon.stderr.toString();

    expect(daemon.exitCode).toBe(0);
    expect(output).toContain("enqueued=1");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyMeta)).toBe(false);
    const captureDb = new Database(join(stateRoot, "capture.db"), { readonly: true });
    const queued = captureDb
      .query("SELECT transcript_path, status FROM capture_queue WHERE session_id = ?")
      .get(id) as { transcript_path: string; status: string } | null;
    const progress = captureDb
      .query("SELECT last_seq FROM opencode_progress WHERE source_path = ? AND session_id = ?")
      .get(realpathSync(dbPath), id) as { last_seq: number } | null;
    captureDb.close();

    expect(queued?.status).toBe("pending");
    expect(readFileSync(queued!.transcript_path, "utf-8")).toContain("daemon modern tail");
    expect(readFileSync(queued!.transcript_path, "utf-8")).not.toContain("daemon-legacy-1");
    expect(progress?.last_seq).toBe(61);
  });

  test("probe + parse roundtrip over the export file", () => {
    const s = opencodeSource.discover()[0]!;
    const probed = opencodeSource.probe(s.path);
    expect(probed?.sessionId).toBe("s-oc-1");
    expect(probed?.repo).toBe(realpathSync(repo));
    expect(opencodeSource.probe("/elsewhere/foo.jsonl")).toBeNull();

    const inc = opencodeSource.parse(s.path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("결제 모듈");
    expect(inc.assistants.length).toBe(1);
    expect(inc.cwd).toBe(realpathSync(repo));
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
