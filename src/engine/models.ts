// Model tier configuration for the generative passes (autoupdate/review).
//
// Two tiers, by workload weight — override either via env so the engine tracks the
// latest top model per tier WITHOUT code edits, and so non-Anthropic / non-Claude
// setups can point each tier at their own model:
//
//   HEAVY  — reasoning-grade: adversarial VERIFY gate + semantic review (judgment).
//   LIGHT  — drafting-grade: the WRITE pass (cheap, high-volume).
//
//   LLMWIKI_MODEL_HEAVY=…   LLMWIKI_MODEL_LIGHT=…
//
// Resolution order (mirrors `lang`): env > llmwiki.config.toml [models] > built-in default.
// Env is a per-session override and always wins; the toml `[models]` block lets a team
// pin per-tier models in-repo; the DEFAULT_* constants are the last-resort built-ins.
// Config-less callers use MODEL_LIGHT/MODEL_HEAVY (env-or-builtin); config-aware callers
// go through resolveModels(toml) so the toml tier can participate.
export const DEFAULT_LIGHT = "claude-sonnet-5";
export const DEFAULT_HEAVY = "claude-opus-4-8";

export const MODEL_HEAVY = process.env.LLMWIKI_MODEL_HEAVY?.trim() || DEFAULT_HEAVY;
export const MODEL_LIGHT = process.env.LLMWIKI_MODEL_LIGHT?.trim() || DEFAULT_LIGHT;

// Config-aware tier resolution: env > toml [models] > builtin default (per tier).
export function resolveModels(toml?: { light?: string; heavy?: string }): { light: string; heavy: string } {
  return {
    light: process.env.LLMWIKI_MODEL_LIGHT?.trim() || toml?.light?.trim() || DEFAULT_LIGHT,
    heavy: process.env.LLMWIKI_MODEL_HEAVY?.trim() || toml?.heavy?.trim() || DEFAULT_HEAVY,
  };
}
