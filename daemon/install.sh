#!/bin/bash
# Install/refresh the llmwiki capture daemon as a long-running background service.
# Path/name-agnostic: ROOT resolves from this script's own location (works whether
# cloned as ~/llmwiki or anywhere else).
#
#   macOS              → launchd agent          (com.llmwiki.daemon)
#   Linux + systemd    → systemd --user service (llmwiki-daemon.service)
#   no supervisor      → cron @reboot + nohup    (WSL · minimal containers · macOS without launchd)
#
# Every branch ends with a VERIFIED state, never an assumed one: the daemon is either confirmed
# running under a supervisor, or started in the foreground-less fallback and reported as such.
#
# Usage:  bash <clone>/daemon/install.sh [--uninstall]
# See daemon/README.md for status checks, logs, and headless persistence notes.
set -e

LABEL="com.llmwiki.daemon"
UNIT="llmwiki-daemon.service"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$UNIT"
STATE_REQUESTED="${LLMWIKI_STATE_DIR:-$ROOT/.state}"
CODEX_STATE_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_PROFILE="${CLAUDE_CONFIG_DIR:-}"
OPENCODE_DATA_HOME="${XDG_DATA_HOME:-}"
OPENCODE_DB_PATH="${OPENCODE_DB:-}"
PY="$(command -v bun)"
[ -z "$PY" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh"; exit 1; }
WATCH="$ROOT/src/daemon/watch.ts"
CRON_TAG="# llmwiki-daemon ($ROOT)"

have() { command -v "$1" >/dev/null 2>&1; }
watch_pids() {
    have ps || return 2
    WATCH_PS="$(ps -axo pid=,command= 2>/dev/null)" || return 2
    WATCH_BIN="$(basename "$PY")"
    while read -r WATCH_PID WATCH_COMMAND; do
        case "$WATCH_COMMAND" in
            "$WATCH_BIN $WATCH"|"$PY $WATCH"|*/"$WATCH_BIN $WATCH")
                [ "$WATCH_PID" != "$$" ] && printf '%s\n' "$WATCH_PID"
                ;;
        esac
    done <<EOF
$WATCH_PS
EOF
}
stop_watch_processes() {
    STOP_PIDS_STATUS=0
    STOP_PIDS="$(watch_pids)" || STOP_PIDS_STATUS=$?
    [ "$STOP_PIDS_STATUS" -eq 0 ] || return 2
    for STOP_PID in $STOP_PIDS; do
        kill "$STOP_PID" 2>/dev/null || return 1
    done
    [ -z "$STOP_PIDS" ] || sleep 1
    STOP_REMAINING_STATUS=0
    STOP_REMAINING="$(watch_pids)" || STOP_REMAINING_STATUS=$?
    [ "$STOP_REMAINING_STATUS" -eq 0 ] || return 2
    [ -z "$STOP_REMAINING" ] || return 1
    [ -z "$STOP_PIDS" ] || printf '%s\n' "$STOP_PIDS"
}
xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

# --- uninstall (all platforms / mechanisms) ---------------------------------
if [ "$1" = "--uninstall" ]; then
    UNINSTALL_FAILURES=0
    uninstall_failure() {
        UNINSTALL_FAILURES=$((UNINSTALL_FAILURES + 1))
        echo "🔴 $1" >&2
    }
    # macOS launchd
    if have launchctl; then
        LAUNCHD_LIST_OK=1
        LAUNCHD_LIST="$(launchctl list 2>/dev/null)" || LAUNCHD_LIST_OK=0
        if [ "$LAUNCHD_LIST_OK" -ne 1 ]; then
            uninstall_failure "launchd status could not be verified; shutdown is unconfirmed."
        elif [ -f "$PLIST" ]; then
            if launchctl unload "$PLIST" 2>/dev/null; then
                rm -f "$PLIST"
                echo "✓ removed launchd $LABEL"
            elif ! printf '%s\n' "$LAUNCHD_LIST" | grep -qF "$LABEL"; then
                rm -f "$PLIST"
                echo "✓ removed inactive launchd $LABEL"
            elif launchctl remove "$LABEL" 2>/dev/null; then
                rm -f "$PLIST"
                echo "✓ removed launchd $LABEL"
            else
                uninstall_failure "launchd $LABEL could not be stopped; its plist was preserved."
            fi
        elif printf '%s\n' "$LAUNCHD_LIST" | grep -qF "$LABEL"; then
            if launchctl remove "$LABEL" 2>/dev/null; then
                echo "✓ removed definitionless launchd $LABEL"
            else
                uninstall_failure "definitionless launchd $LABEL could not be stopped."
            fi
        fi
    elif [ -f "$PLIST" ]; then
        uninstall_failure "launchctl is unavailable; $LABEL plist was preserved."
    fi
    # Linux systemd --user
    if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
        SYSTEMD_STATUS=0
        systemctl --user is-active --quiet "$UNIT" 2>/dev/null || SYSTEMD_STATUS=$?
        if [ "$SYSTEMD_STATUS" -eq 0 ]; then
            systemctl --user stop "$UNIT" 2>/dev/null || true
            SYSTEMD_STATUS=0
            systemctl --user is-active --quiet "$UNIT" 2>/dev/null || SYSTEMD_STATUS=$?
        fi
        if [ "$SYSTEMD_STATUS" -eq 0 ] || [ "$SYSTEMD_STATUS" -eq 1 ] || [ "$SYSTEMD_STATUS" -eq 2 ]; then
            uninstall_failure "systemd could not verify that $UNIT is inactive."
        elif [ -f "$SYSTEMD_UNIT" ]; then
            systemctl --user disable "$UNIT" 2>/dev/null || true
            rm -f "$SYSTEMD_UNIT"
            if systemctl --user daemon-reload 2>/dev/null; then
                echo "✓ removed systemd --user $UNIT"
            else
                uninstall_failure "systemd daemon-reload failed after stopping $UNIT."
            fi
        fi
    elif [ -f "$SYSTEMD_UNIT" ]; then
        uninstall_failure "systemd user manager is unavailable; $UNIT file was preserved."
    fi
    # cron fallback
    if have crontab && crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
        if crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -; then
            echo "✓ removed cron @reboot line"
        else
            uninstall_failure "cron @reboot line could not be removed."
        fi
    fi
    # stray nohup process — enumerate with `ps` and match the path literally. `pgrep -f` treats
    # clone paths as regular expressions, so a perfectly valid path containing `[` can evade it.
    WATCH_STOP_STATUS=0
    WATCH_STOPPED="$(stop_watch_processes)" || WATCH_STOP_STATUS=$?
    if [ "$WATCH_STOP_STATUS" -eq 2 ]; then
        uninstall_failure "watch.ts process status could not be verified."
    elif [ "$WATCH_STOP_STATUS" -ne 0 ]; then
        uninstall_failure "running watch.ts process could not be stopped."
    elif [ -n "$WATCH_STOPPED" ]; then
        echo "✓ stopped running watch.ts"
    fi
    if [ "$UNINSTALL_FAILURES" -gt 0 ]; then
        echo "uninstall incomplete: $UNINSTALL_FAILURES daemon stop step(s) failed." >&2
        exit 1
    fi
    echo "uninstall complete."
    exit 0
fi

# Establish the exact same ownership boundary capture/OpenCode use before launchd/systemd/nohup
# can create daemon.log through redirection. A foreign non-empty override fails closed.
STATE="$("$PY" "$ROOT/src/engine/state-bootstrap.ts" "$STATE_REQUESTED")"

# --- macOS: launchd ----------------------------------------------------------
if [ "$(uname)" = "Darwin" ]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    XML_PY="$(xml_escape "$PY")"
    XML_WATCH="$(xml_escape "$WATCH")"
    XML_HOME="$(xml_escape "$HOME")"
    XML_CODEX_HOME="$(xml_escape "$CODEX_STATE_HOME")"
    XML_CLAUDE_PROFILE="$(xml_escape "$CLAUDE_PROFILE")"
    XML_OPENCODE_DATA_HOME="$(xml_escape "$OPENCODE_DATA_HOME")"
    XML_OPENCODE_DB_PATH="$(xml_escape "$OPENCODE_DB_PATH")"
    XML_STATE="$(xml_escape "$STATE")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$XML_PY</string>
        <string>$XML_WATCH</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$XML_HOME</string>
        <key>CODEX_HOME</key><string>$XML_CODEX_HOME</string>
        <key>CLAUDE_CONFIG_DIR</key><string>$XML_CLAUDE_PROFILE</string>
        <key>XDG_DATA_HOME</key><string>$XML_OPENCODE_DATA_HOME</string>
        <key>OPENCODE_DB</key><string>$XML_OPENCODE_DB_PATH</string>
        <key>LLMWIKI_STATE_DIR</key><string>$XML_STATE</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$XML_STATE/daemon.log</string>
    <key>StandardErrorPath</key><string>$XML_STATE/daemon.log</string>
    <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
EOF
    # Ask launchd whether it took; do not assert it. A plist on disk is not a running daemon, and
    # this branch used to print "installed + loaded" unconditionally — including when `launchctl`
    # was missing entirely, where the shell's own "command not found" was the only clue and the
    # script still exited 0. A green line over a dead capture loop is the failure mode this engine
    # keeps finding in the field, so the check is now the thing that prints the line.
    if have launchctl; then
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST" 2>/dev/null || true
        if launchctl list 2>/dev/null | grep -qF "$LABEL"; then
            echo "✓ installed + loaded launchd $LABEL"
            echo "  runtime: $PY"
            echo "  plist  : $PLIST"
            echo "  log    : $STATE/daemon.log"
            printf '  check  : launchctl list | grep llmwiki   ·   bun %q doctor\n' "$ROOT/src/cli.ts"
            exit 0
        fi
        echo "⚠️ launchd did not accept $LABEL (plist written: $PLIST)."
    else
        echo "⚠️ launchctl not found on PATH."
    fi
    # Fall through to the supervisor-less fallback below — the same one Linux uses when it has no
    # systemd. Capture starting now matters more than which supervisor keeps it alive.
    echo "   Falling back to a plain background process; see the note at the end."
fi

# --- Linux with systemd: systemd --user service ------------------------------
if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$(dirname "$SYSTEMD_UNIT")"
    cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=llmwiki capture daemon ($ROOT)
After=default.target

[Service]
Type=simple
Environment="HOME=$HOME"
Environment="CODEX_HOME=$CODEX_STATE_HOME"
Environment="CLAUDE_CONFIG_DIR=$CLAUDE_PROFILE"
Environment="XDG_DATA_HOME=$OPENCODE_DATA_HOME"
Environment="OPENCODE_DB=$OPENCODE_DB_PATH"
Environment="LLMWIKI_STATE_DIR=$STATE"
ExecStart="$PY" "$WATCH"
Restart=always
RestartSec=30
StandardOutput=append:$STATE/daemon.log
StandardError=append:$STATE/daemon.log

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT"
    echo "✓ installed + started systemd --user $UNIT"
    echo "  runtime: $PY"
    echo "  unit   : $SYSTEMD_UNIT"
    echo "  log    : $STATE/daemon.log"
    printf '  check  : systemctl --user status %q   ·   bun %q doctor\n' "$UNIT" "$ROOT/src/cli.ts"
    echo "  NOTE   : to keep capturing without an active login session, run once:"
    echo "           loginctl enable-linger \"$USER\""
    exit 0
fi

# --- Linux without systemd (WSL / minimal): cron @reboot + nohup now ----------
if have crontab; then
    printf -v PY_Q '%q' "$PY"
    printf -v WATCH_Q '%q' "$WATCH"
    printf -v STATE_Q '%q' "$STATE"
    printf -v HOME_Q '%q' "$HOME"
    printf -v CODEX_HOME_Q '%q' "$CODEX_STATE_HOME"
    printf -v CLAUDE_PROFILE_Q '%q' "$CLAUDE_PROFILE"
    printf -v OPENCODE_DATA_HOME_Q '%q' "$OPENCODE_DATA_HOME"
    printf -v OPENCODE_DB_PATH_Q '%q' "$OPENCODE_DB_PATH"
    # idempotent: drop any prior llmwiki line, then add a fresh one.
    # `|| true` is required: on an EMPTY crontab `grep -v` selects 0 lines → exit 1,
    # which under `set -e` would abort the subshell before the echo and silently skip
    # registration (the common fresh-user case).
    ( { crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; } || true; \
      echo "@reboot HOME=$HOME_Q CODEX_HOME=$CODEX_HOME_Q CLAUDE_CONFIG_DIR=$CLAUDE_PROFILE_Q XDG_DATA_HOME=$OPENCODE_DATA_HOME_Q OPENCODE_DB=$OPENCODE_DB_PATH_Q LLMWIKI_STATE_DIR=$STATE_Q nohup $PY_Q $WATCH_Q >> $STATE_Q/daemon.log 2>&1 &  $CRON_TAG" ) | crontab -
    echo "✓ registered cron @reboot line ($CRON_TAG)"
fi
# start it now regardless (so capture begins this boot too)
WATCH_STOP_STATUS=0
stop_watch_processes >/dev/null || WATCH_STOP_STATUS=$?
if [ "$WATCH_STOP_STATUS" -ne 0 ]; then
    echo "🔴 existing watch.ts process could not be safely identified/stopped; refusing to start a duplicate." >&2
    exit 1
fi
nohup "$PY" "$WATCH" >> "$STATE/daemon.log" 2>&1 &
echo "✓ started watch.ts in background (pid $!)"
echo "  runtime: $PY"
echo "  log    : $STATE/daemon.log"
printf '  check  : pgrep -af watch.ts   ·   bun %q doctor\n' "$ROOT/src/cli.ts"
if ! have crontab; then
    echo "  ⚠️ no systemd and no crontab found — daemon will NOT auto-restart on reboot."
    echo "     Re-run this script after each reboot, or see daemon/README.md."
fi
exit 0
