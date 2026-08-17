// Discovery runs over every transcript on the machine — including sessions from repositories
// the user never enrolled. So it happens in two stages: route (bounded metadata, no bodies),
// then, only for an enrolled repository, materialize.
//
// What these tests hold down is the cost of stage 1 for a repository that never gets to stage 2:
// a bounded prefix of a file, zero decompression, zero exported transcripts, zero queue rows.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTE_MAX_BYTES, ROUTE_MAX_RECORDS, routeNeedsMaterialization } from "../src/engine/source.ts";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";
import { codexSource } from "../src/engine/sources/codex.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { opencodeSource, setExportDir } from "../src/engine/sources/opencode.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";
import { zstdCompressFixture } from "./support/zstd-fixture.ts";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function scratch(prefix = "llmwiki-discovery-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

afterEach(() => {
  setEffectiveStateRoot(null); // setExportDir overrides it process-wide; children only see the env
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  resetEnrollmentCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Claude routing is bounded", () => {
  let home: string;
  let projects: string;

  beforeEach(() => {
    home = scratch("llmwiki-claude-home-");
    projects = join(home, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  });

  function transcript(name: string, records: unknown[]): string {
    const path = join(projects, name);
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return path;
  }

  test("identity in the first record routes; the rest of the file is never parsed", () => {
    const body = { type: "user", message: { role: "user", content: "SENSITIVE-CONVERSATION-BODY" } };
    transcript("a.jsonl", [{ type: "session_meta", cwd: "/repo/a", sessionId: "sess-a" }, body, body]);

    const routes = claudeJsonlSource.discoverRoutes();
    expect(routes.length).toBe(1);
    expect(routes[0]!.repo).toBe("/repo/a");
    expect(routes[0]!.sessionId).toBe("sess-a");
    // a route carries exactly three fields — there is nowhere for a message body to ride along
    expect(Object.keys(routes[0]!).sort()).toEqual(["path", "repo", "sessionId"]);
    expect(JSON.stringify(routes[0])).not.toContain("SENSITIVE-CONVERSATION-BODY");
  });

  test("routing decodes identity before a body field without parsing the complete record", () => {
    const path = join(projects, "combined.jsonl");
    // Deliberately invalid after the body key: whole-record JSON.parse would reject this. The
    // field scanner has already obtained both identity strings and stops at `message`.
    writeFileSync(
      path,
      `{"cwd":"/repo/combined","sessionId":"sess-combined","message":{"content":"SENSITIVE", BROKEN}\n`,
    );

    const route = claudeJsonlSource.discoverRoutes().find((item) => item.path === path);

    expect(route?.repo).toBe("/repo/combined");
    expect(route?.sessionId).toBe("sess-combined");
    expect(JSON.stringify(route)).not.toContain("SENSITIVE");
  });

  // Every harness writes the body before `cwd`, so "give up on the record when an unknown complex
  // value appears" is not a stricter rule — it is a rule that never routes anything real. What
  // must hold instead: the body is WALKED to find its end and never interpreted.
  test("a body before identity is walked past, not decoded — the record still routes", () => {
    const path = join(projects, "body-first.jsonl");
    writeFileSync(
      path,
      `{"parentUuid":null,"userType":"external","message":{"role":"user","content":"SENSITIVE",` +
        `"nested":{"deep":[1,2,{"brace":"}","bracket":"]"}]}},"cwd":"/repo/after-body","sessionId":"late"}\n`,
    );

    const route = claudeJsonlSource.discoverRoutes().find((item) => item.path === path);

    expect(route?.repo).toBe("/repo/after-body");
    expect(route?.sessionId).toBe("late");
    expect(JSON.stringify(route)).not.toContain("SENSITIVE");
  });

  test("an identity key INSIDE a body is never mistaken for identity", () => {
    // `message` is not a declared container, so a `cwd` planted in a tool result or a pasted
    // snippet cannot route a session at a repository of the author's choosing.
    const path = join(projects, "planted.jsonl");
    writeFileSync(
      path,
      `{"message":{"cwd":"/attacker/repo","sessionId":"attacker"},"cwd":"/repo/real","sessionId":"real"}\n`,
    );

    const route = claudeJsonlSource.discoverRoutes().find((item) => item.path === path);

    expect(route?.repo).toBe("/repo/real");
    expect(route?.sessionId).toBe("real");
  });

  test("a record whose ONLY cwd sits inside a body stays unroutable", () => {
    const path = join(projects, "planted-only.jsonl");
    writeFileSync(path, `{"type":"user","message":{"cwd":"/attacker/repo"}}\n`);

    const route = claudeJsonlSource.discoverRoutes().find((item) => item.path === path);

    expect(route?.repo).toBeNull();
  });

  test("identity past the record budget is not found — the session is skipped, not read further", () => {
    const filler = Array.from({ length: ROUTE_MAX_RECORDS + 10 }, () => ({ type: "assistant", message: { content: "x" } }));
    transcript("late.jsonl", [...filler, { type: "user", cwd: "/repo/late", sessionId: "sess-late" }]);

    const routes = claudeJsonlSource.discoverRoutes();
    expect(routes.length).toBe(1);
    expect(routes[0]!.repo).toBeNull(); // unroutable → the daemon counts it and moves on
    expect(claudeJsonlSource.materialize(routes[0]!)).toBeNull();
  });

  test("identity past the byte budget is not found either", () => {
    const pad = "y".repeat(ROUTE_MAX_BYTES);
    transcript("big.jsonl", [
      { type: "assistant", message: { content: pad } },
      { type: "user", cwd: "/repo/big", sessionId: "sess-big" },
    ]);

    expect(claudeJsonlSource.discoverRoutes()[0]!.repo).toBeNull();
  });

  test("materialize counts work without parsing messages", () => {
    const path = transcript("count.jsonl", [
      { type: "session_meta", cwd: "/repo/c", sessionId: "sess-c" },
      { type: "user", message: { content: "one" } },
      { type: "assistant", message: { content: "two" } },
    ]);
    const session = claudeJsonlSource.materialize({ path, repo: "/repo/c", sessionId: "sess-c" });
    expect(session!.lines).toBe(3);
  });
});

describe("Codex routing never decompresses a cold rollout", () => {
  test("an unindexed .zst rollout is skipped entirely during discovery", () => {
    const codexHome = scratch("llmwiki-codex-home-");
    const day = join(codexHome, "sessions", "2026", "07", "26");
    mkdirSync(day, { recursive: true });
    setEnv("CODEX_HOME", codexHome);

    // Deliberately NOT valid zstd: if discovery tried to decompress it, the attempt would show
    // up as an error or an empty route rather than the file being absent from the list entirely.
    writeFileSync(join(day, "rollout-cold-11111111-1111-1111-1111-111111111111.jsonl.zst"), "not-really-zstd");
    writeFileSync(
      join(day, "rollout-warm-22222222-2222-2222-2222-222222222222.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "warm", cwd: "/repo/warm" } }) + "\n",
    );

    const routes = codexSource.discoverRoutes();
    expect(routes.map((r) => r.sessionId)).toEqual(["warm"]);
    expect(routes.some((r) => r.path.endsWith(".zst"))).toBe(false);
    expect(codexSource.routeFor?.(join(day, "rollout-cold-11111111-1111-1111-1111-111111111111.jsonl.zst"))).toBeNull();
  });

  test("the Codex thread index routes .zst without reading its body", () => {
    const codexHome = scratch("llmwiki-codex-index-");
    const day = join(codexHome, "sessions", "2026", "07", "26");
    mkdirSync(day, { recursive: true });
    setEnv("CODEX_HOME", codexHome);
    const cold = join(day, "rollout-cold-33333333-3333-3333-3333-333333333333.jsonl.zst");
    writeFileSync(cold, "deliberately-not-zstd");
    const repo = makeGitRepo(join(codexHome, "repo"));

    const state = new Database(join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?, ?)", ["cold-indexed", cold, repo]);
    state.close();

    const route = codexSource.discoverRoutes().find((r) => r.sessionId === "cold-indexed");

    expect(route?.sessionId).toBe("cold-indexed");
    expect(route?.repo).toBe(repo);
    expect(route?.path).toBe(cold.slice(0, -".zst".length));
    expect(route?.changePath).toBe(realpathSync(cold));
    const lastSizes: Record<string, number> = {};
    expect(routeNeedsMaterialization(route!, lastSizes)).toBe(true);
    expect(routeNeedsMaterialization(route!, lastSizes)).toBe(false);
    expect(codexSource.routeFor?.(cold)?.sessionId).toBe("cold-indexed");
    // Materialization is the first operation that decompresses; the invalid fixture then fails.
    expect(codexSource.materialize(route!)).toBeNull();
  });

  test("an enrolled compressed-first rollout materializes through its indexed identity", () => {
    const codexHome = scratch("llmwiki-codex-indexed-body-");
    const day = join(codexHome, "sessions", "2026", "07", "26");
    mkdirSync(day, { recursive: true });
    setEnv("CODEX_HOME", codexHome);
    const repo = enrollRepo(makeGitRepo(join(codexHome, "repo")));
    const cold = join(day, "rollout-cold-44444444-4444-4444-4444-444444444444.jsonl.zst");
    const plain =
      JSON.stringify({ type: "session_meta", payload: { id: "cold-captured", cwd: repo } }) +
      "\n" +
      JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ text: "hello" }] } }) +
      "\n";
    writeFileSync(cold, zstdCompressFixture(Buffer.from(plain)));

    const state = new Database(join(codexHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?, ?)", ["cold-captured", cold, repo]);
    state.close();

    const route = codexSource.discoverRoutes().find((r) => r.sessionId === "cold-captured");
    const session = codexSource.materialize(route!);

    expect(session?.sessionId).toBe("cold-captured");
    expect(session?.repo).toBe(realpathSync(repo));
    expect(session?.lines).toBe(2);
    expect(session?.path).toBe(cold.slice(0, -".zst".length));
  });

  test("a symlinked CODEX_HOME keeps one lexical queue identity across compression", () => {
    const container = scratch("llmwiki-codex-symlink-");
    const realHome = join(container, "real");
    const linkedHome = join(container, "linked");
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome);
    setEnv("CODEX_HOME", linkedHome);
    const day = join(linkedHome, "sessions", "2026", "07", "26");
    mkdirSync(day, { recursive: true });
    const repo = makeGitRepo(join(container, "repo"));
    const plainPath = join(day, "rollout-cold-55555555-5555-5555-5555-555555555555.jsonl");
    const body =
      JSON.stringify({ type: "session_meta", payload: { id: "stable-id", cwd: repo } }) +
      "\n" +
      JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ text: "hello" }] } }) +
      "\n";
    writeFileSync(plainPath, body);

    const before = codexSource.discoverRoutes().find((r) => r.sessionId === "stable-id");
    expect(before?.path).toBe(plainPath);

    const compressedPath = `${plainPath}.zst`;
    writeFileSync(compressedPath, zstdCompressFixture(Buffer.from(body)));
    rmSync(plainPath);
    const state = new Database(join(linkedHome, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT)");
    state.run("INSERT INTO threads VALUES (?, ?, ?)", ["stable-id", plainPath, repo]);
    state.close();

    const after = codexSource.discoverRoutes().find((r) => r.sessionId === "stable-id");
    expect(after?.path).toBe(before?.path);
    expect(after?.changePath).toBe(realpathSync(compressedPath));
  });
});

describe("OpenCode touches no message body before enrollment", () => {
  let dir: string;
  let exportDir: string;

  function seed(directory: string, dbPath = join(dir, "opencode.db"), id = "s1", prompt = "SENSITIVE-PROMPT-TEXT"): void {
    setEnv("OPENCODE_DB", dbPath);
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER);
    `);
    db.run("INSERT INTO session VALUES (?, ?, 'SENSITIVE-TITLE', 1000, NULL)", [id, directory]);
    const ins = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
    ins.run("m1", id, "user", 1, JSON.stringify({ text: prompt }), 1720000000000);
    ins.run("m2", id, "assistant", 2, JSON.stringify({ content: [{ type: "text", text: "B".repeat(200) }] }), 1720000001000);
    db.close();
  }

  beforeEach(() => {
    dir = scratch("llmwiki-oc-gate-");
    exportDir = join(dir, "state", "opencode-export");
    setExportDir(exportDir);
  });

  test("routing yields id+directory only, and writes no export file", () => {
    seed("/repo/unenrolled");

    const routes = opencodeSource.discoverRoutes();

    expect(routes.length).toBe(1);
    expect(routes[0]!.repo).toBe("/repo/unenrolled");
    const lastRevisions: Record<string, string | number> = {};
    expect(routeNeedsMaterialization(routes[0]!, lastRevisions)).toBe(true);
    expect(routeNeedsMaterialization(routes[0]!, lastRevisions)).toBe(false);
    const db = new Database(join(dir, "opencode.db"));
    db.run("UPDATE session SET time_updated = 1001 WHERE id = 's1'");
    db.close();
    const changed = opencodeSource.discoverRoutes()[0]!;
    expect(routeNeedsMaterialization(changed, lastRevisions)).toBe(true);
    expect(JSON.stringify(routes)).not.toContain("SENSITIVE-TITLE");
    expect(JSON.stringify(routes)).not.toContain("SENSITIVE-PROMPT-TEXT");
    // the export directory is created by materialize() only — routing leaves the disk alone
    expect(existsSync(exportDir)).toBe(false);
  });

  test("materialize (post-enrollment) is what writes the transcript, privately", () => {
    const repo = enrollRepo(makeGitRepo(join(scratch("llmwiki-oc-repo-"), "repo")));
    seed(repo);

    const route = opencodeSource.discoverRoutes()[0]!;
    const session = opencodeSource.materialize(route)!;

    expect(session.repo).toBe(realpathSync(repo));
    expect(session.lines).toBeGreaterThan(1);
    const files = readdirSync(exportDir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((name) => name.endsWith(".jsonl"))).toBe(true);
    expect(files.some((name) => name.endsWith(".meta.json"))).toBe(true);
    if (process.platform !== "win32") {
      const { lstatSync } = require("node:fs");
      expect(lstatSync(exportDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(exportDir, files.find((name) => name.endsWith(".jsonl"))!)).mode & 0o777).toBe(0o600);
    }
  });

  test("materialize is bound to the exact database selected during routing", () => {
    const repo = enrollRepo(makeGitRepo(join(scratch("llmwiki-oc-repo-"), "repo")));
    const firstDb = join(dir, "first.db");
    seed(repo, firstDb, "same-id", "FROM-FIRST-DB");
    const route = opencodeSource.discoverRoutes()[0]!;

    const otherRepo = makeGitRepo(join(scratch("llmwiki-oc-other-"), "repo"));
    const secondDb = join(dir, "second.db");
    seed(otherRepo, secondDb, "same-id", "FROM-SECOND-DB");

    expect(opencodeSource.materialize(route)).toBeNull();
    expect(existsSync(exportDir)).toBe(false);
  });

  test("unsafe session ids never become filesystem paths", () => {
    const repo = enrollRepo(makeGitRepo(join(scratch("llmwiki-oc-repo-"), "repo")));
    seed(repo, undefined, "../../escape");

    const route = opencodeSource.discoverRoutes()[0]!;
    const session = opencodeSource.materialize(route)!;

    expect(session.path.startsWith(realpathSync(exportDir) + "/")).toBe(true);
    expect(session.path).not.toContain("..");
    expect(readdirSync(exportDir).every((name) => /^[a-f0-9]{64}\.(jsonl|meta\.json)$/.test(name))).toBe(true);
  });
});
