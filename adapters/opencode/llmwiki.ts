// llmwiki OpenCode plugin — thin adapter over the harness-neutral engine.
//
// OpenCode has no declarative shell hooks; the supported surface is a JS plugin. This one
// mirrors the two Claude/Codex hooks:
//   session start → inject `llmwiki context` output once per session
//   per user turn → inject `llmwiki turn-context` pointer lines (silent on most turns)
// Both go through `experimental.chat.system.transform` (appends system strings per request).
//
// Install: `./setup.sh --harness opencode` writes a global, clone-pinned copy to
// `~/.config/opencode/plugin/` (or `$XDG_CONFIG_HOME/opencode/plugin/`).
// VERIFIED on OpenCode 1.3.0 (2026-07-10): plugin loads from the global dir, chat.message
// captures the prompt, system.transform fires at request build, and the engine's
// turn-context session state appears in $TMPDIR — end-to-end live. LLMWIKI_ROOT must be
// set (env or edit the fallback below) or the plugin silently no-ops.
// NOTE: the experimental.* hook names may churn with OpenCode releases — this adapter is
// deliberately one file so an API change costs one file (debt containment).
import type { Plugin } from "@opencode-ai/plugin";

const ROOT = process.env.LLMWIKI_ROOT ?? ""; // absolute path of the llmwiki clone

export const LlmwikiPlugin: Plugin = async ({ $, directory }) => {
  // ENROLLMENT GATE — before any callback exists.
  //
  // The plugin is installed globally, so it loads in every OpenCode project on the machine. A
  // disabled project must not merely produce no output: it must have no `chat.message` callback
  // at all, because that callback's whole job is to hold the user's prompt text in memory. The
  // check is a silent `llmwiki enabled <dir>` whose exit code is the entire answer (no stdout to
  // leak into the session). Callback boundaries re-check the same predicate so `llmwiki disable`
  // revokes an already-running plugin without waiting for OpenCode to restart.
  const enabledNow = async (): Promise<boolean> => {
    if (!ROOT) return false;
    try {
      const r = await $`bun ${ROOT}/src/cli.ts enabled ${directory}`.quiet().nothrow();
      return r.exitCode === 0;
    } catch {
      return false; // fail closed: an unknown answer is not consent
    }
  };
  const enabled = await enabledNow();
  if (!enabled) return {};

  // OpenCode rebuilds the system array PER REQUEST (it does not accumulate like chat
  // history), so the cold-start blob must be pushed on every main request — a once-per-
  // session gate starves all requests after the first (and the first transform may even
  // be a hidden agent like `title`). Fetch once per process, then reuse the cached blob.
  let coldCache: string | null = null;
  // A global plugin process can serve more than one active session. Keep prompt state
  // session-scoped so a hidden/title request or parallel chat never consumes another
  // session's user text.
  const lastPrompt = new Map<string, string>();
  const revoke = (): void => {
    coldCache = null;
    lastPrompt.clear();
  };

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
    // /wiki-* commands need to know WHICH session they are closing out, and OpenCode's command
    // templates substitute only $ARGUMENTS/$1… — there is no session-id variable. This hook is
    // the one surface that receives the real sessionID at command time, so it (a) materializes
    // and enqueues THIS session via `save-current` (manual save — works below the daemon's
    // 50-line threshold), and (b) injects the id into the prompt so the skill can select the
    // exact transcript instead of ever guessing by recency.
    "command.execute.before": async (input: any, output: { parts: any[] }) => {
      try {
        if (!/^wiki-/.test(String(input?.command ?? ""))) return;
        if (!(await enabledNow())) {
          revoke();
          return;
        }
        const sid = String(input?.sessionID ?? "");
        if (!sid) return;
        await run(["save-current", directory, "--session", sid]); // best-effort; the skill re-runs it
        output.parts?.push({
          type: "text",
          text:
            `[llmwiki] current OpenCode session id: ${sid} — for the close-out selection step run: ` +
            `llmwiki save-current ${directory} --session ${sid}`,
        });
      } catch {
        /* never break a command */
      }
    },
    // capture the user's prompt text as it is sent (used by the per-turn query below)
    "chat.message": async (input: any, output) => {
      try {
        if (!(await enabledNow())) {
          revoke();
          return;
        }
        const sid = String(input?.sessionID ?? "");
        const texts = (output.parts ?? [])
          .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
          .filter(Boolean);
        if (texts.length) lastPrompt.set(sid, texts.join("\n"));
      } catch {
        /* observation only */
      }
    },
    "experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      if (!(await enabledNow())) {
        revoke();
        return;
      }
      const sid = String(input?.sessionID ?? "");
      // (a) cold-start blob — every request (system arrays are rebuilt per request);
      // engine output cached per process, in-array guard keeps it idempotent.
      if (coldCache === null) coldCache = await run(["context", directory]);
      if (coldCache && !output.system.some((s) => s.includes("[llmwiki]"))) {
        output.system.push(coldCache);
      }
      // (b) per-turn pointers — engine is precision-first and usually silent
      const prompt = lastPrompt.get(sid) ?? "";
      if (prompt) {
        const turn = await run(["turn-context", directory, "--prompt", prompt, "--session", sid]);
        if (turn) output.system.push(turn);
        lastPrompt.delete(sid);
      }
    },
  };
};

export default LlmwikiPlugin;
