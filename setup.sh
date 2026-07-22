#!/bin/bash
# setup.sh — one-command onboarding for the llmwiki engine.
#
# Clone anywhere, then run `./setup.sh`. Paths are derived from this clone.
# Claude Code, Codex, and OpenCode wiring are independent; auto installs every detected harness.
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HARNESS="auto"
DRY_RUN=0

usage() {
    cat <<EOF
Usage: ./setup.sh [--dry-run] [--harness auto|codex|claude|opencode|all]

Options:
  --help, -h             Show this help without changing files or services.
  --dry-run              Print planned actions without changing files or services.
  --harness <name>       auto (default), codex, claude, opencode, or all.

Codex installs:
  - native SessionStart + UserPromptSubmit hooks in \$CODEX_HOME/hooks.json
  - \$wiki-save, \$wiki-deep, \$wiki-ask, \$wiki-quiz skills
  - a user-level llmwiki command in ~/.local/bin

OpenCode installs:
  - the global read-injection plugin under \$XDG_CONFIG_HOME/opencode/plugin
  - /wiki-save, /wiki-deep, /wiki-ask, /wiki-quiz commands
  - the same user-level llmwiki command
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --harness)
            [ "$#" -ge 2 ] || { echo "Missing value for --harness" >&2; usage >&2; exit 2; }
            HARNESS="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

case "$HARNESS" in
    auto|codex|claude|opencode|all) ;;
    *)
        echo "Invalid harness: $HARNESS" >&2
        usage >&2
        exit 2
        ;;
esac

BUN="$(command -v bun || true)"
[ -z "$BUN" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh"; exit 1; }
printf -v BUN_Q '%q' "$BUN"
printf -v ROOT_Q '%q' "$ROOT"

USE_CODEX=0
USE_CLAUDE=0
USE_OPENCODE=0
case "$HARNESS" in
    codex) USE_CODEX=1 ;;
    claude) USE_CLAUDE=1 ;;
    opencode) USE_OPENCODE=1 ;;
    all) USE_CODEX=1; USE_CLAUDE=1; USE_OPENCODE=1 ;;
    auto)
        command -v codex >/dev/null 2>&1 && USE_CODEX=1
        command -v claude >/dev/null 2>&1 && USE_CLAUDE=1
        command -v opencode >/dev/null 2>&1 && USE_OPENCODE=1
        ;;
esac

if [ "$USE_CODEX" -eq 1 ] && ! command -v codex >/dev/null 2>&1; then
    echo "🔴 Codex CLI not found on PATH — install Codex first, then re-run setup." >&2
    exit 1
fi
if [ "$USE_CLAUDE" -eq 1 ] && ! command -v claude >/dev/null 2>&1; then
    echo "🔴 Claude Code CLI not found on PATH — install Claude Code first, then re-run setup." >&2
    exit 1
fi
if [ "$USE_OPENCODE" -eq 1 ] && ! command -v opencode >/dev/null 2>&1; then
    echo "🔴 OpenCode CLI not found on PATH — install OpenCode first, then re-run setup." >&2
    exit 1
fi
if [ "$USE_OPENCODE" -eq 1 ]; then
    OPENCODE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llmwiki-opencode-check.XXXXXX")"
    OPENCODE_RUN_HELP="$(env -u OPENCODE_CONFIG \
        XDG_CONFIG_HOME="$OPENCODE_CHECK_DIR/config" \
        XDG_DATA_HOME="$OPENCODE_CHECK_DIR/data" \
        XDG_CACHE_HOME="$OPENCODE_CHECK_DIR/cache" \
        opencode run --help 2>/dev/null || true)"
    find "$OPENCODE_CHECK_DIR" -depth -delete
    if ! printf '%s\n' "$OPENCODE_RUN_HELP" | grep -q -- '--command'; then
        echo "🔴 this OpenCode installation does not support global custom commands." >&2
        echo "   Update OpenCode, then re-run setup." >&2
        exit 1
    fi
fi
if [ "$USE_CODEX" -eq 1 ]; then
    if ! codex --help 2>/dev/null | grep -q -- '--dangerously-bypass-hook-trust'; then
        echo "🔴 this Codex installation does not support the required lifecycle hooks." >&2
        echo "   Update Codex, then re-run setup." >&2
        exit 1
    fi
    CODEX_FEATURE_HOME="${CODEX_HOME:-${HOME:-}/.codex}"
    if [ -d "$CODEX_FEATURE_HOME" ]; then
        CODEX_HOOKS_LINE="$(codex features list 2>/dev/null | grep -E '^hooks[[:space:]]' || true)"
        if [ -n "$CODEX_HOOKS_LINE" ] && ! printf '%s\n' "$CODEX_HOOKS_LINE" | grep -Eq '[[:space:]]true$'; then
            echo "🔴 Codex lifecycle hooks are disabled. Run: codex features enable hooks" >&2
            exit 1
        fi
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "=== llmwiki setup [DRY-RUN] ==="
    echo "  engine : $ROOT"
    echo "  harness: $HARNESS (Codex=$USE_CODEX, Claude=$USE_CLAUDE, OpenCode=$USE_OPENCODE)"
    echo "  would  : run doctor (pre)"
    echo "  would  : install capture daemon"
    [ "$USE_CLAUDE" -eq 1 ] && echo "  would  : wire Claude Code hooks + /wiki-* commands"
    [ "$USE_CODEX" -eq 1 ] && "$BUN" "$ROOT/src/daemon/wire-codex.ts" --dry-run
    [ "$USE_OPENCODE" -eq 1 ] && "$BUN" "$ROOT/src/daemon/wire-opencode.ts" --dry-run
    echo "  would  : run doctor (post) and propagate failures"
    exit 0
fi

if [ "$USE_CODEX" -eq 0 ] && [ "$USE_CLAUDE" -eq 0 ] && [ "$USE_OPENCODE" -eq 0 ]; then
    echo "🔴 no supported harness detected. Install Codex, Claude Code, or OpenCode, or pass --harness explicitly."
    exit 1
fi

DOCTOR_HARNESS="all"
[ "$USE_CODEX" -eq 1 ] && [ "$USE_CLAUDE" -eq 0 ] && [ "$USE_OPENCODE" -eq 0 ] && DOCTOR_HARNESS="codex"
[ "$USE_CODEX" -eq 0 ] && [ "$USE_CLAUDE" -eq 1 ] && [ "$USE_OPENCODE" -eq 0 ] && DOCTOR_HARNESS="claude"
[ "$USE_CODEX" -eq 0 ] && [ "$USE_CLAUDE" -eq 0 ] && [ "$USE_OPENCODE" -eq 1 ] && DOCTOR_HARNESS="opencode"

if [ "$USE_CLAUDE" -eq 0 ]; then
    echo "ℹ️ Claude Code not selected. Warm Codex skills/OpenCode commands work without it; unattended generative review commands remain unavailable."
    echo
fi

echo "=== llmwiki setup (engine = $ROOT, harness = $HARNESS) ==="
echo

echo "--- 1) doctor (pre) ---"
"$BUN" "$ROOT/src/cli.ts" doctor --harness "$DOCTOR_HARNESS" || true
echo

STEP=2
if [ "$USE_CODEX" -eq 1 ]; then
    echo "--- $STEP) Codex preflight (read-only conflict/schema check) ---"
    "$BUN" "$ROOT/src/daemon/wire-codex.ts" --dry-run
    echo
    STEP=$((STEP + 1))
fi
if [ "$USE_OPENCODE" -eq 1 ]; then
    echo "--- $STEP) OpenCode preflight (read-only conflict check) ---"
    "$BUN" "$ROOT/src/daemon/wire-opencode.ts" --dry-run
    echo
    STEP=$((STEP + 1))
fi

echo "--- $STEP) capture daemon (macOS launchd · Linux systemd/cron) ---"
bash "$ROOT/daemon/install.sh"
echo
STEP=$((STEP + 1))

if [ "$USE_CLAUDE" -eq 1 ]; then
    echo "--- $STEP) Claude Code: SessionStart/UserPromptSubmit + /wiki-* ---"
    "$BUN" "$ROOT/src/daemon/wire.ts"
    echo
    STEP=$((STEP + 1))
fi

if [ "$USE_CODEX" -eq 1 ]; then
    echo "--- $STEP) Codex: native hooks + skills + CLI ---"
    "$BUN" "$ROOT/src/daemon/wire-codex.ts"
    echo
    STEP=$((STEP + 1))
fi

if [ "$USE_OPENCODE" -eq 1 ]; then
    echo "--- $STEP) OpenCode: global plugin + /wiki-* commands + CLI ---"
    "$BUN" "$ROOT/src/daemon/wire-opencode.ts"
    echo
    STEP=$((STEP + 1))
fi

echo "--- $STEP) doctor (post) ---"
POST=0
"$BUN" "$ROOT/src/cli.ts" doctor --harness "$DOCTOR_HARNESS" || POST=$?
echo

if [ "$POST" -ne 0 ]; then
    echo "=== setup incomplete ==="
    echo "  doctor still reports required issues; setup exits $POST. Fix them and re-run ./setup.sh."
    exit "$POST"
fi

echo "=== setup installed. ==="
echo "  • Initialize a project: llmwiki init <repo>"
if [ "$USE_CODEX" -eq 1 ]; then
    echo "  • One-time Codex activation: start Codex, open /hooks, trust both llmwiki hooks."
    echo "  • Then work in a project and close the session with: \$wiki-save"
fi
if [ "$USE_CLAUDE" -eq 1 ]; then
    echo "  • Claude Code close-out: /wiki-save"
fi
if [ "$USE_OPENCODE" -eq 1 ]; then
    echo "  • OpenCode close-out: /wiki-save"
fi
echo "  • Verify anytime: llmwiki doctor"
echo "  • Undo Codex: $BUN_Q ${ROOT_Q}/src/daemon/wire-codex.ts --revert"
echo "  • Undo OpenCode: $BUN_Q ${ROOT_Q}/src/daemon/wire-opencode.ts --revert"
echo "  • Undo daemon/Claude: bash ${ROOT_Q}/daemon/install.sh --uninstall · $BUN_Q ${ROOT_Q}/src/daemon/wire.ts --revert"
