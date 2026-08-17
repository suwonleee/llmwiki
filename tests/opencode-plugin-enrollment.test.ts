import { afterEach, expect, test } from "bun:test";

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
  const hooks: any = await module.LlmwikiPlugin({ $: shell, directory: "/repo" } as any);

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
  const hooks: any = await module.LlmwikiPlugin({ $: shell, directory: "/repo" } as any);

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
