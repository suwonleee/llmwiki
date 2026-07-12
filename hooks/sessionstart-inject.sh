#!/bin/bash
# llmwiki SessionStart read-injection (the "read" loop of the compounding cycle).
#
# Thin Claude-Code adapter: the cold-start logic now lives in the engine
# (src/engine/context.ts → `llmwiki context <repo>`) so it is HARNESS-NEUTRAL — any
# harness can inject the same blob (Codex via AGENTS.md, manual paste, etc.). This file
# is only the Claude Code SessionStart wiring.
#
# Capture itself is handled by the env-agnostic daemon, so the loop survives without this
# hook. Fail-safe: any error → silent exit 0 (never break a session).
set +e

# Engine subprocesses (autoupdate/review/ingest shell out to `claude -p` via src/engine/claude.ts)
# set this marker so the hook does NOT self-inject the wiki context into the WRITE/VERIFY prompt —
# that injection pollutes the generative passes. Real interactive sessions never set it.
[ -n "$LLMWIKI_ENGINE_SUBPROCESS" ] && exit 0

# ROOT = this clone, resolved from the hook script's own location (path/name-agnostic).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PROJ="${CLAUDE_PROJECT_DIR:-$PWD}"
BUN="$(command -v bun)"

[ -n "$BUN" ] && "$BUN" "$ROOT/src/cli.ts" context "$PROJ" 2>/dev/null
exit 0
