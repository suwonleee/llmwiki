// Generative LLM shell-out for the heavy passes (autoupdate WRITE/VERIFY, review).
//
// Provider/CLI-agnostic: the command is a configurable argv TEMPLATE so any agent CLI
// (claude, codex, `llm`, ollama run, …) can drive the generative passes — pair with the
// per-tier model env (models.ts) for full LLM-independence.
//
//   LLMWIKI_LLM_CMD — argv template. `{prompt}` and `{model}` are substituted as whole
//   tokens (NEVER shell-parsed). If the template has no `{prompt}`, the prompt is piped
//   to the command's stdin instead. For commands needing quoted multi-word args, pass an
//   explicit argv as a JSON array (value starting with '['), e.g. ["my-llm","--q","{prompt}"].
//
//   Default reproduces Claude Code behavior exactly:
//     claude -p {prompt} --model {model} --disallowedTools Write Edit MultiEdit NotebookEdit Bash
//
// Errors are surfaced as a distinct `__ERROR__`-prefixed string (callers check the prefix),
// never thrown. The generative passes are OPTIONAL: capture/read/manual condense work without
// any LLM CLI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TIMEOUT_MS = 300_000; // 300s

// claude -p is agentic: asked to "write a page" it may use the Write tool instead of
// printing markdown. The default disallows mutating/exec tools AND runs in a throwaway cwd.
// Keep to real tool names — bogus names make claude -p hang.
const DEFAULT_CMD =
  "claude -p {prompt} --model {model} --disallowedTools Write Edit MultiEdit NotebookEdit Bash";

/** Resolve the configured argv template into tokens (no shell parsing). */
export function llmTemplate(): string[] {
  const raw = process.env.LLMWIKI_LLM_CMD?.trim();
  if (!raw) return DEFAULT_CMD.split(" ");
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string")) return arr;
    } catch {
      /* fall through to whitespace split */
    }
  }
  return raw.split(/\s+/).filter(Boolean);
}

export async function llm(prompt: string, model: string): Promise<string> {
  const tmpl = llmTemplate();
  const bin = tmpl[0];
  if (!bin || !Bun.which(bin)) {
    return (
      `__ERROR__ LLM CLI '${bin ?? ""}' not found on PATH. autoupdate·review need it ` +
      `(or set LLMWIKI_LLM_CMD). Default needs Claude Code: https://docs.claude.com/en/docs/claude-code/setup`
    );
  }
  const usesPromptArg = tmpl.some((t) => t.includes("{prompt}"));
  const argv = tmpl.map((t) =>
    t.includes("{") ? t.replace("{model}", model).replace("{prompt}", prompt) : t,
  );
  const scratch = mkdtempSync(join(tmpdir(), "llmwiki-llm-"));
  try {
    const proc = Bun.spawn(argv, {
      cwd: scratch,
      // Mark the child so our own SessionStart hook (sessionstart-inject.sh) skips wiki-context
      // injection. Without this, `claude -p` self-injects the cold-start blob (operating rules,
      // 0_review routing) into the WRITE/VERIFY prompt and pollutes the generative passes — the
      // verifier visibly reacts with "ignore the hook's wiki routing". Rest of env is inherited.
      // Also DISABLE_OMC / OMC_SKIP_HOOKS so a co-installed OMC's magic-keyword / TRANSLATE
      // hooks don't inject into this generative child and pollute the WRITE/VERIFY prompt —
      // observed making the verifier react to "skill-routing hooks" and over-reject pages.
      env: { ...process.env, LLMWIKI_ENGINE_SUBPROCESS: "1", DISABLE_OMC: "1", OMC_SKIP_HOOKS: "1" },
      stdin: usesPromptArg ? "ignore" : new TextEncoder().encode(prompt),
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.signalCode || (proc.exitCode !== 0 && proc.exitCode !== null && !out.trim())) {
      // killed (timeout) or hard failure with no output → error marker
      return `__ERROR__ ${bin} exited (code=${proc.exitCode}, signal=${proc.signalCode})`;
    }
    return out.trim();
  } catch (e) {
    return `__ERROR__ ${e}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
