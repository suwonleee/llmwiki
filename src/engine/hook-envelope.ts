// The hook output envelope, written in ONE place for the two entrypoints that emit it
// (src/hook-cli.ts for the shell adapters, src/cli.ts for the Windows Codex wiring that calls the
// CLI directly). Two emitters that each spelled the JSON by hand is how a field gets added to one
// and silently not the other.
//
// Both harnesses declare this shape — Claude Code as a zod variant per event, Codex as a JSON
// schema with additionalProperties:false on `hookSpecificOutput` — so the inner object carries
// exactly `hookEventName` + `additionalContext` and nothing else. `systemMessage` is a DECLARED
// top-level field on both (Claude Code: "warning message shown to the user"; Codex:
// `SessionStartCommandOutputWire.systemMessage`), which is what makes it the right channel for
// a line meant for the person rather than the model. It is attached only when there is one.
//
// Silence stays silence: no context means no envelope at all, never an empty one — and never a
// bare systemMessage either, because an unenrolled repository must be indistinguishable from no
// install.

export type HookEvent = "SessionStart" | "UserPromptSubmit";

export function hookEnvelope(event: HookEvent, additionalContext: string, systemMessage = ""): string {
  if (!additionalContext) return "";
  const envelope: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: event, additionalContext },
  };
  // Only SessionStart carries the person-facing line: UserPromptSubmit fires on every prompt and
  // a repeated banner there would be noise, not information.
  if (event === "SessionStart" && systemMessage) envelope.systemMessage = systemMessage;
  return JSON.stringify(envelope) + "\n";
}

/**
 * The PreToolUse envelope for edit-time rules (engine/edit-rules.ts). Two shapes, both declared by
 * Claude Code's PreToolUse variant: a `deny` with its reason — the only output the model sees
 * BEFORE the tool runs — or `additionalContext`, which arrives alongside the tool result. Never
 * an `allow`: its reason is shown to the person only, and an explicit allow would also bypass the
 * permission prompt the person configured. Same silence rule as above.
 */
export function preToolUseEnvelope(text: string, deny: boolean): string {
  if (!text) return "";
  const inner = deny
    ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text }
    : { hookEventName: "PreToolUse", additionalContext: text };
  return JSON.stringify({ hookSpecificOutput: inner }) + "\n";
}
