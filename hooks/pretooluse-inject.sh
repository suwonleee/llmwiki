#!/bin/bash
# llmwiki PreToolUse edit-time rule injection (matcher: Edit|Write|MultiEdit|NotebookEdit).
#
# Thin Claude-Code adapter: the logic lives in the engine (src/engine/edit-rules.ts). Claude Code
# pipes the hook payload JSON ({session_id, cwd, tool_name, tool_input.file_path, agent_id?, ...})
# on stdin; we forward it untouched to the lightweight hook entrypoint.
#
# Output contract: SILENT (zero bytes) unless a human-confirmed rule whose `applies_to` globs match
# the target file has not yet been shown in this session. Then, by LLMWIKI_EDIT_RULES:
#   gate (default) → {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
#                     "permissionDecisionReason":"<rules> … retry the same edit."}} — once per rule
#                     and per path, so the retry passes
#   advise         → {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<rules>"}}
#   off            → nothing
# Fail-safe: any error → silent exit 0, which lets the edit run.
set +e

# Engine subprocesses (`claude -p` WRITE/VERIFY passes, src/engine/claude.ts) must not be steered
# by the project's rules. Mirrors the other two adapters.
[ -n "$LLMWIKI_ENGINE_SUBPROCESS" ] && exit 0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}"
BUN="$(command -v bun)"

# Plugin-context guard (mirrors userpromptsubmit-inject.sh): when the FULL install is also wired,
# its own hook already serves this edit — a second copy would gate it twice.
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  for W in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "${CODEX_HOME:-$HOME/.codex}/hooks.json"; do
    grep -q 'hooks/pretooluse-inject.sh' "$W" 2>/dev/null && exit 0
  done
fi

[ -n "$BUN" ] && "$BUN" "$ROOT/src/hook-cli.ts" edit-context-hook "$PROJ" 2>/dev/null
exit 0
