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
    else if (command.includes(" context ")) output = "[llmwiki]\ncold context";
    else if (command.includes(" turn-context ")) output = "turn pointer";
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
  expect(calls.filter((command) => command.includes(" turn-context "))).toHaveLength(1);
});
