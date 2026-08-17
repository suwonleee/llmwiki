#!/bin/bash
# llmwiki UserPromptSubmit turn-context injection (the per-turn read loop).
#
# Thin Claude-Code adapter: the logic lives in the engine (src/engine/turncontext.ts), so it is
# HARNESS-NEUTRAL. Claude Code pipes the hook payload JSON ({prompt, session_id, cwd, ...}) on
# stdin; we forward it untouched — the lightweight hook entrypoint reads
# prompt/session/cwd from it. Codex's native UserPromptSubmit hook can run this same
# script (payload shape is compatible); other harnesses call the CLI with --prompt.
#
# Output contract: the engine emits the JSON envelope BOTH harnesses DECLARE
# ({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}). Bare text
# also works today (both accept it as a fallback); the envelope is the declared contract rather than
# the undeclared one. The engine prints AT MOST a few pointer lines and is SILENT when unconfident,
# and silence stays zero bytes (never an empty envelope) — so most turns inject nothing.
# Fail-safe: any error → silent exit 0 (never block or pollute a turn).
set +e

# Engine subprocesses (autoupdate/review/ingest shell out to `claude -p` via src/engine/claude.ts)
# set this marker so the hook does NOT self-inject turn-context into the WRITE/VERIFY prompt —
# that injection pollutes the generative passes. Mirrors sessionstart-inject.sh; real interactive
# sessions never set it. (Exit before reading stdin — an unconsumed payload pipe is harmless.)
[ -n "$LLMWIKI_ENGINE_SUBPROCESS" ] && exit 0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}"
BUN="$(command -v bun)"

# Plugin-context guard (mirrors sessionstart-inject.sh): when the FULL install is also wired, its
# own hook already injects this turn — a second copy from the plugin cache would double every
# pointer block. Both harnesses set CLAUDE_PLUGIN_ROOT for plugin hooks, so both wiring files are
# checked. Silent here; the once-per-session notice (bun missing) belongs to SessionStart.
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  for W in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "${CODEX_HOME:-$HOME/.codex}/hooks.json"; do
    grep -q 'hooks/userpromptsubmit-inject.sh' "$W" 2>/dev/null && exit 0
  done
fi

[ -n "$BUN" ] && "$BUN" "$ROOT/src/hook-cli.ts" turn-context-hook "$PROJ" 2>/dev/null
exit 0
