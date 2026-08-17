// Public-clone mechanics for the two non-Claude harnesses. The existing fresh-public-loop oracle
// covers Claude; these scenarios exercise the installed Codex hook commands and the installed
// OpenCode plugin callbacks before proving capture and exact-session close-out selection.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";
import { supervisorStubs } from "./support/service-definition.ts";

const ROOT = join(import.meta.dir, "..");
type Harness = "codex" | "opencode";

type Scenario = {
  scratch: string;
  clone: string;
  repo: string;
  env: Record<string, string>;
  run(args: string[], cwd?: string, stdin?: string): ReturnType<typeof Bun.spawnSync>;
};

function text(result: ReturnType<typeof Bun.spawnSync>): string {
  return (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
}

function prepare(harness: Harness): Scenario {
  const scratch = mkdtempSync(join(tmpdir(), `llmwiki-fresh-${harness}-`));
  const remote = join(scratch, "public.git");
  const clone = join(scratch, "public clone");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  const repo = join(scratch, "project");
  const codexHome = join(scratch, "codex");
  const configHome = join(scratch, "config");
  const dataHome = join(scratch, "data");
  const state = join(scratch, "state");
  for (const dir of [home, repo, codexHome, configHome, dataHome]) mkdirSync(dir, { recursive: true });
  inertSupervisorBin(bin, {
    codex:
      "#!/bin/sh\n" +
      "if [ \"${1:-}\" = --help ]; then printf '%s\\n' --dangerously-bypass-hook-trust; fi\n" +
      "if [ \"${1:-}\" = features ] && [ \"${2:-}\" = list ]; then printf 'hooks stable true\\n'; fi\n" +
      "exit 0\n",
    opencode:
      "#!/bin/sh\n" +
      "if [ \"${1:-}\" = run ] && [ \"${2:-}\" = --help ]; then printf '%s\\n' --command; fi\n" +
      "exit 0\n",
    ...supervisorStubs(),
  });
  const git = join(bin, "git");
  writeFileSync(git, "#!/bin/sh\nexec /usr/bin/git \"$@\"\n");
  chmodSync(git, 0o755);
  const env: Record<string, string> = {
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: join(scratch, "xdg-state"),
    LLMWIKI_STATE_DIR: state,
    LLMWIKI_LANG: "en",
    PATH: [bin, dirname(process.execPath), join(home, ".local", "bin"), "/usr/bin", "/bin"].join(":"),
    USER: `fresh-${harness}`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  const run = (args: string[], cwd = clone, stdin?: string) =>
    Bun.spawnSync(args, {
      cwd,
      env,
      stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  const must = (args: string[], cwd = clone, stdin?: string): ReturnType<typeof Bun.spawnSync> => {
    const result = run(args, cwd, stdin);
    expect(result.exitCode, text(result)).toBe(0);
    return result;
  };

  must(["git", "clone", "-q", "--bare", "--no-hardlinks", ROOT, remote], scratch);
  const sha = text(must(["git", "-C", ROOT, "rev-parse", "HEAD"], scratch)).trim();
  must(["git", "--git-dir", remote, "tag", "-f", `fresh-${harness}-v1`, sha], scratch);
  must(["git", "clone", "-q", "--branch", `fresh-${harness}-v1`, "--single-branch", remote, clone], scratch);
  must(["git", "init", "-q", repo], scratch);

  if (harness === "opencode") {
    const dbPath = join(dataHome, "opencode", "opencode.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
        time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER);
    `);
    db.close();
    env.OPENCODE_DB = dbPath;
  }

  must(["bash", join(clone, "setup.sh"), "--harness", harness]);
  must([process.execPath, join(clone, "src", "cli.ts"), "init", repo]);
  return { scratch, clone, repo, env, run };
}

function seedCodex(s: Scenario, session = "fresh-codex-session"): string {
  const path = join(s.env.CODEX_HOME!, "sessions", "2026", "08", "17", `${session}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const rows: unknown[] = [{ type: "session_meta", payload: { id: session, cwd: s.repo } }];
  for (let index = 0; index < 30; index += 1) {
    rows.push({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `codex work-memory prompt ${index}` }] },
    });
    rows.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: `codex durable restart boundary ${index}: cobalt stays canonical. `.repeat(4),
        }],
      },
    });
  }
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

function seedOpenCode(s: Scenario, session = "fresh-opencode-session"): void {
  const db = new Database(s.env.OPENCODE_DB!);
  db.query("INSERT INTO session VALUES (?,?,?,?,NULL)").run(session, s.repo, "Fresh OpenCode", 100);
  const insert = db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)");
  for (let index = 0; index < 30; index += 1) {
    insert.run(`${session}-u-${index}`, session, "user", index * 2, JSON.stringify({ text: `opencode prompt ${index}` }), index * 2);
    insert.run(
      `${session}-a-${index}`,
      session,
      "assistant",
      index * 2 + 1,
      JSON.stringify({
        content: [{
          type: "text",
          text: `opencode durable restart boundary ${index}: cobalt stays canonical. `.repeat(4),
        }],
      }),
      index * 2 + 1,
    );
  }
  db.close();
}

describe("fresh public clone across non-Claude harnesses", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("Codex installed hooks inject memory and its rollout reaches exact-session close-out", () => {
    const s = prepare("codex");
    scratch.push(s.scratch);
    const session = "fresh-codex-session";
    const transcript = seedCodex(s, session);
    const hooks = JSON.parse(readFileSync(join(s.env.CODEX_HOME!, "hooks.json"), "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command as string;
    const cold = s.run(
      ["bash", "-c", command],
      s.repo,
      JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: s.repo }),
    );
    expect(cold.exitCode, text(cold)).toBe(0);
    expect(text(cold)).toContain("Current State");

    const swept = s.run([process.execPath, join(s.clone, "src", "daemon", "watch.ts"), "--once"]);
    expect(text(swept)).toContain("enqueued=1");
    const selected = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "save-current", s.repo, "--session", session]);
    expect(text(selected)).toContain(transcript);
    const next = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "update-next", s.repo, transcript]);
    expect(text(next)).toContain("cobalt stays canonical");
    const verified = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "verify", s.repo, "--harness", "codex"]);
    expect(verified.exitCode, text(verified)).toBe(0);
    expect(text(verified)).toContain("READY: automatic work-memory read and capture mechanics are active");
  }, 25_000);

  test("OpenCode installed plugin injects memory and its DB session reaches exact-session close-out", async () => {
    const s = prepare("opencode");
    scratch.push(s.scratch);
    const session = "fresh-opencode-session";
    seedOpenCode(s, session);
    const pluginPath = join(s.env.XDG_CONFIG_HOME!, "opencode", "plugin", "llmwiki.ts");
    const plugin = (await import(`${pluginPath}?fresh=${Date.now()}`)).default as (input: any) => Promise<Record<string, any>>;
    const dollar = (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The installed adapter has two command templates, both shaped as
      // `bun ${ROOT}/src/<entrypoint> <command> ${args}`. Preserve interpolated paths as one argv
      // element even when the public clone path contains spaces.
      const afterRoot = strings[1]!.trim().split(/\s+/).filter(Boolean);
      const entrypoint = String(values[0]) + afterRoot.shift();
      const argv = ["bun", entrypoint, ...afterRoot];
      const tail = values[1];
      if (Array.isArray(tail)) argv.push(...tail.map(String));
      else if (tail !== undefined) argv.push(String(tail));
      const chain: any = {
        quiet: () => chain,
        nothrow: async () => {
          const result = s.run(argv, s.repo);
          return { exitCode: result.exitCode ?? 1, text: () => result.stdout?.toString() ?? "" };
        },
      };
      return chain;
    };
    const callbacks = await plugin({ $: dollar, directory: s.repo });
    const output = { system: [] as string[] };
    await callbacks["chat.message"]({ sessionID: session }, { parts: [{ type: "text", text: "cobalt restart boundary" }] });
    await callbacks["experimental.chat.system.transform"]({ sessionID: session }, output);
    expect(output.system.join("\n")).toContain("Current State");

    const swept = s.run([process.execPath, join(s.clone, "src", "daemon", "watch.ts"), "--once"]);
    expect(text(swept)).toContain("enqueued=1");
    const selected = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "save-current", s.repo, "--session", session]);
    const selectedText = text(selected);
    expect(selectedText).toContain(`current session ${session.slice(0, 8)}`);
    const transcript = selectedText.match(/(?:^|\s)(\/[^\n]*\.jsonl)(?:\s|$)/)?.[1];
    expect(transcript).toBeTruthy();
    const next = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "update-next", s.repo, transcript!]);
    expect(text(next)).toContain("cobalt stays canonical");
    const verified = s.run([process.execPath, join(s.clone, "src", "cli.ts"), "verify", s.repo, "--harness", "opencode"]);
    expect(verified.exitCode, text(verified)).toBe(0);
    expect(text(verified)).toContain("READY: automatic work-memory read and capture mechanics are active");
  }, 25_000);
});
