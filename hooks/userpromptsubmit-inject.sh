#!/bin/bash
# llmwiki UserPromptSubmit turn-context injection (the per-turn read loop).
#
# Thin Claude-Code adapter: the logic lives in the engine (src/engine/turncontext.ts →
# `llmwiki turn-context`), so it is HARNESS-NEUTRAL. Claude Code pipes the hook payload
# JSON ({prompt, session_id, cwd, ...}) on stdin; we forward it untouched — the CLI reads
# prompt/session/cwd from it. Codex's native UserPromptSubmit hook can run this same
# script (payload shape is compatible); other harnesses call the CLI with --prompt.
#
# Output contract: plain stdout on exit 0 is added as context. The engine prints AT MOST
# a few pointer lines and is SILENT when unconfident — so most turns inject nothing.
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

[ -n "$BUN" ] && "$BUN" "$ROOT/src/cli.ts" turn-context "$PROJ" 2>/dev/null
exit 0
