// Model tier PINS for the generative passes (autoupdate/review).
//
// Two tiers, by workload weight — pin either one when you want a specific model:
//
//   HEAVY  — reasoning-grade: adversarial VERIFY gate + semantic review (judgment).
//   LIGHT  — drafting-grade: the WRITE pass (cheap, high-volume).
//
//   LLMWIKI_MODEL_HEAVY=…   LLMWIKI_MODEL_LIGHT=…
//
// Resolution order (mirrors `lang`): env > llmwiki.config.toml [models] > UNPINNED (null).
//
// There are deliberately NO built-in model ids. Shipping one made the engine a small piece of
// central management: the string ages, and when the provider retires it the pass breaks for a user
// who changed nothing — and the fix only arrives when they next pull. (The constants this file used
// to carry, `claude-sonnet-5` / `claude-opus-4-8`, had gone stale exactly that way — Opus 5 shipped
// and the engine still named 4.8.) Unpinned is the normal state: engine/session-model.ts then
// observes the model the person is actually working with, and falls back per harness only when
// nothing has been observed yet. Teams that DO want a fixed tier split still get it — that is what
// these two knobs are for. (Decision 2026-07-20.)
export const MODEL_HEAVY: string | null = process.env.LLMWIKI_MODEL_HEAVY?.trim() || null;
export const MODEL_LIGHT: string | null = process.env.LLMWIKI_MODEL_LIGHT?.trim() || null;

/** Config-aware tier pins: env > toml [models] > null (unpinned). */
export function resolveModels(toml?: { light?: string; heavy?: string }): {
  light: string | null;
  heavy: string | null;
} {
  return {
    light: process.env.LLMWIKI_MODEL_LIGHT?.trim() || toml?.light?.trim() || null,
    heavy: process.env.LLMWIKI_MODEL_HEAVY?.trim() || toml?.heavy?.trim() || null,
  };
}
