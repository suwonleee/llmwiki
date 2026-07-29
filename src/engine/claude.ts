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
//   There is NO default. Unset or empty → no subprocess is launched at all, and callers get a
//   deterministic "unavailable" marker. Generative passes are strictly opt-in because they are
//   the only thing in this engine that sends your session content to another program.
//
//   The value we RECOMMEND for Claude Code keeps the tool restrictions the old built-in default
//   carried:
//
//     claude -p {prompt} --model {model} --disallowedTools Write Edit NotebookEdit Bash
//
//   Two reasons, and both still apply now that the command is opt-in. Correctness: `claude -p` is
//   agentic, so asked to "write a page" it may reach for the Write tool instead of printing the
//   markdown the caller is waiting for. Safety: the prompt is built from transcript and page text,
//   which is exactly the material a prompt injection rides in on — a child that cannot write files
//   or run commands cannot act on one. Only real tool names: an unknown one is rejected at startup
//   ("matches no known tool"), which is how `MultiEdit` — carried over from the old built-in default —
//   was caught in a live run.
//
// Errors are surfaced as a distinct `__ERROR__`-prefixed string (callers check the prefix),
// never thrown. The generative passes are OPTIONAL: capture/read/manual condense work without
// any LLM CLI.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenSecrets } from "./screen.ts";
import { envValueOutsideRepoFiles } from "./env-policy.ts";

const TIMEOUT_MS = 300_000; // 300s

/** Returned instead of launching anything when no provider command is configured. */
export const UNAVAILABLE = "__UNAVAILABLE__";
export const LLM_CMD_ENV = "LLMWIKI_LLM_CMD";

/**
 * The configured argv template, or null when generative passes are OFF.
 *
 * There is deliberately NO default command. Shipping `claude -p …` as the fallback meant that
 * installing llmwiki silently enabled sending transcript extracts to a provider — a network
 * transfer nobody chose, discoverable only by reading the source. Setting this variable in the
 * machine's environment IS the opt-in, made once, out of band from any repository.
 */
export function llmTemplate(): string[] | null {
  const raw = envValueOutsideRepoFiles(LLM_CMD_ENV)?.trim();
  if (!raw) return null;
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

/**
 * Screen every transcript- or page-derived block before it becomes part of a prompt.
 *
 * Returns null when a required block screened down to nothing (`gutted`): the caller must then
 * launch NO subprocess. Sending a mostly-«redacted» block proves nothing to the model and still
 * ships whatever survived redaction to a third party. Only screened text is ever returned — the
 * raw block never leaves this function.
 */
export function screenOutbound(blocks: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(blocks)) {
    const screened = screenSecrets(value);
    if (screened.gutted) return null;
    out[key] = screened.text;
  }
  return out;
}

// A configured command may be a bare name to look up on PATH, or an absolute/relative path to a
// wrapper script (the common way to pin flags). Bun.which only answers the first question.
function resolveBin(bin: string): string | null {
  if (bin.includes("/")) {
    try {
      return statSync(bin).isFile() ? bin : null;
    } catch {
      return null;
    }
  }
  return Bun.which(bin);
}

/** True when a generative pass can run at all on this machine. */
export function llmAvailable(): boolean {
  const tmpl = llmTemplate();
  return tmpl !== null && !!tmpl[0] && !!resolveBin(tmpl[0]!);
}

/**
 * Drop the `--model <value>` pair from an argv template.
 *
 * Used when no model could be determined: rather than substituting a guess, the flag comes out
 * entirely and the harness CLI applies its own default — which is by definition a model that
 * machine can run today. Handles both spellings, `--model {model}` (two tokens) and
 * `--model={model}` (one), and leaves a bare `{model}` token — a template that interpolates the id
 * somewhere other than a flag — as an empty string rather than mangling its neighbours.
 */
export function dropModelFlag(template: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < template.length; i++) {
    const tok = template[i]!;
    if (!tok.includes("{model}")) {
      out.push(tok);
      continue;
    }
    if (tok === "{model}") {
      // `--model {model}` — the flag is the token we already pushed; take it back out.
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.startsWith("-")) out.pop();
      continue;
    }
    if (/^-[^=]*=\{model\}$/.test(tok)) continue; // `--model={model}`
    out.push(tok.replace("{model}", "")); // interpolated elsewhere — leave the rest intact
  }
  return out;
}

export async function llm(prompt: string, model: string | null): Promise<string> {
  const tmpl = llmTemplate();
  if (tmpl === null) {
    // No command configured → no subprocess, no network, no error. The deterministic half of the
    // engine (capture, index, search, lint, manual close-out) is fully usable in this state.
    return (
      `${UNAVAILABLE} no generative command configured. Deterministic capture/index/search/lint ` +
      `are unaffected; to enable optional generative passes, set ${LLM_CMD_ENV} in your shell ` +
      `environment. For Claude Code: export ${LLM_CMD_ENV}='claude -p {prompt} --model {model} ` +
      `--disallowedTools Write Edit NotebookEdit Bash' — keep the tool restrictions; ` +
      `the prompt is built from transcript text.`
    );
  }
  const bin = tmpl[0];
  if (!bin || !resolveBin(bin)) {
    return `__ERROR__ ${LLM_CMD_ENV} names '${bin ?? ""}', which is not executable or not on PATH.`;
  }
  const usesPromptArg = tmpl.some((t) => t.includes("{prompt}"));
  const base = model === null ? dropModelFlag(tmpl) : tmpl;
  const argv = base.map((t) =>
    t.includes("{") ? t.replace("{model}", model ?? "").replace("{prompt}", prompt) : t,
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
