import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousRoot = process.env.LLMWIKI_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.LLMWIKI_ROOT;
  else process.env.LLMWIKI_ROOT = previousRoot;
});

test("an active OpenCode plugin becomes silent immediately after llmwiki disable", async () => {
  process.env.LLMWIKI_ROOT = "/engine";
  let enrolled = true;
  const calls: string[] = [];
  const shell = (strings: TemplateStringsArray, ...values: any[]) => {
    const command = strings
      .flatMap((part, index) => [part, index < values.length ? values[index] : ""])
      .map((part) => Array.isArray(part) ? part.join(" ") : String(part))
      .join("");
    calls.push(command);
    let exitCode = 0;
    let output = "";
    if (command.includes(" enabled ")) exitCode = enrolled ? 0 : 1;
    else if (command.includes(" opencode-context ")) {
      exitCode = enrolled ? 0 : 1;
      output = JSON.stringify({
        cold: command.includes("--include-cold") ? "[llmwiki]\ncold context" : "",
        turn: command.includes("remember this prompt") ? "turn pointer" : "",
      });
    }
    const result: any = {
      quiet: () => result,
      nothrow: async () => ({ exitCode, text: () => output }),
    };
    return result;
  };
  const module = await import(`../adapters/opencode/llmwiki.ts?enrollment-test=${Date.now()}`);
  const hooks: any = await module.default.server({ $: shell, directory: "/repo" } as any);

  await hooks["chat.message"](
    { sessionID: "s1" },
    { parts: [{ type: "text", text: "remember this prompt" }] },
  );
  const before = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, before);
  expect(before.system).toContain("[llmwiki]\ncold context");
  expect(before.system).toContain("turn pointer");

  enrolled = false;
  await hooks["chat.message"](
    { sessionID: "s1" },
    { parts: [{ type: "text", text: "must not be retained" }] },
  );
  const disabled = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, disabled);
  expect(disabled.system).toEqual([]);

  enrolled = true;
  const reenabled = { system: [] as string[] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, reenabled);
  expect(reenabled.system).toEqual(["[llmwiki]\ncold context"]);
  expect(calls.filter((command) => command.includes(" opencode-context ") && command.includes("remember this prompt"))).toHaveLength(1);
  expect(calls.filter((command) => command.includes(" opencode-context "))).toHaveLength(3);
});

// OpenCode's command templates have no session-id variable, so /wiki-* commands cannot know which
// session they are closing out — and a close-out that guesses can file another session's work.
// `command.execute.before` is the one plugin surface that receives the real sessionID at command
// time; the hook must hand it to the model (and pre-run save-current), for wiki commands only,
// and stay silent for an unenrolled repository.
test("command.execute.before injects the exact session id for wiki commands only", async () => {
  process.env.LLMWIKI_ROOT = "/engine";
  let enrolled = true;
  const calls: string[] = [];
  const shell = (strings: TemplateStringsArray, ...values: any[]) => {
    const command = strings
      .flatMap((part, index) => [part, index < values.length ? values[index] : ""])
      .map((part) => (Array.isArray(part) ? part.join(" ") : String(part)))
      .join("");
    calls.push(command);
    const result: any = {
      quiet: () => result,
      nothrow: async () => ({ exitCode: command.includes(" enabled ") && !enrolled ? 1 : 0, text: () => "" }),
    };
    return result;
  };
  const module = await import(`../adapters/opencode/llmwiki.ts?command-test=${Date.now()}`);
  const hooks: any = await module.default.server({ $: shell, directory: "/repo" } as any);

  // a wiki command gets the id injected AND a best-effort save-current pre-run
  const parts: any[] = [{ type: "text", text: "command template body" }];
  await hooks["command.execute.before"]({ command: "wiki-save", sessionID: "ses_exact" }, { parts });
  const injected = parts.filter((p) => String(p.text ?? "").includes("current OpenCode session id"));
  expect(injected).toHaveLength(1);
  expect(injected[0]!.text).toContain("ses_exact");
  expect(injected[0]!.text).toContain("save-current /repo --session ses_exact");
  expect(calls.some((c) => c.includes(" save-current ") && c.includes("ses_exact"))).toBe(true);

  // a non-wiki command is untouched — no CLI call, no injection
  const before = calls.length;
  const other: any[] = [];
  await hooks["command.execute.before"]({ command: "review", sessionID: "ses_exact" }, { parts: other });
  expect(other).toEqual([]);
  expect(calls.length).toBe(before);

  // unenrolled → the wiki command is also silent (fail closed)
  enrolled = false;
  const disabled: any[] = [];
  await hooks["command.execute.before"]({ command: "wiki-save", sessionID: "ses_exact" }, { parts: disabled });
  expect(disabled).toEqual([]);
  expect(calls.filter((c) => c.includes(" save-current ")).length).toBe(1);
});

// ---- OpenCode 2 entry point (`setup`) ------------------------------------------------------
// 2.x has no `$`; the plugin spawns `bun <ROOT>/src/<script>.ts` itself. A fake engine root with
// the two scripts keeps that real spawn path under test.

function fakeEngine(): { root: string; log: string; disable(): void } {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-oc2-engine-"));
  mkdirSync(join(root, "src"));
  const log = join(root, "calls.log");
  const off = join(root, "disabled");
  writeFileSync(
    join(root, "src", "hook-cli.ts"),
    `import { appendFileSync, existsSync } from "node:fs";
const [cmd, ...rest] = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, ["hook-cli", cmd, ...rest].join(" ") + "\\n");
if (existsSync(${JSON.stringify(off)})) process.exit(1);
if (cmd === "opencode-context") {
  const at = rest.indexOf("--prompt");
  const prompt = at >= 0 ? rest[at + 1] ?? "" : "";
  console.log(JSON.stringify({ cold: rest.includes("--include-cold") ? "[llmwiki]\\ncold context" : "", turn: prompt ? "turn for " + prompt : "" }));
}
`,
  );
  writeFileSync(
    join(root, "src", "cli.ts"),
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, ["cli", ...process.argv.slice(2)].join(" ") + "\\n");
`,
  );
  return { root, log, disable: () => writeFileSync(off, "") };
}

function fakeContext(directory: string) {
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const disposed: string[] = [];
  return {
    hooks,
    disposed,
    ctx: {
      location: { directory },
      session: {
        hook: async (name: string, cb: (event: any) => Promise<void>) => {
          hooks.set(name, cb);
          return { dispose: async () => void disposed.push(name) };
        },
      },
    },
  };
}

test("OpenCode 2: prompt is remembered, context gets cold + turn parts, disable revokes", async () => {
  const engine = fakeEngine();
  try {
    process.env.LLMWIKI_ROOT = engine.root;
    const module = await import(`../adapters/opencode/llmwiki.ts?v2-context=${Date.now()}`);
    const { hooks, ctx, disposed } = fakeContext("/repo");
    const cleanup = await module.default.setup(ctx);
    expect([...hooks.keys()].sort()).toEqual(["context", "prompt"]);

    await hooks.get("prompt")!({ sessionID: "s1", prompt: { text: "remember this prompt" } });
    const event = { sessionID: "s1", system: [{ type: "text", text: "host system" }] };
    await hooks.get("context")!(event);
    expect(event.system.map((p) => p.text)).toEqual(["host system", "[llmwiki]\ncold context", "turn for remember this prompt"]);

    // the next request reuses the cached cold blob and the prompt is consumed
    const again = { sessionID: "s1", system: [] as any[] };
    await hooks.get("context")!(again);
    expect(again.system.map((p) => p.text)).toEqual(["[llmwiki]\ncold context"]);
    const contextCalls = readFileSync(engine.log, "utf8").split("\n").filter((l) => l.includes("opencode-context"));
    expect(contextCalls).toHaveLength(2);
    expect(contextCalls[1]).not.toContain("--prompt");
    expect(readFileSync(engine.log, "utf8").split("\n").filter((l) => l.includes("--include-cold"))).toHaveLength(1);

    engine.disable();
    const disabled = { sessionID: "s1", system: [] as any[] };
    await hooks.get("context")!(disabled);
    expect(disabled.system).toEqual([]);
    expect(typeof cleanup).toBe("function");
    await cleanup();
    expect(disposed.sort()).toEqual(["context", "prompt"]);
  } finally {
    rmSync(engine.root, { recursive: true, force: true });
  }
});

test("OpenCode 2: a /wiki-* command body gets the exact session id; other prompts do not", async () => {
  const engine = fakeEngine();
  try {
    process.env.LLMWIKI_ROOT = engine.root;
    const module = await import(`../adapters/opencode/llmwiki.ts?v2-command=${Date.now()}`);
    const { hooks, ctx } = fakeContext("/repo");
    await module.default.setup(ctx);

    const command = { sessionID: "ses_exact", prompt: { text: "<!-- llmwiki-opencode-managed root=/x source_sha256=y -->\n\n# /wiki-save" } };
    await hooks.get("prompt")!(command);
    expect(command.prompt.text).toContain("current OpenCode session id: ses_exact");
    expect(command.prompt.text).toContain("save-current /repo --session ses_exact");
    expect(readFileSync(engine.log, "utf8")).toContain("cli save-current /repo --session ses_exact");

    // the template is not used as a turn-context query
    const event = { sessionID: "ses_exact", system: [] as any[] };
    await hooks.get("context")!(event);
    expect(event.system.map((p) => p.text)).toEqual(["[llmwiki]\ncold context"]);

    const plain = { sessionID: "ses_exact", prompt: { text: "ordinary question" } };
    await hooks.get("prompt")!(plain);
    expect(plain.prompt.text).toBe("ordinary question");

    // a person quoting the marker mid-text is not running a command
    const quoted = { sessionID: "ses_quote", prompt: { text: "why does <!-- llmwiki-opencode-managed root=x --> appear?" } };
    await hooks.get("prompt")!(quoted);
    expect(quoted.prompt.text).not.toContain("current OpenCode session id");
    expect(readFileSync(engine.log, "utf8")).not.toContain("--session ses_quote");
  } finally {
    rmSync(engine.root, { recursive: true, force: true });
  }
});

test("OpenCode 2: an unenrolled project registers no hook at all", async () => {
  const engine = fakeEngine();
  try {
    engine.disable();
    process.env.LLMWIKI_ROOT = engine.root;
    const module = await import(`../adapters/opencode/llmwiki.ts?v2-gate=${Date.now()}`);
    const { hooks, ctx } = fakeContext("/repo");
    await module.default.setup(ctx);
    expect(hooks.size).toBe(0);
    expect(existsSync(engine.log)).toBe(true); // the gate did ask
  } finally {
    rmSync(engine.root, { recursive: true, force: true });
  }
});
