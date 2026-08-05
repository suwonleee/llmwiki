import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The adapter imports its host's SDK as a VALUE (`definePluginEntry`), and `openclaw` is a peer
// dependency of the published package, not a dependency of this engine. Stub the specifier so the
// real hook logic can be exercised here — the alternative (asserting on the file's source text)
// would prove nothing about behaviour. `definePluginEntry` is a normalizer that returns its own
// fields (openclaw src/plugin-sdk/plugin-entry.ts:354), so identity is a faithful stand-in.
mock.module("openclaw/plugin-sdk/plugin-entry", () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

/**
 * A fake engine at $LLMWIKI_ROOT/src/cli.ts.
 *
 * Deliberately a real subprocess rather than a mocked exec: the whole point of this adapter is
 * that it shells out (the engine is Bun-bound and OpenClaw is Node), so a test that stubbed the
 * spawn would verify the one thing that cannot break while skipping the one that can.
 */
const ENGINE = `
const [cmd, dir] = [process.argv[2], process.argv[3]];
const calls = process.env.FAKE_ENGINE_LOG;
if (calls) require("node:fs").appendFileSync(calls, cmd + "\\n");
if (cmd === "enabled") process.exit(String(dir).includes("enrolled") ? 0 : 1);
if (cmd === "context") console.log("===== [llmwiki] cold-start =====");
if (cmd === "turn-context") {
  const i = process.argv.indexOf("--prompt");
  if (String(process.argv[i + 1] ?? "").includes("wiki")) console.log("[llmwiki] pointer line");
}
process.exit(0);
`;

let dir: string;
let logFile: string;
let entry: any;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-openclaw-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "cli.ts"), ENGINE);
  chmodSync(join(dir, "src", "cli.ts"), 0o755);
  logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  process.env.LLMWIKI_ROOT = dir;
  process.env.FAKE_ENGINE_LOG = logFile;
  // ROOT is read at module scope, so the env must be set before the first import.
  entry = (await import(`../adapters/openclaw/llmwiki.ts?openclaw-test=${Date.now()}`)).default;
});

afterAll(() => {
  delete process.env.LLMWIKI_ROOT;
  delete process.env.FAKE_ENGINE_LOG;
  rmSync(dir, { recursive: true, force: true });
});

/** Register the plugin and hand back the hooks it declared, keyed by event name. */
function hooks(): Map<string, (event: any, ctx: any) => any> {
  const registered = new Map<string, (event: any, ctx: any) => any>();
  entry.register({ on: (name: string, handler: any) => registered.set(name, handler) });
  return registered;
}

const engineCalls = (): string[] => readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);

describe("openclaw adapter", () => {
  test("declares the plugin identity OpenClaw's manifest expects", () => {
    expect(entry.id).toBe("llmwiki");
    expect(typeof entry.register).toBe("function");
    const names = [...hooks().keys()];
    expect(names).toContain("before_prompt_build");
    expect(names).toContain("session_start");
    expect(names).toContain("session_end");
  });

  test("an unenrolled workspace contributes nothing at all", async () => {
    const h = hooks().get("before_prompt_build")!;
    const out = await h({ prompt: "anything about the wiki" }, { sessionId: "s1", workspaceDir: "/tmp/plain" });
    // Not an empty object: OpenClaw merges whatever comes back, and an empty context entry is
    // still an entry. Installation alone is not consent to inject.
    expect(out).toBeUndefined();
  });

  test("an enrolled workspace gets the cold start, and only once per session", async () => {
    writeFileSync(logFile, "");
    const h = hooks().get("before_prompt_build")!;
    const ctx = { sessionId: "s2", workspaceDir: join(dir, "enrolled") };

    const first = await h({ prompt: "" }, ctx);
    expect(first.prependSystemContext).toContain("[llmwiki] cold-start");

    const second = await h({ prompt: "" }, ctx);
    expect(second.prependSystemContext).toContain("[llmwiki] cold-start");
    // One `context` call across both turns — the blob is constant for a session, and
    // prependSystemContext is the provider-cacheable slot precisely because of that.
    expect(engineCalls().filter((c) => c === "context")).toHaveLength(1);
  });

  test("a silent turn adds no context entry", async () => {
    const h = hooks().get("before_prompt_build")!;
    const out = await h(
      { prompt: "unrelated question" },
      { sessionId: "s3", workspaceDir: join(dir, "enrolled") },
    );
    expect(out.prependSystemContext).toBeTruthy();
    expect(out.appendContext).toBeUndefined(); // the engine is precision-first; silence is the common case
  });

  test("a matching turn appends pointers", async () => {
    const h = hooks().get("before_prompt_build")!;
    const out = await h(
      { prompt: "where did we decide the wiki format?" },
      { sessionId: "s4", workspaceDir: join(dir, "enrolled") },
    );
    expect(out.appendContext).toContain("[llmwiki] pointer line");
  });

  test("session lifecycle drops the cached blob so a Gateway process cannot leak it forward", async () => {
    const registered = hooks();
    const h = registered.get("before_prompt_build")!;
    const ctx = { sessionId: "s5", workspaceDir: join(dir, "enrolled") };
    await h({ prompt: "" }, ctx);
    writeFileSync(logFile, "");
    registered.get("session_end")!({ sessionId: "s5" }, {});
    await h({ prompt: "" }, ctx);
    expect(engineCalls().filter((c) => c === "context")).toHaveLength(1); // re-fetched, not reused
  });

  test("no engine on the machine is silence, not an exception", async () => {
    const saved = process.env.LLMWIKI_ROOT;
    process.env.LLMWIKI_ROOT = join(dir, "does-not-exist");
    const fresh = (await import(`../adapters/openclaw/llmwiki.ts?missing-engine=${Date.now()}`)).default;
    const registered = new Map<string, any>();
    fresh.register({ on: (name: string, handler: any) => registered.set(name, handler) });
    const out = await registered.get("before_prompt_build")!(
      { prompt: "wiki" },
      { sessionId: "s6", workspaceDir: join(dir, "enrolled") },
    );
    expect(out).toBeUndefined(); // fail closed: an unknown answer is not consent
    process.env.LLMWIKI_ROOT = saved;
  });
});
