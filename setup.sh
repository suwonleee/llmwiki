#!/bin/bash
# setup.sh — one-command onboarding for the llmwiki engine.
#
# Clone anywhere, then run `./setup.sh`. Paths are derived from this clone.
# Claude Code, Codex, and OpenCode wiring are independent; auto installs every detected harness.
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HARNESS="auto"
DRY_RUN=0
UNINSTALL=0
PURGE_DATA=0

usage() {
    cat <<EOF
Usage: ./setup.sh [--dry-run] [--harness auto|codex|claude|opencode|all]
       ./setup.sh --uninstall [--purge-data]

Options:
  --help, -h             Show this help without changing files or services.
  --dry-run              Print planned actions without changing files or services.
  --harness <name>       auto (default), codex, claude, opencode, or all.
  --uninstall            Remove every llmwiki-owned hook, plugin, command, launcher and
                         background service. Unrelated configuration is left untouched, and
                         your wikis (docs/wiki in each project) are never touched.
  --purge-data           With --uninstall, also delete llmwiki's local runtime state
                         (capture queue, daemon log, transcript exports). Without it the
                         state is kept and its location reported.

Run --uninstall from the installed clone, BEFORE moving or deleting that clone: the
installed hooks point at this directory, so removal needs it to still be here.

Codex installs:
  - native SessionStart + UserPromptSubmit hooks in \$CODEX_HOME/hooks.json
  - \$wiki-save, \$wiki-deep, \$wiki-ask, \$wiki-quiz, \$wiki-doctor skills
  - a user-level llmwiki command in ~/.local/bin

OpenCode installs:
  - the global read-injection plugin under \$XDG_CONFIG_HOME/opencode/plugin
  - /wiki-save, /wiki-deep, /wiki-ask, /wiki-quiz, /wiki-doctor commands
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
        --uninstall)
            UNINSTALL=1
            shift
            ;;
        --purge-data)
            PURGE_DATA=1
            shift
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
BUN_VERSION="$("$BUN" --version 2>/dev/null || true)"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_REST="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_REST%%.*}"
case "$BUN_MAJOR" in
    ''|*[!0-9]*) echo "🔴 unable to determine Bun version from: ${BUN_VERSION:-<empty>}" >&2; exit 1 ;;
esac
case "$BUN_MINOR" in
    ''|*[!0-9]*) echo "🔴 unable to determine Bun version from: ${BUN_VERSION:-<empty>}" >&2; exit 1 ;;
esac
if [ "$BUN_MAJOR" -lt 1 ] || { [ "$BUN_MAJOR" -eq 1 ] && [ "$BUN_MINOR" -lt 1 ]; }; then
    echo "🔴 Bun 1.1 or newer is required (found $BUN_VERSION) — update Bun, then re-run setup." >&2
    exit 1
fi
printf -v BUN_Q '%q' "$BUN"
printf -v ROOT_Q '%q' "$ROOT"

# --- uninstall: ONE documented path that removes every llmwiki-owned surface ----------------
#
# Each wiring module removes what it owns (by ownership marker, never by restoring a backup),
# so this stays correct after a reinstall and never rolls back unrelated configuration the
# user added in between. Runtime state is separate and opt-in: data is kept and reported
# unless --purge-data is given.
if [ "$UNINSTALL" -eq 1 ]; then
    UNINSTALL_FAILURES=0
    run_uninstall_step() {
        LAST_STEP_OK=1
        STEP_NAME="$1"
        shift
        if "$@"; then
            return 0
        else
            STEP_STATUS=$?
        fi
        LAST_STEP_OK=0
        UNINSTALL_FAILURES=$((UNINSTALL_FAILURES + 1))
        echo "🔴 $STEP_NAME failed (exit $STEP_STATUS); remaining cleanup will continue." >&2
        return 0
    }

    echo "=== llmwiki uninstall ==="
    echo "--- 1) background capture service ---"
    run_uninstall_step "background capture service" bash "$ROOT/daemon/install.sh" --uninstall
    DAEMON_STOPPED="$LAST_STEP_OK"
    echo
    echo "--- 2) Claude Code hooks + commands ---"
    run_uninstall_step "Claude Code wiring" "$BUN" "$ROOT/src/daemon/wire.ts" --revert
    echo
    echo "--- 3) Codex hooks + skills + launcher ---"
    run_uninstall_step "Codex wiring" "$BUN" "$ROOT/src/daemon/wire-codex.ts" --revert
    echo
    echo "--- 4) OpenCode plugin + commands + launcher ---"
    run_uninstall_step "OpenCode wiring" "$BUN" "$ROOT/src/daemon/wire-opencode.ts" --revert
    echo
    echo "--- 5) local runtime state ---"
    if [ "$PURGE_DATA" -eq 1 ] && [ "$DAEMON_STOPPED" -ne 1 ]; then
        echo "🔴 local runtime state purge skipped because the background service was not confirmed stopped." >&2
    elif [ "$PURGE_DATA" -eq 1 ]; then
        run_uninstall_step "local runtime state purge" "$BUN" "$ROOT/src/cli.ts" purge-state --confirm
    else
        run_uninstall_step "local runtime state report" "$BUN" "$ROOT/src/cli.ts" purge-state --report
    fi
    echo
    if [ "$UNINSTALL_FAILURES" -gt 0 ]; then
        echo "=== uninstall incomplete: $UNINSTALL_FAILURES step(s) need attention ===" >&2
    else
        echo "=== uninstall complete ==="
    fi
    echo "  • Your wikis are untouched: docs/wiki/ in each project is ordinary Markdown you own."
    echo "  • Per-project enrollment markers live in each repo's .git/llmwiki/ and are inert without the engine."
    echo "    Remove one explicitly with: $BUN_Q ${ROOT_Q}/src/cli.ts disable <repo>"
    echo "  • This clone was NOT deleted — remove ${ROOT_Q} yourself when you are done."
    [ "$UNINSTALL_FAILURES" -eq 0 ] || exit 1
    exit 0
fi

USE_CODEX=0
USE_CLAUDE=0
USE_OPENCODE=0

# Every harness precondition below refuses the WHOLE run, on purpose: a half-installed setup is
# worse than none. But when the run covers several harnesses and only one is unready, the person
# is now blocked on a tool they may not even use — measured with three harnesses present and one
# too old: nothing was installed for the other two, and the message named only the failure. State
# the way forward wherever we refuse; the all-or-nothing behaviour itself stays.
partial_harness_hint() {
    if [ $((USE_CODEX + USE_CLAUDE + USE_OPENCODE)) -gt 1 ]; then
        echo "   To set up only the harnesses that ARE ready, re-run with --harness codex|claude|opencode." >&2
    fi
}

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
    partial_harness_hint
    exit 1
fi
if [ "$USE_CLAUDE" -eq 1 ] && ! command -v claude >/dev/null 2>&1; then
    echo "🔴 Claude Code CLI not found on PATH — install Claude Code first, then re-run setup." >&2
    partial_harness_hint
    exit 1
fi
if [ "$USE_OPENCODE" -eq 1 ] && ! command -v opencode >/dev/null 2>&1; then
    echo "🔴 OpenCode CLI not found on PATH — install OpenCode first, then re-run setup." >&2
    partial_harness_hint
    exit 1
fi
if [ "$USE_OPENCODE" -eq 1 ]; then
    OPENCODE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/llmwiki-opencode-check.XXXXXX")"
    OPENCODE_RUN_HELP="$(env -u OPENCODE_CONFIG \
        XDG_CONFIG_HOME="$OPENCODE_CHECK_DIR/config" \
        XDG_DATA_HOME="$OPENCODE_CHECK_DIR/data" \
        XDG_CACHE_HOME="$OPENCODE_CHECK_DIR/cache" \
        XDG_STATE_HOME="$OPENCODE_CHECK_DIR/state" \
        opencode run --help 2>&1 || true)"  # newer OpenCode prints --help to stderr — capture both
    find "$OPENCODE_CHECK_DIR" -depth -delete
    if ! printf '%s\n' "$OPENCODE_RUN_HELP" | grep -q -- '--command'; then
        echo "🔴 this OpenCode installation does not support global custom commands." >&2
        echo "   Update OpenCode, then re-run setup." >&2
        partial_harness_hint
        exit 1
    fi
fi
if [ "$USE_CODEX" -eq 1 ]; then
    if ! codex --help 2>/dev/null | grep -q -- '--dangerously-bypass-hook-trust'; then
        echo "🔴 this Codex installation does not support the required lifecycle hooks." >&2
        echo "   Update Codex, then re-run setup." >&2
        partial_harness_hint
        exit 1
    fi
    CODEX_FEATURE_HOME="${CODEX_HOME:-${HOME:-}/.codex}"
    if [ -d "$CODEX_FEATURE_HOME" ]; then
        CODEX_HOOKS_LINE="$(codex features list 2>/dev/null | grep -E '^hooks[[:space:]]' || true)"
        if [ -n "$CODEX_HOOKS_LINE" ] && ! printf '%s\n' "$CODEX_HOOKS_LINE" | grep -Eq '[[:space:]]true$'; then
            echo "🔴 Codex lifecycle hooks are disabled. Run: codex features enable hooks" >&2
            partial_harness_hint
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
    [ "$USE_CLAUDE" -eq 1 ] && "$BUN" "$ROOT/src/daemon/wire.ts" --dry-run
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
if [ "$USE_CLAUDE" -eq 1 ]; then
    echo "--- $STEP) Claude Code preflight (read-only conflict check) ---"
    "$BUN" "$ROOT/src/daemon/wire.ts" --dry-run
    echo
    STEP=$((STEP + 1))
fi
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
# How to spell the engine command in the closing instructions.
#
# The ~/.local/bin launcher that the Codex and OpenCode wirings install is a `#!/bin/sh` script.
# On Windows only Git Bash can run it, and Git Bash puts ~/bin — not ~/.local/bin — on PATH, so
# telling a Windows adopter to run `llmwiki init` hands them a command that exists in none of the
# shells they have open. The explicit interpreter spelling is correct everywhere; only longer.
CLI="$BUN_Q ${ROOT_Q}/src/cli.ts"
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        # These lines get pasted into whatever shell the reader has open, and on Windows that is
        # usually PowerShell, not the Git Bash that ran setup. A `/c/Users/...` spelling is a Git
        # Bash-only path; the native one works in all three shells, and `bun` is on the Windows PATH.
        CLI="bun \"$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")/src/cli.ts\""
        ;;
    *)
        if [ "$USE_CODEX" -eq 1 ] || [ "$USE_OPENCODE" -eq 1 ]; then CLI="llmwiki"; fi
        ;;
esac
echo "  • Initialize a project: $CLI init <repo>"
echo "  • Verify the installation anytime: $CLI doctor --harness $DOCTOR_HARNESS"
echo "  • Engine-only project diagnosis: $CLI wiki-doctor <repo> (add --fix for safe derived-state repair)"
if [ "$USE_CODEX" -eq 1 ]; then
    echo "  • One-time Codex activation: start Codex, open /hooks, trust both llmwiki hooks."
    echo "  • Then work in a project and close the session with: \$wiki-save"
    echo "  • Diagnose and repair that project's wiki with: \$wiki-doctor"
fi
if [ "$USE_CLAUDE" -eq 1 ]; then
    echo "  • Claude Code close-out: /wiki-save"
    echo "  • Claude Code project-wiki repair: /wiki-doctor"
fi
if [ "$USE_OPENCODE" -eq 1 ]; then
    echo "  • OpenCode close-out: /wiki-save"
    echo "  • OpenCode project-wiki repair: /wiki-doctor"
fi
echo "  • Uninstall everything llmwiki owns: ${ROOT_Q}/setup.sh --uninstall"
echo "  • Also remove local runtime state: ${ROOT_Q}/setup.sh --uninstall --purge-data"
