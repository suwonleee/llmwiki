#!/bin/bash
# autoupdate-schedule.sh — install/remove the timer that runs unattended update.
# THIS IS THE "FULLY AUTONOMOUS" SWITCH. Installing it makes the machine auto-write wiki
# pages with no human in the loop (gated by 2nd-model verify + lint; doubtful → 0_review/).
# OFF by default — only run this once you trust autoupdate output (spot-check 0_review/).
#
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh [--at-hours 8,11,14,16] [--per-repo N]
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh [--interval-hours N] [--per-repo N]
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh --uninstall
#
# --at-hours: wall-clock aligned — runs at those hours daily. Asleep at the time → launchd
#   coalesces and runs once on wake; systemd's Persistent=true does the same.
# --interval-hours: fixed interval from load. Either one; --at-hours wins.
#
#   macOS           → launchd agent          (com.llmwiki.autoupdate)
#   Linux + systemd → systemd --user timer   (llmwiki-autoupdate.timer)
#   no supervisor   → crontab entries        (WSL · minimal containers)
#
# Every branch is the SAME switch. Until this file grew the last two, "fully autonomous" was a
# macOS-only feature that no document said was macOS-only: on Linux the script wrote a plist into a
# directory launchd does not read there, said "scheduled", and nothing ever ran.
set -e
LABEL="com.llmwiki.autoupdate"
UNIT="llmwiki-autoupdate"
# ROOT = this clone, resolved from the script's own location (path/name-agnostic).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SYSTEMD_DIR="$HOME/.config/systemd/user"
CRON_TAG="# llmwiki-autoupdate ($ROOT)"
HOURS=4; PER=3; AT_HOURS=""

have() { command -v "$1" >/dev/null 2>&1; }
have_systemd() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

if [ "$1" = "--uninstall" ]; then
    REMOVED=0
    if have launchctl; then
        launchctl unload "$PLIST" 2>/dev/null || true
    fi
    [ -f "$PLIST" ] && { rm -f "$PLIST"; REMOVED=1; }
    if have_systemd; then
        # Claim a removal only when there was something to remove — "✓ uninstalled" over a machine
        # that never scheduled anything is the green-line-over-nothing pattern this engine fights.
        if [ -f "$SYSTEMD_DIR/$UNIT.timer" ] || [ -f "$SYSTEMD_DIR/$UNIT.service" ]; then
            systemctl --user disable --now "$UNIT.timer" 2>/dev/null || true
            rm -f "$SYSTEMD_DIR/$UNIT.timer" "$SYSTEMD_DIR/$UNIT.service"
            systemctl --user daemon-reload 2>/dev/null || true
            REMOVED=1
        fi
    fi
    if have crontab && crontab -l 2>/dev/null | grep -qF "$CRON_TAG"; then
        { crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; } | crontab -
        REMOVED=1
    fi
    [ "$REMOVED" -eq 1 ] && echo "✓ uninstalled $LABEL (unattended update OFF)" \
        || echo "• nothing scheduled here (unattended update was already OFF)"
    exit 0
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --interval-hours) HOURS="$2"; shift;;
    --at-hours) AT_HOURS="$2"; shift;;
    --per-repo) PER="$2"; shift;;
  esac; shift
done

BUN="$(command -v bun || true)"
[ -z "$BUN" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh" >&2; exit 1; }

# The state root is the machine-local one the rest of the engine uses, established under the same
# ownership contract. Hardcoding "$ROOT/.state" here meant this scheduler wrote its log outside the
# directory LLMWIKI_STATE_DIR had designated, in a clone the user may have made read-only.
STATE_REQUESTED="${LLMWIKI_STATE_DIR:-$ROOT/.state}"
STATE="$("$BUN" "$ROOT/src/engine/state-bootstrap.ts" "$STATE_REQUESTED")"

# A supervised job runs with a minimal PATH — but autoupdate shells out to `claude` (and bun, git),
# which live in homebrew/nvm/nix dirs that are not on it. Without this the scheduled run fires and
# the claude call fails "command not found". The engine computes the list (src/engine/
# tool-locate.ts) so it stays identical to the capture daemon's.
SERVICE_PATH="$("$BUN" "$ROOT/src/engine/tool-locate.ts" --service-path 2>/dev/null || true)"
# `|| true` is load-bearing under `set -e`: an assignment takes the exit status of its command
# substitution, so on a machine without `claude` this line ENDED the script — before any output,
# with status 1, which reads as "the scheduler is broken" rather than "claude is not installed".
_cl="$(command -v claude 2>/dev/null || true)"
[ -n "$_cl" ] && SERVICE_PATH="$(dirname "$_cl")${SERVICE_PATH:+:$SERVICE_PATH}"
[ -z "$SERVICE_PATH" ] && SERVICE_PATH="$PATH"

INTERVAL=$((HOURS * 3600))
[ -n "$AT_HOURS" ] && DESC="at hours ${AT_HOURS}" || DESC="every ${HOURS}h"
RUNNER="$ROOT/daemon/autoupdate-all.sh"

# --- macOS: launchd ----------------------------------------------------------
if [ "$(uname)" = "Darwin" ] && have launchctl; then
    mkdir -p "$HOME/Library/LaunchAgents"
    build_sched() {
      if [ -n "$AT_HOURS" ]; then
        printf '    <key>StartCalendarInterval</key>\n    <array>\n'
        IFS=',' read -ra HRS <<< "$AT_HOURS"
        for h in "${HRS[@]}"; do
          printf '        <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>0</integer></dict>\n' "$h"
        done
        printf '    </array>'
      else
        printf '    <key>StartInterval</key><integer>%s</integer>' "$INTERVAL"
      fi
    }
    SCHED="$(build_sched)"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$RUNNER</string>
        <string>--commit</string>
        <string>--per-repo</string>
        <string>$PER</string>
    </array>
$SCHED
    <key>RunAtLoad</key><false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>$SERVICE_PATH</string>
        <key>LLMWIKI_STATE_DIR</key><string>$STATE</string>
    </dict>
    <key>StandardOutPath</key><string>$STATE/autoupdate.log</string>
    <key>StandardErrorPath</key><string>$STATE/autoupdate.log</string>
</dict>
</plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "✓ scheduled $LABEL via launchd — $DESC, --per-repo $PER (unattended update ON)"
    echo "  log    : $STATE/autoupdate.log"
    echo "  review : spot-check each repo's docs/wiki/0_review/ periodically"
    echo "  off    : bash $ROOT/daemon/autoupdate-schedule.sh --uninstall"
    exit 0
fi

# --- Linux with systemd: a --user timer --------------------------------------
if have_systemd; then
    mkdir -p "$SYSTEMD_DIR"
    cat > "$SYSTEMD_DIR/$UNIT.service" <<EOF
[Unit]
Description=llmwiki unattended wiki update ($ROOT)

[Service]
Type=oneshot
Environment="PATH=$SERVICE_PATH"
Environment="LLMWIKI_STATE_DIR=$STATE"
ExecStart=/bin/bash "$RUNNER" --commit --per-repo $PER
StandardOutput=append:$STATE/autoupdate.log
StandardError=append:$STATE/autoupdate.log
EOF
    if [ -n "$AT_HOURS" ]; then
        # OnCalendar accepts a comma list of hours directly.
        SCHED_LINE="OnCalendar=*-*-* ${AT_HOURS}:00:00"
    else
        SCHED_LINE="OnUnitActiveSec=${HOURS}h
OnBootSec=${HOURS}h"
    fi
    cat > "$SYSTEMD_DIR/$UNIT.timer" <<EOF
[Unit]
Description=llmwiki unattended wiki update schedule ($DESC)

[Timer]
$SCHED_LINE
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer"
    echo "✓ scheduled $LABEL via systemd --user — $DESC, --per-repo $PER (unattended update ON)"
    echo "  timer  : $SYSTEMD_DIR/$UNIT.timer"
    echo "  log    : $STATE/autoupdate.log"
    echo "  check  : systemctl --user list-timers | grep llmwiki"
    echo "  review : spot-check each repo's docs/wiki/0_review/ periodically"
    echo "  NOTE   : to keep running without an active login session, run once:"
    echo "           loginctl enable-linger \"$USER\""
    echo "  off    : bash $ROOT/daemon/autoupdate-schedule.sh --uninstall"
    exit 0
fi

# --- no supervisor: crontab --------------------------------------------------
if have crontab; then
    if [ -n "$AT_HOURS" ]; then
        CRON_WHEN="0 $AT_HOURS * * *"
    else
        CRON_WHEN="0 */$HOURS * * *"
    fi
    printf -v RUNNER_Q '%q' "$RUNNER"
    printf -v STATE_Q '%q' "$STATE"
    printf -v PATH_Q '%q' "$SERVICE_PATH"
    # `|| true`: on an EMPTY crontab `grep -v` selects 0 lines and exits 1, which under `set -e`
    # would abort the subshell before the echo and silently skip registration.
    ( { crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; } || true; \
      echo "$CRON_WHEN PATH=$PATH_Q LLMWIKI_STATE_DIR=$STATE_Q /bin/bash $RUNNER_Q --commit --per-repo $PER >> $STATE_Q/autoupdate.log 2>&1  $CRON_TAG" ) | crontab -
    echo "✓ scheduled $LABEL via cron — $DESC, --per-repo $PER (unattended update ON)"
    echo "  log    : $STATE/autoupdate.log"
    echo "  check  : crontab -l | grep llmwiki"
    echo "  review : spot-check each repo's docs/wiki/0_review/ periodically"
    echo "  off    : bash $ROOT/daemon/autoupdate-schedule.sh --uninstall"
    exit 0
fi

echo "🔴 no launchd, no systemd --user, and no crontab on this machine — nothing to schedule with." >&2
echo "   Unattended update stays OFF. Run it manually when you want it:" >&2
echo "     bash $RUNNER --commit --per-repo $PER" >&2
exit 1
