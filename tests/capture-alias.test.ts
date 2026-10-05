// One logical transcript = one queue row. Codex Desktop hardlinks the same rollout into several
// CODEX_HOMEs and the daemon sweeps all of them; keyed by path, one session became three rows with
// independent watermarks (measured: a row at byte 2092162 beside two alias rows at 0, pending).
// These pin the fold at enqueue, the alias-aware close-out, the re-point, and the one-time collapse.
import { test, expect, afterEach } from "bun:test";
import { appendFileSync, readFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import * as capture from "../src/engine/capture.ts";
import * as update from "../src/engine/update.ts";
import { ensureOwnedStateRoot } from "../src/engine/state-dir.ts";

const tmps: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}
afterEach(() => {
  capture._setIdentityStatForTests(null);
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function aliasRows(): { alias_path: string; canonical_path: string; via: string }[] {
  const db = new Database(capture.getDbPath(), { readonly: true });
  try {
    return db.query("SELECT alias_path, canonical_path, via FROM capture_alias ORDER BY alias_path").all() as {
      alias_path: string;
      canonical_path: string;
      via: string;
    }[];
  } finally {
    db.close();
  }
}

const THREAD = "019fd13c-0000-7000-8000-00000000abcd";
const ROLLOUT = `rollout-2026-09-30T10-00-00-${THREAD}.jsonl`;

function userLine(text: string): string {
  return (
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-09-30T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }) + "\n"
  );
}

/** A state root, an enrolled-shaped repo, and two CODEX_HOMEs sharing one hardlinked rollout. */
function world(): { repo: string; a: string; b: string; homes: string } {
  const state = join(tmp("llmwiki-alias-state-"), "state");
  ensureOwnedStateRoot(state);
  capture.setStateDir(state);
  const repo = join(tmp("llmwiki-alias-repo-"), "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"], {});
  const homes = tmp("llmwiki-alias-homes-");
  const dirA = join(homes, "dot-codex", "sessions", "2026", "09", "30");
  const dirB = join(homes, "orca", "codex-runtime-home", "home", "sessions", "2026", "09", "30");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const a = join(dirA, ROLLOUT);
  const b = join(dirB, ROLLOUT);
  writeFileSync(
    a,
    JSON.stringify({ type: "session_meta", payload: { id: THREAD, cwd: repo } }) + "\n" + userLine("첫 결정: 큐는 경로가 아닌 세션 단위"),
  );
  linkSync(a, b);
  return { repo, a, b, homes };
}

test("a hardlinked rollout offered from two CODEX_HOMEs is one queue row", () => {
  const { repo, a, b } = world();
  expect(statSync(a).ino).toBe(statSync(b).ino);
  expect(capture.enqueue(a, THREAD, repo, 60, "codex")).toBe("new");
  expect(capture.enqueue(b, THREAD, repo, 60, "codex")).toBe("unchanged");
  expect(capture.stats()).toEqual({ pending: 1 });
  expect(capture.pending(repo).map((r) => r.transcript_path)).toEqual([a]);
  expect(capture.canonicalQueuePath(b)).toBe(a);
  // Remembered, so the every-30s re-offer is a primary-key lookup rather than a search.
  expect(aliasRows()).toEqual([{ alias_path: b, canonical_path: a, via: "inode" }]);
});

test("a Codex COPY in another home folds by thread id + repo bucket", () => {
  const { repo, a, homes } = world();
  const copyDir = join(homes, "orca", "codex-accounts", "u1", "home", "sessions");
  mkdirSync(copyDir, { recursive: true });
  const c = join(copyDir, ROLLOUT);
  copyFileSync(a, c);
  expect(statSync(a).ino).not.toBe(statSync(c).ino);
  capture.enqueue(a, THREAD, repo, 60, "codex");
  capture.enqueue(c, THREAD, repo, 60, "codex");
  expect(capture.stats()).toEqual({ pending: 1 });
  // A bare-path lookup (no session id at hand) still finds it through the rollout's thread name.
  expect(capture.canonicalQueuePath(c)).toBe(a);
});

test("update-next / update-done through the alias path continue from the canonical watermark", () => {
  const { repo, a, b } = world();
  capture.enqueue(a, THREAD, repo, 60, "codex");
  const first = update.nextIncrement(repo, a);
  expect(first.nUsers).toBe(1);
  update.markUpdated(repo, a, first.newOffset);
  expect(capture.getOffset(a)).toBe(first.newOffset);

  appendFileSync(a, userLine("둘째 결정: 별칭 경로는 정본 워터마크를 이어받는다"));
  expect(capture.enqueue(b, THREAD, repo, 61, "codex")).toBe("grew");
  expect(capture.stats()).toEqual({ pending: 1 });

  const second = update.nextIncrement(repo, b);
  expect(second.nUsers).toBe(1); // only the new turn — not a re-read from byte 0
  expect(second.rendered).toContain("둘째 결정");
  expect(second.rendered).not.toContain("첫 결정");
  update.markUpdated(repo, b, second.newOffset);
  expect(capture.getOffset(a)).toBe(statSync(a).size);
  expect(capture.stats()).toEqual({ distilled: 1 });
});

test("when the canonical file vanishes, the row moves onto the live alias with its watermark", () => {
  const { repo, a, b } = world();
  capture.enqueue(a, THREAD, repo, 60, "codex");
  const inc = update.nextIncrement(repo, a);
  update.markUpdated(repo, a, inc.newOffset);
  unlinkSync(a); // the ~/.codex home is gone; the app home still links the same inode
  capture.enqueue(b, THREAD, repo, 60, "codex");
  expect(capture.stats()).toEqual({ distilled: 1 });
  expect(capture.getOffset(b)).toBe(inc.newOffset);
  expect(capture.canonicalQueuePath(b)).toBe(b);
  expect(capture.queueRowsForSession(THREAD).map((r) => r.transcript_path)).toEqual([b]);
});

test("a bare lookup re-points a vanished canonical too, so update-next reads the live file", () => {
  const { repo, a, b } = world();
  capture.enqueue(a, THREAD, repo, 60, "codex");
  unlinkSync(a);
  const inc = update.nextIncrement(repo, b);
  expect(inc.nUsers).toBe(1);
  expect(capture.queueRowsForSession(THREAD).map((r) => r.transcript_path)).toEqual([b]);
  expect(capture.issuedOffset(b)).toBe(inc.newOffset);
});

test("distinct claude-jsonl files sharing a session id stay separate; a hardlink of one folds", () => {
  const { repo } = world();
  const dir = tmp("llmwiki-alias-claude-");
  const one = join(dir, "one.jsonl");
  const two = join(dir, "two.jsonl");
  writeFileSync(one, '{"type":"user"}\n');
  writeFileSync(two, '{"type":"user"}\n');
  capture.enqueue(one, "same-sid", repo, 60, "claude-jsonl");
  capture.enqueue(two, "same-sid", repo, 60, "claude-jsonl");
  expect(capture.stats()).toEqual({ pending: 2 });
  const linked = join(dir, "linked.jsonl");
  linkSync(one, linked);
  capture.enqueue(linked, "same-sid", repo, 60, "claude-jsonl");
  expect(capture.stats()).toEqual({ pending: 2 });
  expect(capture.canonicalQueuePath(linked)).toBe(one);
});

test("the one-time migration collapses existing duplicates, keeping the most advanced row", () => {
  const state = join(tmp("llmwiki-alias-mig-"), "state");
  ensureOwnedStateRoot(state);
  capture.setStateDir(state);
  const dir = tmp("llmwiki-alias-mig-files-");
  const f = (name: string): string => {
    const p = join(dir, name);
    writeFileSync(p, "x\n");
    return p;
  };
  const [cx1, cx2, cx3] = [f("h1-rollout.jsonl"), f("h2-rollout.jsonl"), f("h3-rollout.jsonl")];
  const [tie1, tie2] = [f("tie1.jsonl"), f("tie2.jsonl")];
  const cl1 = f("claude-a.jsonl");
  const cl2 = join(dir, "claude-a-link.jsonl");
  linkSync(cl1, cl2);
  const st = statSync(cl1);
  const [sepA, sepB] = [f("sep-a.jsonl"), f("sep-b.jsonl")];
  const gone = join(dir, "gone-rollout.jsonl"); // keeper whose file vanished
  const live = f("live-rollout.jsonl");
  writeFileSync(live, "x".repeat(500)); // long enough to carry the vanished row's 400-byte watermark

  const db = new Database(join(state, "capture.db"));
  db.exec(
    "CREATE TABLE capture_queue (transcript_path TEXT PRIMARY KEY, session_id TEXT, repo TEXT, " +
      "byte_offset INTEGER DEFAULT 0, lines INTEGER DEFAULT 0, " +
      "status TEXT DEFAULT 'pending' CHECK (status IN ('pending','distilled','skipped','lost')), " +
      "source_kind TEXT DEFAULT 'claude-jsonl', file_id TEXT, first_seen TEXT DEFAULT (datetime('now')), distilled_at TEXT)",
  );
  db.exec("CREATE TABLE issued_offset (transcript_path TEXT PRIMARY KEY, new_offset INTEGER NOT NULL, issued_at TEXT)");
  const ins = db.prepare(
    "INSERT INTO capture_queue (transcript_path, session_id, repo, byte_offset, status, source_kind, file_id, first_seen) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // The measured shape: one partly filed row, two alias rows still at 0.
  ins.run(cx2, "t-1", "/r", 0, "pending", "codex", "1:11:5", "2026-09-01");
  ins.run(cx1, "t-1", "/r", 2092162, "distilled", "codex", "1:10:5", "2026-09-02");
  ins.run(cx3, "t-1", "/r", 0, "pending", "codex", "1:12:5", "2026-09-03");
  // Offset tie → the settled status wins.
  ins.run(tie1, "t-2", "/r", 100, "pending", "codex", null, "2026-09-01");
  ins.run(tie2, "t-2", "/r", 100, "distilled", "codex", null, "2026-09-02");
  // Same inode + birthtime under two DIFFERENT device numbers (observed on macOS) → one file.
  ins.run(cl1, "c-1", "/r", 0, "pending", "claude-jsonl", `16777230:${st.ino}:${st.birthtimeMs}`, "2026-09-01");
  ins.run(cl2, "c-1", "/r", 50, "pending", "claude-jsonl", `16777231:${st.ino}:${st.birthtimeMs}`, "2026-09-02");
  // Distinct non-codex files that merely share a session id are NOT merged.
  ins.run(sepA, "c-2", "/r", 0, "pending", "claude-jsonl", "1:20:7", "2026-09-01");
  ins.run(sepB, "c-2", "/r", 0, "pending", "claude-jsonl", "1:21:7", "2026-09-01");
  // Same thread in a DIFFERENT repo bucket is not an alias.
  ins.run(join(dir, "other-repo.jsonl"), "t-1", "/other", 0, "pending", "codex", null, "2026-09-01");
  // The most advanced row's file is gone; its live alias takes the row over.
  ins.run(gone, "t-3", "/r", 400, "distilled", "codex", null, "2026-09-01");
  ins.run(live, "t-3", "/r", 0, "pending", "codex", null, "2026-09-02");
  db.run("INSERT INTO issued_offset (transcript_path, new_offset) VALUES (?, 7), (?, 9)", [cx2, cx3]);
  db.close();

  capture.stats(); // any connect() runs the migration

  const after = new Database(join(state, "capture.db"), { readonly: true });
  const rows = after
    .query("SELECT transcript_path, byte_offset, status FROM capture_queue ORDER BY transcript_path")
    .all() as { transcript_path: string; byte_offset: number; status: string }[];
  const issued = after.query("SELECT transcript_path FROM issued_offset").all();
  const version = (after.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  after.close();
  const by = new Map(rows.map((r) => [r.transcript_path, r]));

  expect(by.get(cx1)).toEqual({ transcript_path: cx1, byte_offset: 2092162, status: "distilled" });
  expect(by.has(cx2) || by.has(cx3)).toBe(false);
  expect(issued).toEqual([]);
  expect(by.get(tie2)?.status).toBe("distilled");
  expect(by.has(tie1)).toBe(false);
  expect(by.get(cl2)?.byte_offset).toBe(50);
  expect(by.has(cl1)).toBe(false);
  expect(by.has(sepA) && by.has(sepB)).toBe(true);
  expect(by.has(join(dir, "other-repo.jsonl"))).toBe(true);
  expect(by.has(gone)).toBe(false);
  expect(by.get(live)).toEqual({ transcript_path: live, byte_offset: 400, status: "distilled" });
  expect(rows.length).toBe(7);
  expect(version).toBeGreaterThanOrEqual(1);
  expect(aliasRows()).toContainEqual({ alias_path: cl1, canonical_path: cl2, via: "inode" });

  // Idempotent and guarded: a later connect does not touch rows that look alike again.
  const db2 = new Database(join(state, "capture.db"));
  db2.run(
    "INSERT INTO capture_queue (transcript_path, session_id, repo, byte_offset, status, source_kind) VALUES (?, 't-1', '/r', 0, 'pending', 'codex')",
    [join(dir, "late.jsonl")],
  );
  db2.close();
  capture.stats();
  const count = (): number => {
    const db3 = new Database(join(state, "capture.db"), { readonly: true });
    try {
      return (db3.query("SELECT COUNT(*) AS n FROM capture_queue").get() as { n: number }).n;
    } finally {
      db3.close();
    }
  };
  expect(count()).toBe(8);
  // …which is exactly the row an older daemon still running after the upgrade keeps writing. The
  // repeatable pass (daemon startup + daily) folds it, keeping the advanced row.
  expect(capture.collapseAliases()).toBe(1);
  expect(count()).toBe(7);
  expect(capture.getOffset(cx1)).toBe(2092162);
  expect(capture.collapseAliases()).toBe(0);
});

test("birthtime 0: a hardlink is not provably the same file, so nothing merges", () => {
  const { repo } = world();
  capture._setIdentityStatForTests((p) => {
    const st = statSync(p);
    return { dev: st.dev, ino: st.ino, birthtimeMs: 0 };
  });
  const dir = tmp("llmwiki-alias-b0-");
  const one = join(dir, "one.jsonl");
  writeFileSync(one, '{"type":"user"}\n');
  const linked = join(dir, "linked.jsonl");
  linkSync(one, linked);
  capture.enqueue(one, "s-a", repo, 60, "claude-jsonl");
  capture.enqueue(linked, "s-b", repo, 60, "claude-jsonl");
  expect(capture.stats()).toEqual({ pending: 2 });
  expect(capture.collapseAliases()).toBe(0);
  expect(capture.stats()).toEqual({ pending: 2 });
});

test("a reused inode never inherits a vanished row's watermark", () => {
  // Same inode number AND birthtime reported for two generations — the worst a platform can do.
  const { repo } = world();
  capture._setIdentityStatForTests((p) => {
    statSync(p); // a missing file still has no identity
    return { dev: 1, ino: 4242, birthtimeMs: 1700000000000 };
  });
  const dir = tmp("llmwiki-alias-reuse-");
  const old = join(dir, "old.jsonl");
  writeFileSync(old, '{"type":"user"}\n{"type":"user"}\n');
  capture.enqueue(old, "s-old", repo, 60, "claude-jsonl");
  capture.mark(old, statSync(old).size, "distilled");
  unlinkSync(old);
  const fresh = join(dir, "fresh.jsonl");
  writeFileSync(fresh, '{"type":"user"}\n');
  expect(capture.enqueue(fresh, "s-new", repo, 60, "claude-jsonl")).toBe("new");
  expect(capture.getOffset(fresh)).toBe(0);
  expect(capture.stats()).toEqual({ distilled: 1, pending: 1 });
});

test("birthtime-0 identities recorded in the queue are never unioned by the fold", () => {
  const state = join(tmp("llmwiki-alias-b0mig-"), "state");
  ensureOwnedStateRoot(state);
  capture.setStateDir(state);
  capture.stats(); // create the current schema
  const dir = tmp("llmwiki-alias-b0mig-files-");
  const x = join(dir, "x.jsonl");
  const y = join(dir, "y.jsonl");
  writeFileSync(x, "x\n");
  writeFileSync(y, "y\n");
  const db = new Database(capture.getDbPath());
  db.run(
    "INSERT INTO capture_queue (transcript_path, session_id, repo, byte_offset, status, source_kind, file_id) VALUES " +
      "(?, 'a', '/r', 9, 'distilled', 'claude-jsonl', '1:42:0'), (?, 'b', '/r', 0, 'pending', 'claude-jsonl', '1:42:0')",
    [x, y],
  );
  db.close();
  expect(capture.collapseAliases()).toBe(0);
  expect(capture.stats()).toEqual({ distilled: 1, pending: 1 });
});

test("a frozen Codex copy hands the row to the copy that kept growing, watermark intact", () => {
  const { repo, a, homes } = world();
  const frozenDir = join(homes, "orca", "codex-accounts", "u2", "home", "sessions");
  mkdirSync(frozenDir, { recursive: true });
  const frozen = join(frozenDir, ROLLOUT);
  copyFileSync(a, frozen);
  capture.enqueue(frozen, THREAD, repo, 60, "codex");
  const first = update.nextIncrement(repo, frozen);
  update.markUpdated(repo, frozen, first.newOffset);

  appendFileSync(a, userLine("셋째 결정: 자라는 사본이 정본이 된다"));
  expect(capture.enqueue(a, THREAD, repo, 61, "codex")).toBe("grew");
  expect(capture.queueRowsForSession(THREAD).map((r) => r.transcript_path)).toEqual([a]);
  expect(capture.getOffset(a)).toBe(first.newOffset);
  expect(capture.canonicalQueuePath(frozen)).toBe(a);
  // The frozen copy re-offered later stays folded and does not take the row back.
  expect(capture.enqueue(frozen, THREAD, repo, 61, "codex")).toBe("unchanged");
  const next = update.nextIncrement(repo, a);
  expect(next.nUsers).toBe(1);
  expect(next.rendered).toContain("셋째 결정");
});

test("a Codex copy that is NOT a prefix-extension of the queued file keeps its own row", () => {
  const { repo, a, homes } = world();
  const otherDir = join(homes, "orca", "codex-accounts", "u3", "home", "sessions");
  mkdirSync(otherDir, { recursive: true });
  const other = join(otherDir, ROLLOUT);
  capture.enqueue(a, THREAD, repo, 60, "codex");
  const inc = update.nextIncrement(repo, a);
  update.markUpdated(repo, a, inc.newOffset);
  writeFileSync(other, userLine("전혀 다른 내용으로 시작하는 사본") + userLine("그리고 더 길다, 원본보다 훨씬 더 길게 이어지는 줄"));
  expect(capture.enqueue(other, THREAD, repo, 60, "codex")).toBe("new");
  expect(capture.getOffset(other)).toBe(0);
  expect(capture.getOffset(a)).toBe(inc.newOffset);
});

test("opencode regeneration ignores an st_dev change on the same inode", () => {
  const { repo } = world();
  const dir = tmp("llmwiki-alias-oc-");
  const exp = join(dir, "ses_1.jsonl");
  writeFileSync(exp, '{"kind":"opencode-meta"}\n{"m":1}\n');
  let dev = 16777230;
  capture._setIdentityStatForTests((p) => {
    const st = statSync(p);
    return { dev, ino: st.ino, birthtimeMs: st.birthtimeMs };
  });
  capture.enqueue(exp, "ses_1", repo, 2, "opencode");
  capture.mark(exp, statSync(exp).size, "distilled");
  dev = 16777231;
  expect(capture.enqueue(exp, "ses_1", repo, 2, "opencode")).not.toBe("regenerated");
  expect(capture.getOffset(exp)).toBe(statSync(exp).size);
});

test("a split (non-prefix) Codex pair survives the daily fold and a re-offer, both watermarks intact", () => {
  const { repo, a, homes } = world();
  const otherDir = join(homes, "orca", "codex-accounts", "u4", "home", "sessions");
  mkdirSync(otherDir, { recursive: true });
  const other = join(otherDir, ROLLOUT);
  capture.enqueue(a, THREAD, repo, 60, "codex");
  capture.mark(a, statSync(a).size, "distilled");
  writeFileSync(other, userLine("B".repeat(50)) + userLine("C".repeat(900)));
  expect(capture.enqueue(other, THREAD, repo, 60, "codex")).toBe("new");
  capture.mark(other, 100, "distilled");
  expect(capture.collapseAliases()).toBe(0);
  capture.enqueue(other, THREAD, repo, 60, "codex"); // its own unread tail re-pends it — its own row
  expect(capture.queueRowsForSession(THREAD).length).toBe(2);
  expect(capture.getOffset(a)).toBe(statSync(a).size);
  expect(capture.getOffset(other)).toBe(100);
  expect(capture.collapseAliases()).toBe(0);
});

test("the fold never moves a vanished row's watermark onto a SHORTER thread copy", () => {
  const { repo, a, homes } = world();
  const otherDir = join(homes, "orca", "codex-accounts", "u5", "home", "sessions");
  mkdirSync(otherDir, { recursive: true });
  const short = join(otherDir, ROLLOUT);
  appendFileSync(a, userLine("A".repeat(2000)));
  capture.enqueue(a, THREAD, repo, 60, "codex");
  const offset = statSync(a).size;
  capture.mark(a, offset, "distilled");
  writeFileSync(short, userLine("Z".repeat(100)));
  // An older binary wrote the copy's row directly — only the fold can meet this pair.
  const db = new Database(capture.getDbPath());
  db.run(
    "INSERT INTO capture_queue (transcript_path, session_id, repo, byte_offset, status, source_kind) VALUES (?, ?, ?, 0, 'pending', 'codex')",
    [short, THREAD, capture.queueRowsForSession(THREAD)[0]!.repo],
  );
  db.close();
  unlinkSync(a);
  expect(capture.collapseAliases()).toBe(0);
  expect(capture.getOffset(short)).toBe(0);
  expect(capture.getOffset(a)).toBe(offset);
  // And the enqueue path agrees with the fold.
  capture.enqueue(short, THREAD, repo, 60, "codex");
  expect(capture.getOffset(short)).toBe(0);
  expect(capture.getOffset(a)).toBe(offset);
});

test("a folded copy keeps the canonical line count and announces no false growth", () => {
  const { repo, a, homes } = world();
  const frozenDir = join(homes, "orca", "codex-accounts", "u6", "home", "sessions");
  mkdirSync(frozenDir, { recursive: true });
  const frozen = join(frozenDir, ROLLOUT);
  copyFileSync(a, frozen);
  appendFileSync(a, userLine("더 진행된 원본"));
  capture.enqueue(a, THREAD, repo, 90, "codex");
  expect(capture.enqueue(frozen, THREAD, repo, 40, "codex")).toBe("unchanged");
  expect(capture.queueRowsForSession(THREAD).map((r) => [r.transcript_path, r.lines])).toEqual([[a, 90]]);
});

test("prefix judgment spans many 64 KB chunks: same log folds, a late divergence splits", () => {
  const { repo, a, homes } = world();
  appendFileSync(a, userLine("x".repeat(300 * 1024)));
  capture.enqueue(a, THREAD, repo, 60, "codex");
  capture.mark(a, statSync(a).size, "distilled");
  const mk = (u: string): string => {
    const d = join(homes, "orca", "codex-accounts", u, "home", "sessions");
    mkdirSync(d, { recursive: true });
    return join(d, ROLLOUT);
  };
  const same = mk("u7");
  copyFileSync(a, same);
  appendFileSync(same, userLine("이어진 내용"));
  expect(capture.enqueue(same, THREAD, repo, 61, "codex")).toBe("grew"); // moved onto the longer copy
  expect(capture.queueRowsForSession(THREAD).map((r) => r.transcript_path)).toEqual([same]);
  const forked = mk("u8");
  const body = readFileSync(same);
  body[200 * 1024] = body[200 * 1024]! ^ 1; // one flipped byte past three chunks
  writeFileSync(forked, Buffer.concat([body, Buffer.from(userLine("포크"))]));
  expect(capture.enqueue(forked, THREAD, repo, 62, "codex")).toBe("new");
  expect(capture.getOffset(forked)).toBe(0);
});

test("moving a lost row onto a live copy makes it pending again", () => {
  const { repo, a, homes } = world();
  capture.enqueue(a, THREAD, repo, 60, "codex");
  capture.mark(a, 0, "lost");
  const d = join(homes, "orca", "codex-accounts", "u9", "home", "sessions");
  mkdirSync(d, { recursive: true });
  const live = join(d, ROLLOUT);
  copyFileSync(a, live);
  unlinkSync(a);
  capture.enqueue(live, THREAD, repo, 60, "codex");
  expect(capture.queueRowsForSession(THREAD).map((r) => [r.transcript_path, r.status])).toEqual([[live, "pending"]]);
});

test("a recreated canonical path stops absorbing its former hardlink", () => {
  const { repo } = world();
  const dir = tmp("llmwiki-alias-recreate-");
  const one = join(dir, "one.jsonl");
  const linked = join(dir, "linked.jsonl");
  writeFileSync(one, '{"type":"user"}\n');
  linkSync(one, linked);
  capture.enqueue(one, "s-1", repo, 60, "claude-jsonl");
  capture.enqueue(linked, "s-1", repo, 60, "claude-jsonl");
  expect(capture.stats()).toEqual({ pending: 1 });
  unlinkSync(one);
  writeFileSync(one, '{"type":"user","different":true}\n');
  expect(statSync(one).ino).not.toBe(statSync(linked).ino);
  expect(capture.enqueue(linked, "s-1", repo, 60, "claude-jsonl")).toBe("new");
  expect(capture.stats()).toEqual({ pending: 2 });
});
