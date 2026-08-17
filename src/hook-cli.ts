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

/**
 * Read the harness's hook payload, or nothing at all.
 *
 * Two cases must NOT be confused. A hook's stdin is the payload pipe and the harness closes it, so
 * reading is safe there; a terminal's stdin is not, and reading it would hang the person who ran
 * this entrypoint by hand to debug a session. `src/cli.ts` has always made that distinction before
 * touching stdin, and this entrypoint inherits its contracts.
 *
 * An absent or malformed payload is "the harness told us nothing", never "abort" — see contextHook.
 */
async function readPayload(): Promise<Payload | null> {
  if (process.stdin.isTTY) return null;
  try {
    const raw = await Bun.stdin.text();
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Payload) : null;
  } catch {
    return null;
  }
}

function writeEnvelope(event: "SessionStart" | "UserPromptSubmit", text: string): void {
  if (!text) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    }) + "\n",
  );
}

async function enabled(repo: string): Promise<void> {
  const { isEnrolled } = await import("./engine/enrollment.ts");
  if (!isEnrolled(repo || process.cwd())) process.exitCode = 1;
}

async function contextHook(repo: string): Promise<void> {
  if ((process.env.LLMWIKI_ENGINE_SUBPROCESS ?? "") !== "") return;
  // A missing payload costs the ROUTE HINT, not the cold start. The payload is how a harness tells
  // us which repository and session this transcript belongs to — worth having, never a precondition
  // for reading the wiki. The adapters already pass the project as a positional, and `cli.ts` fell
  // back to it here; treating an unparseable payload as "return silently" instead would mean any
  // harness that starts a session without one loses its work memory and reports nothing at all.
  const payload = await readPayload();
  const target = String(payload?.cwd ?? "").trim() || repo || process.cwd();
  const sessionId = String(payload?.session_id ?? "").trim();
  const transcript = String(payload?.transcript_path ?? "").trim();
  const { inspectEnrollment, isEnrolled } = await import("./engine/enrollment.ts");
  if (!isEnrolled(target)) return;
  const status = inspectEnrollment(target);
  if (transcript && status.worktree) {
    const [{ resolve }, capture] = await Promise.all([import("node:path"), import("./engine/capture.ts")]);
    const normalized = transcript.replaceAll("\\", "/");
    const kind = normalized.includes("/.codex/") ? "codex" : normalized.endsWith(".jsonl") ? "claude-jsonl" : null;
    capture.recordRouteHint(resolve(transcript), target, sessionId || null, kind);
  }
  const [{ wikiRootFor }, { buildContext }, { recordEmission }] = await Promise.all([
    import("./engine/wiki-root.ts"),
    import("./engine/context.ts"),
    import("./engine/observe.ts"),
  ]);
  const root = wikiRootFor(target, status.worktree);
  const out = buildContext(root);
  if (out && sessionId) recordEmission(root, sessionId, "cold_start", out);
  writeEnvelope("SessionStart", out);
}

async function turnContextHook(repo: string): Promise<void> {
  if ((process.env.LLMWIKI_ENGINE_SUBPROCESS ?? "") !== "") return;
  const payload = await readPayload();
  if (!payload) return; // no prompt, nothing to retrieve for — the same silence as an empty one
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
  writeEnvelope("UserPromptSubmit", out);
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
  else if (command === "context-hook") await contextHook(repo);
  else if (command === "turn-context-hook") await turnContextHook(repo);
  else if (command === "opencode-context") await openCodeContext(repo);
  else process.exitCode = 2;
} catch {
  // Automatic integration is fail-safe. `opencode-context` uses a nonzero status so the plugin can
  // revoke cached prompt/context state; command hooks remain silent success and never break a turn.
  if (command === "opencode-context" || command === "enabled") process.exitCode = 1;
}
