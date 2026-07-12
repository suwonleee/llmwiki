// Shared tuning budgets. L0_BUDGET is the cold-start L0 STANDARD (used by both context.ts and
// lint.ts); L0_LINT_BUDGET below is the lint-only structural-trim ceiling.
//
// L0_BUDGET is a CHARACTER budget (code units), matching current-state's own self-declared
// "~1000자" (~1,000 chars) contract. Note: for Korean content one char ≈ 3 UTF-8 bytes, so 1600
// chars ≈ 4–5 KB on disk. Since 2026-07-12 (human decision: "set it as a standard, never cut") this is a STANDARD,
// not a cap — the injection NEVER cuts an over-standard L0; it injects the page whole and appends
// a visible over-standard notice (context.ts l0OverNotice), so every session sees the overage and
// the warm close-out trims it back. Rationale: a blind cut was measured eating a pending-action
// Next bullet — loss is silent, a notice is not; discipline comes from visibility.
// Override via LLMWIKI_L0_BUDGET. Floored at 400 so a typo/hostile env can't spam the notice.
export const L0_BUDGET = Math.max(
  400,
  parseInt(process.env.LLMWIKI_L0_BUDGET ?? "1600", 10) || 1600,
);

// Soft ceiling for the `oversized-l0` LINT nag (deliberately above the standard). The injection
// already appends a per-session over-standard notice from the standard itself (context.ts), so a
// slightly-over page gets its nudge every cold start; lint piles on only when the page is
// meaningfully bloated (~25% over), prompting ONE structural trim (move detail to
// current-state-detail). Flagging at the exact standard would invite char-by-char trimming of a
// human-owned page (signal sacrificed to hit a number) — curate for signal density, not a count.
export const L0_LINT_BUDGET = Math.round(L0_BUDGET * 1.25);

// Soft ceiling for overview.md (the front page / entry point, distinct from the L0 = current-state).
// overview is NOT injected verbatim each session, but it must stay an O(tracks) entry point — not a
// per-session changelog. `overview --normalize` collapses any accumulated "Recent Updates" body to a
// single log pointer; this budget is the warning line for the remaining curated content. Char budget;
// env-overridable. Generous (curated Key Findings legitimately holds more than the L0).
export const OVERVIEW_BUDGET = Math.max(
  1000,
  parseInt(process.env.LLMWIKI_OVERVIEW_BUDGET ?? "8000", 10) || 8000,
);
