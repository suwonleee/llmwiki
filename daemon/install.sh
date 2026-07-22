#!/bin/bash
# Install/refresh the llmwiki capture daemon as a long-running background service.
# Path/name-agnostic: ROOT resolves from this script's own location (works whether
# cloned as ~/llmwiki or anywhere else).
#
#   macOS              → launchd agent          (com.llmwiki.daemon)
#   Linux + systemd    → systemd --user service (llmwiki-daemon.service)
#   Linux, no systemd  → cron @reboot + nohup    (WSL / minimal containers)
#
# Usage:  bash <clone>/daemon/install.sh [--uninstall]
# See daemon/README.md for status checks, logs, and headless persistence notes.
set -e

LABEL="com.llmwiki.daemon"
UNIT="llmwiki-daemon.service"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/$UNIT"
STATE="$ROOT/.state"
CODEX_STATE_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_PROFILE="${CLAUDE_CONFIG_DIR:-}"
OPENCODE_DATA_HOME="${XDG_DATA_HOME:-}"
OPENCODE_DB_PATH="${OPENCODE_DB:-}"
PY="$(command -v bun)"
[ -z "$PY" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh"; exit 1; }
WATCH="$ROOT/src/daemon/watch.ts"
CRON_TAG="# llmwiki-daemon ($ROOT)"

have() { command -v "$1" >/dev/null 2>&1; }
xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

# --- uninstall (all platforms / mechanisms) ---------------------------------
if [ "$1" = "--uninstall" ]; then
    # macOS launchd
    [ -f "$PLIST" ] && { launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "✓ removed launchd $LABEL"; }
    # Linux systemd --user
    if have systemctl && [ -f "$SYSTEMD_UNIT" ]; then
        systemctl --user disable --now "$UNIT" 2>/dev/null || true
        rm -f "$SYSTEMD_UNIT"
        systemctl --user daemon-reload 2>/dev/null || true
        echo "✓ removed systemd --user $UNIT"
    fi
    # cron fallback
    if have crontab && crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
        crontab -l 2>/dev/null | grep -vF "$CRON_TAG" | crontab -
        echo "✓ removed cron @reboot line"
    fi
    # stray nohup process
    pkill -f "$WATCH" 2>/dev/null && echo "✓ stopped running watch.ts" || true
    echo "uninstall complete."
    exit 0
fi

mkdir -p "$STATE"

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
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ installed + loaded launchd $LABEL"
    echo "  runtime: $PY"
    echo "  plist  : $PLIST"
    echo "  log    : $STATE/daemon.log"
    printf '  check  : launchctl list | grep llmwiki   ·   bun %q doctor\n' "$ROOT/src/cli.ts"
    exit 0
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
pkill -f "$WATCH" 2>/dev/null || true
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
