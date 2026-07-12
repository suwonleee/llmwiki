// llmwiki OpenCode plugin — thin adapter over the harness-neutral engine.
//
// OpenCode has no declarative shell hooks; the supported surface is a JS plugin. This one
// mirrors the two Claude/Codex hooks:
//   session start → inject `llmwiki context` output once per session
//   per user turn → inject `llmwiki turn-context` pointer lines (silent on most turns)
// Both go through `experimental.chat.system.transform` (appends system strings per request).
//
// Install: copy this file into your project's `.opencode/plugin/` (or global
// `~/.config/opencode/plugin/`) and set LLMWIKI_ROOT below or via env.
// VERIFIED on OpenCode 1.3.0 (2026-07-10): plugin loads from the global dir, chat.message
// captures the prompt, system.transform fires at request build, and the engine's
// turn-context session state appears in $TMPDIR — end-to-end live. LLMWIKI_ROOT must be
// set (env or edit the fallback below) or the plugin silently no-ops.
// NOTE: the experimental.* hook names may churn with OpenCode releases — this adapter is
// deliberately one file so an API change costs one file (debt containment).
import type { Plugin } from "@opencode-ai/plugin";

const ROOT = process.env.LLMWIKI_ROOT ?? ""; // absolute path of the llmwiki clone

export const LlmwikiPlugin: Plugin = async ({ $, directory }) => {
  // OpenCode rebuilds the system array PER REQUEST (it does not accumulate like chat
  // history), so the cold-start blob must be pushed on every main request — a once-per-
  // session gate starves all requests after the first (and the first transform may even
  // be a hidden agent like `title`). Fetch once per process, then reuse the cached blob.
  let coldCache: string | null = null;
  let lastPrompt = "";

  const run = async (args: string[]): Promise<string> => {
    if (!ROOT) return "";
    try {
      const r = await $`bun ${ROOT}/src/cli.ts ${args}`.quiet().nothrow();
      return r.exitCode === 0 ? r.text().trim() : "";
    } catch {
      return ""; // fail-safe: never break a turn
    }
  };

  return {
    // capture the user's prompt text as it is sent (used by the per-turn query below)
    "chat.message": async (_input, output) => {
      try {
        const texts = (output.parts ?? [])
          .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
          .filter(Boolean);
        if (texts.length) lastPrompt = texts.join("\n");
      } catch {
        /* observation only */
      }
    },
    "experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      const sid = String(input?.sessionID ?? "");
      // (a) cold-start blob — every request (system arrays are rebuilt per request);
      // engine output cached per process, in-array guard keeps it idempotent.
      if (coldCache === null) coldCache = await run(["context", directory]);
      if (coldCache && !output.system.some((s) => s.includes("[llmwiki]"))) {
        output.system.push(coldCache);
      }
      // (b) per-turn pointers — engine is precision-first and usually silent
      if (lastPrompt) {
        const turn = await run(["turn-context", directory, "--prompt", lastPrompt, "--session", sid]);
        if (turn) output.system.push(turn);
        lastPrompt = "";
      }
    },
  };
};

export default LlmwikiPlugin;
