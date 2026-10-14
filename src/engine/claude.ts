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
//   The value we RECOMMEND for Claude Code is RECOMMENDED_CLAUDE_CMD below: no tools at all.
//
//   Two reasons, and both still apply now that the command is opt-in. Correctness: `claude -p` is
//   agentic, so asked to "write a page" it may reach for the Write tool instead of printing the
//   markdown the caller is waiting for. Safety: the prompt is built from transcript and page text,
//   which is exactly the material a prompt injection rides in on — a child with no tools cannot act
//   on one.
//
//   It used to be a denylist (`--disallowedTools Write Edit NotebookEdit Bash`). That stopped being
//   enough when Claude Code 2.1.284/2.1.285 started `claude -p` in auto permission mode: a live
//   2.1.296 child under the denylist still loaded 197 tools and 13 MCP servers (push, delete,
//   messaging) with an auto-approving classifier in front of them, and ~41K tokens of hooks, skill
//   listings and CLAUDE.md per call. The allowlist form measured 0 tools, 0 MCP servers, ~2.8K
//   tokens: `--tools=` (one token, so the whitespace split below keeps the empty value) removes every
//   built-in, `--strict-mcp-config` drops MCP servers, `--permission-mode dontAsk` denies anything
//   left, `--safe-mode` (2.1.169+) skips CLAUDE.md/hooks/skills — which also keeps the VERIFY pass
//   independent of the operator's instructions — and `--no-session-persistence` stops each call
//   leaving a transcript that capture would then sweep.
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

/** The Claude Code template we recommend — see the header for why each flag is there. */
export const RECOMMENDED_CLAUDE_CMD =
  "claude -p {prompt} --model {model} --tools= --permission-mode dontAsk --strict-mcp-config " +
  "--safe-mode --no-session-persistence";

/**
 * Why a configured template that drives Claude Code is unsafe, or null when it is fine (or not
 * Claude Code at all — other CLIs have their own sandboxing vocabulary).
 *
 * Only the tool surface is judged, and it has two halves that two different flags control: `--tools`
 * limits BUILT-IN tools only, while MCP tools stay loaded unless `--strict-mcp-config` or
 * `--safe-mode` drops them (measured: `--tools=` alone still left 171 `mcp__*` tools under auto
 * mode). Since 2.1.285 `claude -p` may approve whatever is left on its own. A denylist does not
 * count — it was the old recommendation, and it is exactly the configuration this exists to catch.
 */
export function claudeCommandRisk(template: readonly string[] | null): string | null {
  // Locate claude itself, so `env X=1 claude …`, `npx @anthropic-ai/claude-code …` and Windows
  // shims are judged too; only the flags after it belong to it. The search stops at the first token
  // that is not a launcher, so `llm -m claude` is not mistaken for Claude Code.
  let at = -1;
  for (const [i, t] of (template ?? []).entries()) {
    const name = (t.split(/[\\/]/).pop() ?? t).replace(/\.(exe|cmd)$/i, "");
    if (name === "claude" || t.includes("@anthropic-ai/claude-code")) {
      at = i;
      break;
    }
    const launcher = /^(env|npx|bunx|pnpm|dlx|exec|timeout|nice|caffeinate)$/.test(name);
    if (!launcher && !/^\w+=/.test(t) && !t.startsWith("-") && !/^\d+[smhd]?$/.test(t)) break;
  }
  if (at === -1) return null;
  const args = template!.slice(at + 1);

  // `--tools` is variadic and repeatable; Claude Code applies the last occurrence (measured:
  // `--tools= --tools Bash` ran with Bash). In argv form `"--tools", "", "Read"` names Read.
  let tools: string[] | null = null;
  let swallowed: string | null = null;
  args.forEach((t, i) => {
    if (t.startsWith("--tools=")) tools = [t.slice("--tools=".length)];
    else if (t === "--tools") {
      // Claude Code takes the next token as the value even when it is a flag, so a bare `--tools`
      // before `--strict-mcp-config` silently eats it (measured: 171 MCP tools, auto mode).
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        swallowed = next ?? "";
        return;
      }
      const values: string[] = [];
      for (let j = i + 1; j < args.length && !args[j]!.startsWith("-"); j++) values.push(args[j]!);
      tools = values;
    }
  });
  if (swallowed !== null) {
    return `has a bare \`--tools\` that ${swallowed ? `swallows \`${swallowed}\` as a tool name` : "ends the command"} — write \`--tools=\``;
  }
  const named = (tools as string[] | null)?.filter((v) => v !== "") ?? [];
  if (tools === null) {
    return "runs `claude` with its full tool set (no `--tools` allowlist), and `claude -p` can auto-approve tool calls";
  }
  if (named.length) {
    return `runs \`claude\` with tools enabled (\`--tools ${named.join(" ")}\`) on transcript-derived prompts`;
  }
  if (!args.includes("--strict-mcp-config") && !args.includes("--safe-mode")) {
    return "keeps MCP tools loaded (`--tools` covers built-ins only) — add `--strict-mcp-config`";
  }
  if (args.some((t) => t === "--mcp-config" || t.startsWith("--mcp-config="))) {
    return "loads MCP servers from `--mcp-config` into a child that reads transcript-derived prompts";
  }
  return null;
}

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
    //
    // The copy-pasteable command leads and the explanation follows, not the other way round:
    // several consumers cap this reason when they surface it (the review printer at 200 chars,
    // consolidate's stored verdict at 240), and with the explanation first the cap landed exactly
    // on the command — a live run showed the operator "For Claude Code: export L". A setup hint
    // whose actionable part is the piece that gets truncated has delivered only its apology.
    return (
      `${UNAVAILABLE} no generative command set — Claude Code: ` +
      `export ${LLM_CMD_ENV}='${RECOMMENDED_CLAUDE_CMD}' ` +
      `(keep the tool restrictions; the prompt is built from transcript text). ` +
      `Deterministic capture/index/search/lint are unaffected; generative passes stay opt-in ` +
      `because they are the one thing that sends session content to another program.`
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
