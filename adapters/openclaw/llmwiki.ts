// llmwiki OpenClaw plugin — thin adapter over the harness-neutral engine.
//
// OpenClaw has no declarative shell hooks the way Claude Code and Codex do; its extension surface
// is an in-process TypeScript plugin registering typed hooks. This adapter mirrors the same two
// injections every other harness gets:
//   session start  → `llmwiki context <dir>`      cold-start blob, once per session
//   per user turn  → `llmwiki turn-context <dir>` pointer lines, silent on most turns
//
// WHY A SUBPROCESS AND NOT AN IMPORT. The engine is Bun-bound: `bun:sqlite` is imported by 15+
// modules (db.ts, capture.ts, observe.ts, state-dir.ts, …). OpenClaw runs on Node 22/24/25, so an
// in-process `import` cannot work and never will without a second SQLite backend. Shelling out to
// `bun` is the same thing the Claude/Codex hook scripts and the OpenCode adapter already do, so
// this adapter adds no new execution model — only new wiring.
//
// STATUS: written against OpenClaw's documented and source-verified hook contract
// (src/plugins/hook-types.ts: PluginHookBeforePromptBuildEvent/Result, PluginHookSessionStartEvent,
// PluginHookAgentContext). NOT yet verified against a live Gateway — unlike the OpenCode adapter,
// which was measured end-to-end. Treat the first live run as the verification step.
//
// Install: see adapters/openclaw/README.md. `LLMWIKI_ROOT` must point at the clone, or `llmwiki`
// must be on PATH; with neither, every hook here no-ops silently.
//
// Like adapters/opencode/llmwiki.ts, this file imports its host's SDK and is therefore NOT part of
// this repo's typecheck (tsconfig includes only src/ and tests/) — `openclaw` is a peer dependency
// of the published package, not a dependency of the engine.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const run_ = promisify(execFile);

const ROOT = process.env.LLMWIKI_ROOT ?? ""; // absolute path of the llmwiki clone

/**
 * How to spell "run the engine" on this machine.
 *
 * Same resolution order the skills use: an explicit clone root first, then the launcher on PATH
 * (`~/.local/bin/llmwiki` from setup.sh, or the npm bin). Resolved once per process — a plugin
 * that re-derived this per turn would pay a spawn just to decide how to spawn.
 */
function engineCommand(): { cmd: string; prefix: string[] } | null {
  if (ROOT) return { cmd: "bun", prefix: [`${ROOT}/src/cli.ts`] };
  return { cmd: "llmwiki", prefix: [] };
}

/**
 * Run the engine and return trimmed stdout, or "" for every failure mode.
 *
 * Fail-safe by construction: a missing engine, a missing Bun, a non-zero exit and a timeout all
 * collapse to the same empty string, because none of them is a reason to damage a user's turn.
 * The timeout matters more here than in the shell hooks — OpenClaw runs modifying hooks
 * sequentially, so a hung engine would stall the reply rather than just lose an injection.
 */
async function engine(args: string[], timeoutMs: number): Promise<string> {
  const resolved = engineCommand();
  if (!resolved) return "";
  try {
    const { stdout } = await run_(resolved.cmd, [...resolved.prefix, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024, // a large cold start is ~20KB; the default 1MB is ample, this is headroom
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Exit-code-only enrollment probe. Fails CLOSED: an unknown answer is not consent. */
async function enrolled(dir: string): Promise<boolean> {
  const resolved = engineCommand();
  if (!resolved || !dir) return false;
  try {
    await run_(resolved.cmd, [...resolved.prefix, "enabled", dir], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which directory is "the project"?
 *
 * OpenClaw's agent context carries `workspaceDir` (the agent's home and default cwd) and
 * `activeProjectKeys` (normalized git origins used for ranking, NOT filesystem paths). Only the
 * first is a path we can hand the engine. An agent whose workspace is not an enrolled repository
 * therefore gets exactly what an unenrolled repository gets anywhere else: zero bytes.
 */
function projectDir(ctx: { workspaceDir?: string }): string {
  return ctx.workspaceDir ?? process.cwd();
}

export default definePluginEntry({
  id: "llmwiki",
  name: "llmwiki",
  register(api: {
    on: (
      name: string,
      handler: (event: any, ctx: any) => unknown,
      opts?: { priority?: number },
    ) => void;
  }) {
    // Cold-start text is constant for the life of a session, so it is fetched once and reused.
    // Keyed by session id because one Gateway process serves many concurrent sessions.
    const cold = new Map<string, string>();

    // Observation only — OpenClaw hands us a fresh session id here, and a resumed session gets a
    // new one, so this is simply where a stale entry is dropped rather than left to accumulate in
    // a long-lived Gateway process.
    api.on("session_start", (event: { sessionId?: string }) => {
      if (event?.sessionId) cold.delete(event.sessionId);
    });
    api.on("session_end", (event: { sessionId?: string }) => {
      if (event?.sessionId) cold.delete(event.sessionId);
    });

    api.on(
      "before_prompt_build",
      async (event: { prompt?: string }, ctx: { sessionId?: string; workspaceDir?: string }) => {
        const dir = projectDir(ctx);
        if (!(await enrolled(dir))) return; // unenrolled → contribute nothing at all

        const sid = ctx.sessionId ?? "";
        const out: { prependSystemContext?: string; appendContext?: string } = {};

        // (a) Cold start. `prependSystemContext` rather than `prependContext`: OpenClaw documents
        // the system variants as the cacheable ones, and this blob is byte-identical for every
        // turn of a session — exactly the shape provider prompt caching wants. `prependContext`
        // would re-bill it per turn.
        if (!cold.has(sid)) cold.set(sid, await engine(["context", dir], 20_000));
        const blob = cold.get(sid) ?? "";
        if (blob) out.prependSystemContext = blob;

        // (b) Per-turn pointers. The engine is precision-first and stays silent on most turns, so
        // an empty result is the common case and must not become an empty context entry.
        const prompt = String(event?.prompt ?? "");
        if (prompt) {
          const args = ["turn-context", dir, "--prompt", prompt];
          if (sid) args.push("--session", sid);
          const turn = await engine(args, 10_000);
          if (turn) out.appendContext = turn;
        }

        return Object.keys(out).length ? out : undefined;
      },
      { priority: 50 },
    );
  },
});
