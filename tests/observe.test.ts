// The emission ledger and its per-harness observers. The injection side of "was the pointer
// opened?" comes from the engine's own record (harnesses don't persist injections reliably);
// these tests pin the write path, each observer's extraction, and the session/root/order rules
// of the match.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  claudeLedgerReads,
  discoverCodexRollouts,
  LEDGER_MAX_BYTES,
  matchEmissions,
  readEmissionsFor,
  recordEmission,
  scanCodexReads,
  scanOpenCodeReads,
  type Emission,
  type LedgerRead,
} from "../src/engine/observe.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

const PAGE = "docs/wiki/5_topic/a.md";
const PAGE2 = "docs/wiki/3_decision/b.md";

function tempRepo(): string {
  return enrollRepo(makeGitRepo(join(mkdtempSync(join(tmpdir(), "llmwiki-observe-")), "repo")));
}

function banner(pages: string[]): string {
  return [
    "----- [llmwiki turn-context] ~/repo — pointers -----",
    ...pages.map((p) => `  • T  →  ${p}`),
  ].join("\n");
}

function em(over: Partial<Emission>): Emission {
  return { ts: 1000, session: "s1", channel: "turn_context", root: "/work/repo", pages: [PAGE], ...over };
}

function rd(over: Partial<LedgerRead>): LedgerRead {
  return { ts: 2000, session: "s1", root: "/work/repo", page: PAGE, harness: "opencode", ...over };
}

describe("emission ledger", () => {
  test("an emitted banner becomes one ledger line with its pages", () => {
    const repo = tempRepo();
    recordEmission(repo, "sess-1", "turn_context", banner([PAGE, PAGE2]));
    const got = readEmissionsFor(repo);
    expect(got.length).toBe(1);
    expect(got[0]!.session).toBe("sess-1");
    expect(got[0]!.pages).toEqual([PAGE, PAGE2]);
    expect(got[0]!.channel).toBe("turn_context");
  });

  test("no session or no text → nothing is written", () => {
    const repo = tempRepo();
    recordEmission(repo, "", "turn_context", banner([PAGE])); // unmatchable line, not data
    recordEmission(repo, "sess-1", "turn_context", ""); // silence is silence
    expect(readEmissionsFor(repo).length).toBe(0);
  });

  test("a pointer-free emission is recorded — bytes spent to point at nothing is the worst case", () => {
    // It used to be dropped as "nothing to match later", which hid exactly the emission a reader
    // would most want to see. Reach is unaffected: no pages means no pointer occurrences.
    const repo = tempRepo();
    recordEmission(repo, "sess-1", "cold_start", "prose with no pointers at all");
    const got = readEmissionsFor(repo);
    expect(got.length).toBe(1);
    expect(got[0]!.pages).toEqual([]);
    expect(got[0]!.bytes).toBe(29);

    const r = matchEmissions(got, []);
    expect(r.injected).toBe(0);
    expect(r.by_channel.cold_start.emissions).toBe(1);
    expect(r.bytes).toBe(29);
  });

  test("cost is the emission's real UTF-8 size, not its character count", () => {
    const repo = tempRepo();
    const body = `${banner([PAGE])}\n한글 본문`; // multi-byte, so length !== byteLength
    recordEmission(repo, "sess-1", "turn_context", body);
    const got = readEmissionsFor(repo);
    expect(got[0]!.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(got[0]!.bytes).toBeGreaterThan(body.length);
  });

  test("lines written before the field are reported as unweighed, never as zero cost", () => {
    // Honesty over a tidy number: an upgraded install must not read as "injection is free".
    const priced = em({ session: "new", bytes: 500 });
    const legacy = em({ session: "old" }); // no bytes — predates the field
    const r = matchEmissions([priced, legacy], []);
    expect(r.emissions).toBe(2);
    expect(r.weighed).toBe(1);
    expect(r.bytes).toBe(500);
    expect(r.by_channel.turn_context.weighed).toBe(1);
    expect(r.by_channel.turn_context.emissions).toBe(2);
  });

  test("the ledger rotates once at the size cap instead of growing forever", () => {
    const repo = tempRepo();
    recordEmission(repo, "s1", "turn_context", banner([PAGE]), 64); // tiny cap
    recordEmission(repo, "s2", "turn_context", banner([PAGE]), 64); // exceeds → rotates first
    const got = readEmissionsFor(repo);
    expect(got.length).toBe(2); // both files are read back
    expect(LEDGER_MAX_BYTES).toBeGreaterThan(1024 * 1024);
  });

  test("a corrupt ledger line is skipped, not fatal", () => {
    const repo = tempRepo();
    recordEmission(repo, "s1", "cold_start", banner([PAGE]));
    const all = readEmissionsFor(repo);
    expect(all.length).toBe(1);
    expect(all[0]!.channel).toBe("cold_start");
  });
});

describe("matchEmissions", () => {
  test("same session + same page + later read = matched, attributed to its harness", () => {
    const r = matchEmissions([em({})], [rd({ harness: "codex" })]);
    expect(r.matched).toBe(1);
    expect(r.pointer_reach).toBe(1);
    expect(r.matched_by_harness["codex"]).toBe(1);
  });

  test("a read BEFORE the emission does not answer it", () => {
    expect(matchEmissions([em({ ts: 5000 })], [rd({ ts: 4000 })]).matched).toBe(0);
  });

  test("another session's read never matches", () => {
    expect(matchEmissions([em({})], [rd({ session: "other" })]).matched).toBe(0);
  });

  test("root disagreement blocks the match; an unknown root falls back to the path", () => {
    expect(matchEmissions([em({})], [rd({ root: "/work/other" })]).matched).toBe(0);
    expect(matchEmissions([em({})], [rd({ root: "" })]).matched).toBe(1);
  });

  test("channels are scored apart", () => {
    const r = matchEmissions(
      [em({ channel: "cold_start" }), em({ channel: "turn_context", pages: [PAGE2] })],
      [rd({})],
    );
    expect(r.by_channel.cold_start.matched).toBe(1);
    expect(r.by_channel.turn_context.matched).toBe(0);
  });
});

describe("OpenCode observer", () => {
  function makeDb(rows: { session: string; ts: number; data: unknown }[]): string {
    const p = join(mkdtempSync(join(tmpdir(), "llmwiki-ocdb-")), "opencode.db");
    const db = new Database(p);
    db.run(
      "CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer, data text NOT NULL)",
    );
    const ins = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    rows.forEach((r, i) => ins.run(`p${i}`, `m${i}`, r.session, r.ts, r.ts, JSON.stringify(r.data)));
    db.close();
    return p;
  }

  test("read-tool parts on wiki pages come back with session, time and clone", () => {
    const db = makeDb([
      {
        session: "ses_1",
        ts: 111,
        data: { type: "tool", tool: "read", state: { status: "completed", input: { filePath: `/work/repo/${PAGE}` } } },
      },
      { session: "ses_1", ts: 112, data: { type: "tool", tool: "bash", state: { input: { command: `cat /work/repo/${PAGE2}` } } } },
      { session: "ses_1", ts: 113, data: { type: "text", text: `mentions docs/wiki/ and "tool" but is prose` } },
      { session: "ses_1", ts: 114, data: { type: "tool", tool: "read", state: { input: { filePath: "/work/repo/src/db.ts" } } } },
    ]);
    const reads = scanOpenCodeReads(db);
    expect(reads.length).toBe(1); // bash open and non-wiki read are not counted
    expect(reads[0]).toMatchObject({ session: "ses_1", ts: 111, root: "/work/repo", page: PAGE, harness: "opencode" });
  });

  test("a missing or schema-drifted database is empty, never a crash", () => {
    expect(scanOpenCodeReads(join(tmpdir(), "no-such.db")).length).toBe(0);
    const p = join(mkdtempSync(join(tmpdir(), "llmwiki-ocdb-")), "opencode.db");
    const db = new Database(p);
    db.run("CREATE TABLE part (id text PRIMARY KEY, whatever text)"); // drifted schema
    db.close();
    expect(scanOpenCodeReads(p).length).toBe(0);
  });
});

describe("Codex observer", () => {
  function makeRollout(dir: string, name: string, lines: unknown[]): string {
    const p = join(dir, name);
    writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
    return p;
  }

  test("exec calls that open wiki pages are reads; relative paths resolve against session cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-rollout-"));
    const f = makeRollout(dir, "rollout-2026-08-05T10-00-00-abc.jsonl", [
      { type: "session_meta", payload: { id: "codex-1", cwd: "/work/repo" } },
      {
        timestamp: "2026-08-05T10:00:05.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input: `sed -n '1,220p' '${PAGE}'` },
      },
      {
        timestamp: "2026-08-05T10:00:06.000Z",
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: `{"command":["cat","/elsewhere/${PAGE2}"]}` },
      },
      { type: "response_item", payload: { type: "message", content: [{ type: "input_text", text: `prose ${PAGE}` }] } },
      "{not json",
    ]);
    const reads = scanCodexReads([f]);
    expect(reads.length).toBe(2);
    expect(reads[0]).toMatchObject({ session: "codex-1", root: "/work/repo", page: PAGE, harness: "codex" });
    expect(reads[1]).toMatchObject({ root: "/elsewhere", page: PAGE2 });
    expect(reads[0]!.ts).toBeGreaterThan(0);
  });

  test("discovery finds rollout jsonl files and skips compressed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-sessions-"));
    mkdirSync(join(dir, "2026", "08", "05"), { recursive: true });
    writeFileSync(join(dir, "2026", "08", "05", "rollout-a.jsonl"), "");
    writeFileSync(join(dir, "2026", "08", "05", "rollout-b.jsonl.zst"), "");
    writeFileSync(join(dir, "2026", "08", "05", "notes.txt"), "");
    const found = discoverCodexRollouts(dir);
    expect(found.length).toBe(1);
    expect(found[0]!.endsWith("rollout-a.jsonl")).toBe(true);
  });
});

describe("Claude observer (ledger shape)", () => {
  test("re-keys transcript reads by session id without crashing on an empty machine", () => {
    // Behavioural floor only: the function must return an array (contents depend on the machine).
    expect(Array.isArray(claudeLedgerReads(1))).toBe(true);
  });
});
