#!/usr/bin/env bun
// Live gate: what Codex's `request_user_input` actually does, measured rather than assumed.
//
// `/wiki-quiz` asks its questions through this tool, and the skill's Codex clauses encode three
// facts that no unit test can reach — they live in Codex's own binary and change with its
// releases. This harness drives `codex app-server` over stdio JSON-RPC, plays the human, and
// checks all three at once:
//
//   1. Default mode WITHOUT the flag refuses the call with a specific error string — the string
//      the skill tells the model to treat as "fall back to a numbered block".
//   2. Default mode WITH `default_mode_request_user_input` shows the prompt, non-blocking
//      (`isBlocking: false`), which is why the skill has to handle an EXPIRED question at all.
//   3. Plan mode shows it blocking (`isBlocking: true`) with no flag.
//
// Manual, not part of `bun test`: three real model turns cost money and need a signed-in Codex.
// Run it when Codex's version moves, then reconcile skill/wiki-quiz.md with what it prints.
//
//   LLMWIKI_LIVE=1 bun src/dev/codex-rui-smoke.ts
//   LLMWIKI_LIVE=1 LLMWIKI_CODEX_MODEL=gpt-5.4-mini bun src/dev/codex-rui-smoke.ts
//
// Last measured: Codex 0.153.4, 2026-09-06 — all three as described above.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Variant = "flag-on" | "flag-off" | "plan";

interface Outcome {
  variant: Variant;
  prompted: boolean;
  isBlocking: boolean | null;
  questionCount: number;
  isOther: boolean[];
  /** The model's final message: the echoed answer JSON, or the tool's refusal string. */
  finalMessage: string;
  error: string | null;
}

/** The model is asked to relay the tool's own output verbatim, so stdout carries Codex's words. */
const PROMPT =
  "Use the request_user_input tool exactly once. Ask two questions: id q1, header 'Q1', question " +
  "'Which color?', options red / green / blue (each with a one-sentence description); id q2, header " +
  "'Q2', question 'Which number?', options one / two / three. Do not add any '(Recommended)' suffix. " +
  "After the tool returns, reply with exactly the raw JSON string the tool returned and nothing else. " +
  "If the tool call fails, reply with exactly the error text you received and nothing else.";

const MODEL = process.env.LLMWIKI_CODEX_MODEL?.trim() || "gpt-5.4-mini";
const TURN_TIMEOUT_MS = 150_000;

async function run(variant: Variant): Promise<Outcome> {
  // A disposable cwd outside any repository: `thread/start` marks its cwd trusted in config.toml
  // when the sandbox is writable, and this harness must not change the operator's trust list.
  const cwd = mkdtempSync(join(tmpdir(), "llmwiki-rui-"));
  const outcome: Outcome = {
    variant,
    prompted: false,
    isBlocking: null,
    questionCount: 0,
    isOther: [],
    finalMessage: "",
    error: null,
  };
  const proc = Bun.spawn(
    [
      "codex",
      "app-server",
      "-c",
      `features.default_mode_request_user_input=${variant === "flag-on"}`,
      "-c",
      "suppress_unstable_features_warning=true",
    ],
    { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  let nextId = 0;
  const pending = new Map<number, (value: any) => void>();
  const send = (message: Record<string, unknown>): void => {
    proc.stdin.write(JSON.stringify(message) + "\n");
  };
  const request = (method: string, params: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ id, method, params });
    });
  };

  let turnDone = false;
  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && message.method === undefined) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
          continue;
        }
        const method = String(message.method ?? "");
        if (message.id !== undefined && method === "item/tool/requestUserInput") {
          const questions: any[] = message.params?.questions ?? [];
          outcome.prompted = true;
          outcome.isBlocking = message.params?.isBlocking ?? null;
          outcome.questionCount = questions.length;
          outcome.isOther = questions.map((question) => question.isOther === true);
          // Play the human: one option on q1, the appended free-form row plus a note on q2 —
          // the two shapes the skill has to decode.
          const answers: Record<string, { answers: string[] }> = {};
          for (const question of questions) {
            answers[question.id] =
              question.id === "q2"
                ? { answers: ["None of the above", "user_note: seven"] }
                : { answers: ["green"] };
          }
          send({ id: message.id, result: { answers } });
          continue;
        }
        if (message.id !== undefined) {
          // Any other server-initiated request (approvals, attestation): this harness handles none.
          send({ id: message.id, error: { code: -32601, message: `unsupported: ${method}` } });
          continue;
        }
        if (method === "item/completed" && message.params?.item?.type === "agentMessage") {
          outcome.finalMessage = message.params.item.text ?? "";
        } else if (method === "turn/completed") {
          turnDone = true;
        }
      }
    }
  })();

  try {
    await request("initialize", {
      clientInfo: { name: "llmwiki_rui_smoke", title: "llmwiki request_user_input smoke", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized" });
    const started = await request("thread/start", {
      cwd,
      model: MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
    const threadId = started.result?.thread?.id ?? "";
    if (!threadId) {
      outcome.error = `thread/start failed: ${JSON.stringify(started.error)}`;
      return outcome;
    }
    const params: Record<string, unknown> = { threadId, input: [{ type: "text", text: PROMPT }] };
    if (variant === "plan") {
      params.collaborationMode = {
        mode: "plan",
        settings: { model: MODEL, reasoning_effort: "medium", developer_instructions: null },
      };
    }
    const turn = await request("turn/start", params);
    if (turn.error) {
      outcome.error = `turn/start failed: ${JSON.stringify(turn.error)}`;
      return outcome;
    }
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (!turnDone && Date.now() < deadline) await Bun.sleep(500);
    if (!turnDone) outcome.error = `no turn/completed within ${TURN_TIMEOUT_MS / 1000}s`;
    return outcome;
  } finally {
    proc.kill();
    await reader.catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** What the skill's Codex clauses claim. A failure here means the skill now lies to the model. */
function verdicts(results: Map<Variant, Outcome>): { label: string; ok: boolean; saw: string }[] {
  const on = results.get("flag-on")!;
  const off = results.get("flag-off")!;
  const plan = results.get("plan")!;
  return [
    {
      label: "flag off + Default mode → the exact refusal string the skill triggers on",
      ok: !off.prompted && off.finalMessage.includes("request_user_input is unavailable in Default mode"),
      saw: off.prompted ? "prompted anyway" : off.finalMessage || "(no message)",
    },
    {
      label: "flag on + Default mode → prompt shown, NON-blocking (so a question can expire)",
      ok: on.prompted && on.isBlocking === false,
      saw: `prompted=${on.prompted} isBlocking=${on.isBlocking}`,
    },
    {
      label: "Plan mode → prompt shown, blocking, no flag needed",
      ok: plan.prompted && plan.isBlocking === true,
      saw: `prompted=${plan.prompted} isBlocking=${plan.isBlocking}`,
    },
    {
      label: "Codex forces its own free-form row (isOther) on every question",
      ok: on.isOther.length > 0 && on.isOther.every(Boolean) && plan.isOther.every(Boolean),
      saw: `flag-on=${JSON.stringify(on.isOther)} plan=${JSON.stringify(plan.isOther)}`,
    },
    {
      label: "answers come back keyed by question id, free-form prefixed `user_note:`",
      ok: on.finalMessage.includes("user_note: seven") && on.finalMessage.includes("green"),
      saw: on.finalMessage || "(no message)",
    },
  ];
}

if (import.meta.main) {
  if (process.env.LLMWIKI_LIVE !== "1") {
    console.error(
      "refusing to run: this gate makes three real Codex model calls.\n" +
        "  LLMWIKI_LIVE=1 bun src/dev/codex-rui-smoke.ts",
    );
    process.exit(2);
  }
  if (!Bun.which("codex")) {
    console.error("codex is not on PATH");
    process.exit(2);
  }
  const version = Bun.spawnSync(["codex", "--version"], { stdout: "pipe" }).stdout.toString().trim();
  console.log(`# request_user_input live gate — ${version}, model ${MODEL}\n`);

  const variants: Variant[] = ["flag-on", "flag-off", "plan"];
  const settled = await Promise.all(variants.map((variant) => run(variant)));
  const results = new Map<Variant, Outcome>(settled.map((outcome) => [outcome.variant, outcome]));
  for (const outcome of settled) {
    if (outcome.error) console.log(`  ! ${outcome.variant}: ${outcome.error}`);
  }

  let failed = 0;
  for (const verdict of verdicts(results)) {
    if (!verdict.ok) failed += 1;
    console.log(`  ${verdict.ok ? "✅" : "❌"} ${verdict.label}`);
    console.log(`       saw: ${verdict.saw}`);
  }
  console.log(
    failed === 0
      ? "\n✓ skill/wiki-quiz.md's Codex clauses still match this Codex"
      : `\n✗ ${failed} claim(s) no longer hold — reconcile skill/wiki-quiz.md before releasing`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
