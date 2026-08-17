#!/usr/bin/env bun
// Lightweight automatic-hook entrypoint.
//
// The public CLI imports every maintenance/evaluation surface before dispatch. That is appropriate
// for a human command and wasteful on a synchronous per-turn hook. This entrypoint imports only the
// selected automatic path, after the enrollment gate where possible, and preserves the same silence
// and JSON-envelope contracts as `src/cli.ts`.

type Payload = Record<string, unknown>;

function valueFlag(name: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? String(Bun.argv[index + 1] ?? "") : "";
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(name);
}

function writeTurnEnvelope(text: string): void {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    }) + "\n",
  );
}

async function enabled(repo: string): Promise<void> {
  const { isEnrolled } = await import("./engine/enrollment.ts");
  if (!isEnrolled(repo || process.cwd())) process.exitCode = 1;
}

async function turnContextHook(repo: string): Promise<void> {
  if ((process.env.LLMWIKI_ENGINE_SUBPROCESS ?? "") !== "") return;
  let payload: Payload;
  try {
    payload = JSON.parse(await Bun.stdin.text()) as Payload;
  } catch {
    return;
  }
  if (String(payload.agent_type ?? "").trim() || String(payload.agent_id ?? "").trim()) return;
  const prompt = String(payload.prompt ?? "");
  if (!prompt) return;
  const sessionId = String(payload.session_id ?? "");
  const target = String(payload.cwd ?? "").trim() || repo || process.cwd();
  const [{ inspectEnrollment, isEnrolled }, { wikiRootFor }, { buildTurnContext }, { recordEmission }] =
    await Promise.all([
      import("./engine/enrollment.ts"),
      import("./engine/wiki-root.ts"),
      import("./engine/turncontext.ts"),
      import("./engine/observe.ts"),
    ]);
  if (!isEnrolled(target)) return;
  const root = wikiRootFor(target, inspectEnrollment(target).worktree);
  const out = buildTurnContext(root, prompt, sessionId);
  if (out) recordEmission(root, sessionId, "turn_context", out);
  writeTurnEnvelope(out);
}

async function openCodeContext(repo: string): Promise<void> {
  const prompt = valueFlag("--prompt");
  const sessionId = valueFlag("--session");
  const { inspectEnrollment, isEnrolled } = await import("./engine/enrollment.ts");
  if (!isEnrolled(repo)) {
    process.exitCode = 1;
    return;
  }
  const [{ wikiRootFor }, { buildContext }, { buildTurnContext }, { recordEmission }] = await Promise.all([
    import("./engine/wiki-root.ts"),
    import("./engine/context.ts"),
    import("./engine/turncontext.ts"),
    import("./engine/observe.ts"),
  ]);
  const root = wikiRootFor(repo, inspectEnrollment(repo).worktree);
  const cold = hasFlag("--include-cold") ? buildContext(root) : "";
  const turn = prompt ? buildTurnContext(root, prompt, sessionId) : "";
  if (cold) recordEmission(root, sessionId, "cold_start", cold);
  if (turn) recordEmission(root, sessionId, "turn_context", turn);
  process.stdout.write(JSON.stringify({ cold, turn }) + "\n");
}

const command = Bun.argv[2] ?? "";
const repo = Bun.argv[3] ?? "";
try {
  if (command === "enabled") await enabled(repo);
  else if (command === "turn-context-hook") await turnContextHook(repo);
  else if (command === "opencode-context") await openCodeContext(repo);
  else process.exitCode = 2;
} catch {
  // Automatic integration is fail-safe. `opencode-context` uses a nonzero status so the plugin can
  // revoke cached prompt/context state; command hooks remain silent success and never break a turn.
  if (command === "opencode-context" || command === "enabled") process.exitCode = 1;
}
