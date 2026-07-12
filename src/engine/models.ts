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
// Defaults are the current top Claude models per tier; bump them (or env-override)
// as newer models launch.
export const MODEL_HEAVY = process.env.LLMWIKI_MODEL_HEAVY?.trim() || "claude-opus-4-8";
export const MODEL_LIGHT = process.env.LLMWIKI_MODEL_LIGHT?.trim() || "claude-sonnet-5";
