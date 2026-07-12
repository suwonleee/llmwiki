#!/bin/bash
# autoupdate-schedule.sh — install/remove a launchd timer that runs unattended update.
# THIS IS THE "FULLY AUTONOMOUS" SWITCH. Installing it makes the machine auto-write wiki
# pages with no human in the loop (gated by 2nd-model verify + lint; doubtful → 0_review/).
# OFF by default — only run this once you trust autoupdate output (spot-check 0_review/).
#
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh [--at-hours 8,11,14,16] [--per-repo N]
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh [--interval-hours N] [--per-repo N]
#   bash ~/llmwiki/daemon/autoupdate-schedule.sh --uninstall
#
# --at-hours: wall-clock aligned (StartCalendarInterval) — runs at those hours daily.
#   Asleep at the time → launchd coalesces and runs once on wake. Best for a workday cadence.
# --interval-hours: fixed interval from load (StartInterval). Either one; --at-hours wins.
set -e
LABEL="com.llmwiki.autoupdate"
# ROOT = this clone, resolved from the script's own location (path/name-agnostic).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$ROOT/.state"
HOURS=4; PER=3; AT_HOURS=""

if [ "$1" = "--uninstall" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ uninstalled $LABEL (unattended update OFF)"
    exit 0
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --interval-hours) HOURS="$2"; shift;;
    --at-hours) AT_HOURS="$2"; shift;;
    --per-repo) PER="$2"; shift;;
  esac; shift
done

mkdir -p "$STATE" "$HOME/Library/LaunchAgents"
INTERVAL=$((HOURS * 3600))

# launchd runs with a minimal PATH (/usr/bin:/bin:...) — but autoupdate shells out to `claude`
# (and bun/node), which live in homebrew/nvm/app dirs NOT on that PATH. Without this the
# scheduled run fires but the claude call fails "command not found". Bake the resolving dirs in.
_cl="$(command -v claude 2>/dev/null)"; _nd="$(command -v node 2>/dev/null)"; _bun="$(command -v bun 2>/dev/null)"
LAUNCHD_PATH="${_cl:+$(dirname "$_cl"):}${_nd:+$(dirname "$_nd"):}${_bun:+$(dirname "$_bun"):}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# build the schedule block: wall-clock (StartCalendarInterval) if --at-hours, else StartInterval
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
[ -n "$AT_HOURS" ] && DESC="at hours ${AT_HOURS}" || DESC="every ${HOURS}h"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$ROOT/daemon/autoupdate-all.sh</string>
        <string>--commit</string>
        <string>--per-repo</string>
        <string>$PER</string>
    </array>
$SCHED
    <key>RunAtLoad</key><false/>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>$LAUNCHD_PATH</string></dict>
    <key>StandardOutPath</key><string>$STATE/autoupdate.log</string>
    <key>StandardErrorPath</key><string>$STATE/autoupdate.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✓ scheduled $LABEL — $DESC, --per-repo $PER (unattended update ON)"
echo "  log    : $STATE/autoupdate.log"
echo "  review : 각 레포 docs/wiki/0_review/ 를 주기적으로 spot-check 하세요"
echo "  off    : bash $ROOT/daemon/autoupdate-schedule.sh --uninstall"
