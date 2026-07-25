// Names previously installed by llmwiki.
//
// These are cleanup-only migration records: never expose them as current commands or
// derive them from the current command list. Re-wiring uses them to remove stale managed
// surfaces left by older releases.
export const RETIRED_CLAUDE_COMMANDS = [
  "wiki-update.md",
  "wiki-sync.md",
  "wiki-fast.md",
] as const;

export const RETIRED_CODEX_SKILLS = [
  "llmwiki-fast",
  "llmwiki-ask",
  "llmwiki-deep",
  "llmwiki-quiz",
  "wiki-fast",
] as const;

export const RETIRED_OPENCODE_COMMANDS = ["wiki-fast"] as const;
