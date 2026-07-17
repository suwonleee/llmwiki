#!/bin/bash
# setup.sh — one-command onboarding for the llmwiki engine.
#
# Clone this repo ANYWHERE under ANY name, then run `./setup.sh`. Every wiring
# artifact (launchd daemon, SessionStart read-injection hook, /wiki-* commands) is
# derived from this clone's own location — no fixed ~/llmwiki path required.
#
#   git clone <url> myengine && cd myengine && ./setup.sh
#
# What it does (idempotent — safe to re-run after moving the clone or an OMC update):
#   1) doctor   — core file sanity
#   2) install  — launchd capture daemon (macOS)            → com.llmwiki.daemon
#   3) wire      — SessionStart hook + /wiki-* commands in every ~/.claude* profile
#   4) init      — build this repo's own wiki index (dogfood)
#   5) doctor   — confirm healthy
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PY="$(command -v bun || true)"
[ -z "$PY" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh"; exit 1; }

# claude CLI is OPTIONAL: capture/read/`/wiki-*` work without it, but the generative
# passes (autoupdate·synthesize·review) shell out to `claude -p`. Warn, never fail.
if ! command -v claude >/dev/null 2>&1; then
    echo "⚠️ 'claude' CLI not found on PATH."
    echo "   Capture, read-injection, and the /wiki-* commands work without it."
    echo "   Only the generative passes (autoupdate·synthesize·review) need the claude CLI."
    echo "   Install: https://docs.claude.com/en/docs/claude-code/setup"
    echo
fi

echo "=== llmwiki setup (engine = $ROOT) ==="
echo

echo "--- 1) doctor (pre) ---"
"$PY" "$ROOT/src/cli.ts" doctor || true   # pre-setup: daemon/hook not wired yet → non-zero is expected
echo

echo "--- 2) capture daemon (macOS launchd · Linux systemd/cron) ---"
bash "$ROOT/daemon/install.sh"   # auto-detects the platform; see daemon/README.md
echo

echo "--- 3) wire: SessionStart hook + /wiki-* commands ---"
"$PY" "$ROOT/src/daemon/wire.ts"
echo

echo "--- 4) init: index this repo's own wiki ---"
"$PY" "$ROOT/src/cli.ts" init "$ROOT"
echo

echo "--- 5) doctor (post) ---"
"$PY" "$ROOT/src/cli.ts" doctor || true
echo
echo "=== done. ==="
echo "  • To use it in another project:  $PY $ROOT/src/cli.ts init <repo>"
echo "  • From the next session: cold-start injection + /wiki-fast·/wiki-deep·/wiki-ask"
echo "  • Undo:  bash $ROOT/daemon/install.sh --uninstall  ·  $PY $ROOT/src/daemon/wire.ts --revert"
