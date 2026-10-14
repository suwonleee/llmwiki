// llmwiki OpenCode plugin — thin adapter over the harness-neutral engine.
//
// OpenCode has no declarative shell hooks; the supported surface is a JS plugin. This one
// mirrors the two Claude/Codex hooks:
//   session start → inject `llmwiki context` output once per session
//   per user turn → inject `llmwiki turn-context` pointer lines (silent on most turns)
//
// ONE FILE, BOTH PLUGIN APIS. The default export carries `server` (OpenCode 1.x) and `setup`
// (OpenCode 2), and each version reads only its own key — measured on 1.19.0 and 2.0.27, both
// loading this file from `~/.config/opencode/plugin/`. 2.0 keeps the binary name, the config
// folder and the commands/ directory, so the installer, doctor and /wiki-* commands are shared;
// only the hook surface differs:
//   1.x  chat.message                         → 2.x session.hook("prompt")   (mutable prompt)
//   1.x  experimental.chat.system.transform   → 2.x session.hook("context")  (event.system parts)
//   1.x  command.execute.before               → 2.x the prompt hook sees a command's EXPANDED body
//        (no command name), so a /wiki-* body is recognized by the managed marker every installed
//        command template carries.
// 2.x has no `$` shell helper; child processes go through Bun.spawn (the host is Bun in both
// versions) and are killed when OpenCode unloads the plugin.
//
// Install: `./setup.sh --harness opencode` writes a global, clone-pinned copy to
// `~/.config/opencode/plugin/` (or `$XDG_CONFIG_HOME/opencode/plugin/`). LLMWIKI_ROOT must be
// set (env or the installer's pinned fallback below) or the plugin silently no-ops.
// This adapter is deliberately one file so an API change costs one file (debt containment).

const ROOT = process.env.LLMWIKI_ROOT ?? ""; // absolute path of the llmwiki clone

// Every installed /wiki-* command template opens with this comment (wire-opencode.ts).
const COMMAND_MARK = "<!-- llmwiki-opencode-managed ";
// A hung engine call must not hold an OpenCode 2 turn forever; 1.x keeps its original behavior.
const SPAWN_TIMEOUT_MS = 60_000;
const MAX_COLD_SESSIONS = 32;

type Exec = (script: "cli" | "hook-cli", args: string[]) => Promise<{ exitCode: number; text: string }>;

function createCore(exec: Exec, directory: string) {
  // OpenCode rebuilds the system array PER REQUEST (it does not accumulate like chat
  // history), so the cold-start blob must be pushed on every main request — a once-per-
  // session gate starves all requests after the first (and the first transform may even
  // be a hidden agent like `title`). Fetch once per SESSION, then reuse the cached blob. A process-
  // global string made a new session inherit stale context from an older one in the same process.
  const coldCache = new Map<string, string>();
  // A global plugin process can serve more than one active session. Keep prompt state
  // session-scoped so a hidden/title request or parallel chat never consumes another
  // session's user text.
  const lastPrompt = new Map<string, string>();
  const revoke = (): void => {
    coldCache.clear();
    lastPrompt.clear();
  };

  // ENROLLMENT GATE. The check is a silent `llmwiki enabled <dir>` whose exit code is the entire
  // answer (no stdout to leak into the session).
  const enabledNow = async (): Promise<boolean> => {
    if (!ROOT) return false;
    try {
      return (await exec("hook-cli", ["enabled", directory])).exitCode === 0;
    } catch {
      return false; // fail closed: an unknown answer is not consent
    }
  };

  const run = async (args: string[]): Promise<string> => {
    if (!ROOT) return "";
    try {
      const r = await exec("cli", args);
      return r.exitCode === 0 ? r.text.trim() : "";
    } catch {
      return ""; // fail-safe: never break a turn
    }
  };

  const runContext = async (
    prompt: string,
    session: string,
    includeCold: boolean,
  ): Promise<{ cold: string; turn: string; notice: string } | null> => {
    if (!ROOT) return null;
    // Older Bun spawn implementations drop empty argv entries. Omit absent values so the
    // hook cannot read the next flag as a prompt (or invent a session id).
    const args = ["opencode-context", directory];
    if (prompt) args.push("--prompt", prompt);
    if (session) args.push("--session", session);
    if (includeCold) args.push("--include-cold");
    try {
      const r = await exec("hook-cli", args);
      if (r.exitCode !== 0) return null;
      const parsed = JSON.parse(r.text) as { cold?: unknown; turn?: unknown; notice?: unknown };
      return {
        cold: typeof parsed.cold === "string" ? parsed.cold : "",
        turn: typeof parsed.turn === "string" ? parsed.turn : "",
        notice: typeof parsed.notice === "string" ? parsed.notice : "",
      };
    } catch {
      return null;
    }
  };

  return {
    enabledNow,
    revoke,
    rememberPrompt(session: string, text: string): void {
      if (text) lastPrompt.set(session, text);
    },

    // /wiki-* commands need to know WHICH session they are closing out, and OpenCode's command
    // templates have no session-id variable. Materialize and enqueue THIS session via
    // `save-current` (manual save — works below the daemon's 50-line threshold) and return the line
    // that hands the exact id to the skill, so it never guesses by recency.
    async closeOutLine(session: string): Promise<string> {
      await run(["save-current", directory, "--session", session]); // best-effort; the skill re-runs it
      return (
        `[llmwiki] current OpenCode session id: ${session} — for the close-out selection step run: ` +
        `llmwiki save-current ${directory} --session ${session}`
      );
    },

    // System strings for one model request, or null when the project is no longer enrolled.
    async systemFor(
      session: string,
      existing: readonly string[],
    ): Promise<{ add: string[]; notice: string; first: boolean } | null> {
      const cacheKey = session || "__unknown__";
      const prompt = lastPrompt.get(session) ?? "";
      // One child process owns the callback-boundary enrollment recheck plus cold/turn retrieval.
      const first = !coldCache.has(cacheKey);
      const result = await runContext(prompt, session, first);
      if (result === null) {
        revoke();
        return null;
      }
      if (first) {
        coldCache.set(cacheKey, result.cold);
        if (coldCache.size > MAX_COLD_SESSIONS) coldCache.delete(coldCache.keys().next().value!);
      }
      const add: string[] = [];
      // (a) cold-start blob — every request (system arrays are rebuilt per request);
      // engine output cached per session, in-array guard keeps it idempotent.
      const cold = coldCache.get(cacheKey) ?? "";
      if (cold && !existing.some((s) => s.includes("[llmwiki]"))) add.push(cold);
      // (b) per-turn pointers — engine is precision-first and usually silent
      if (result.turn) add.push(result.turn);
      lastPrompt.delete(session);
      return { add, notice: result.notice, first };
    },
  };
}

// ---- OpenCode 1.x -------------------------------------------------------------------------

async function server({ $, directory, client }: any) {
  const core = createCore(async (script, args) => {
    const r = await $`bun ${ROOT}/src/${script}.ts ${args}`.quiet().nothrow();
    return { exitCode: r.exitCode, text: r.text() };
  }, directory);

  // The plugin is installed globally, so it loads in every OpenCode project on the machine. A
  // disabled project must not merely produce no output: it must have no `chat.message` callback
  // at all, because that callback's whole job is to hold the user's prompt text in memory.
  // Callback boundaries re-check the same predicate so `llmwiki disable` revokes an already-running
  // plugin without waiting for OpenCode to restart.
  if (!(await core.enabledNow())) return {};

  // The person-facing update line, shown ONCE per session as a TUI toast. OpenCode has no
  // systemMessage channel, but its SDK client can raise a toast; `opencode run` has no TUI and the
  // call simply fails, which is the same as not showing it. Never lets a toast break a request.
  const noticed = new Set<string>();
  const toast = async (session: string, message: string): Promise<void> => {
    if (!message || noticed.has(session)) return;
    noticed.add(session);
    try {
      await client?.tui?.showToast?.({
        body: { title: "llmwiki", message, variant: "info", duration: 10_000 },
      });
    } catch {
      /* headless, or an SDK without a TUI — silence is correct */
    }
  };

  return {
    // The one 1.x surface that receives the real sessionID at command time.
    "command.execute.before": async (input: any, output: { parts: any[] }) => {
      try {
        if (!/^wiki-/.test(String(input?.command ?? ""))) return;
        if (!(await core.enabledNow())) {
          core.revoke();
          return;
        }
        const sid = String(input?.sessionID ?? "");
        if (!sid) return;
        output.parts?.push({ type: "text", text: await core.closeOutLine(sid) });
      } catch {
        /* never break a command */
      }
    },
    // capture the user's prompt text as it is sent (used by the per-turn query below)
    "chat.message": async (input: any, output: any) => {
      try {
        if (!(await core.enabledNow())) {
          core.revoke();
          return;
        }
        const texts = (output.parts ?? [])
          .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
          .filter(Boolean);
        if (texts.length) core.rememberPrompt(String(input?.sessionID ?? ""), texts.join("\n"));
      } catch {
        /* observation only */
      }
    },
    "experimental.chat.system.transform": async (input: any, output: { system: string[] }) => {
      const sid = String(input?.sessionID ?? "");
      const result = await core.systemFor(sid, output.system);
      if (result === null) return;
      if (result.first) void toast(sid || "__unknown__", result.notice);
      output.system.push(...result.add);
    },
  };
}

// ---- OpenCode 2 ---------------------------------------------------------------------------

async function setup(ctx: any) {
  const directory = String(ctx?.location?.directory ?? "");
  const live = new Set<{ kill(): void }>();
  const core = createCore(async (script, args) => {
    const proc = Bun.spawn(["bun", `${ROOT}/src/${script}.ts`, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    live.add(proc);
    // Killing the child does not close stdout while a grandchild still holds the pipe, so the read
    // itself races the clock; a timed-out call fails closed like any other non-zero exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SPAWN_TIMEOUT_MS);
    });
    try {
      const text = await Promise.race([new Response(proc.stdout).text(), expired]);
      if (text === null) {
        proc.kill();
        return { exitCode: 1, text: "" };
      }
      return { exitCode: await proc.exited, text };
    } finally {
      clearTimeout(timer);
      live.delete(proc);
    }
  }, directory);

  // Same gate as 1.x: an unenrolled project registers no hook at all, so no callback ever holds
  // its prompt text.
  if (!(await core.enabledNow())) return;

  const registrations: { dispose(): Promise<void> }[] = [];
  registrations.push(await ctx.session.hook("prompt", async (event: any) => {
    try {
      if (!(await core.enabledNow())) {
        core.revoke();
        return;
      }
      const sid = String(event?.sessionID ?? "");
      const text = String(event?.prompt?.text ?? "");
      if (text.trimStart().startsWith(COMMAND_MARK)) {
        // A /wiki-* body is a template, not the person's words — hand over the session id instead
        // of using it as a turn-context query.
        if (sid) event.prompt.text = `${text}\n\n${await core.closeOutLine(sid)}`;
        return;
      }
      core.rememberPrompt(sid, text);
    } catch {
      /* never break a prompt */
    }
  }));

  // Runs before each agent-loop model call only; title/compaction requests have their own hooks.
  registrations.push(await ctx.session.hook("context", async (event: any) => {
    try {
      const system: any[] = Array.isArray(event?.system) ? event.system : [];
      const existing = system.map((p) => (typeof p?.text === "string" ? p.text : ""));
      const result = await core.systemFor(String(event?.sessionID ?? ""), existing);
      if (result === null) return;
      for (const text of result.add) system.push({ type: "text", text });
    } catch {
      /* never break a request */
    }
  }));

  return async () => {
    for (const proc of live) proc.kill();
    core.revoke();
    await Promise.allSettled(registrations.map((r) => r.dispose()));
  };
}

export default { id: "llmwiki", server, setup };
