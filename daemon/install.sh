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
# Empty means "ask the engine" (src/engine/state-bootstrap.ts). Hardcoding <clone>/.state here is
# what used to put every fresh install back inside the disposable clone.
STATE_REQUESTED="${LLMWIKI_STATE_DIR:-}"
CODEX_STATE_HOME="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_PROFILE="${CLAUDE_CONFIG_DIR:-}"
OPENCODE_DATA_HOME="${XDG_DATA_HOME:-}"
OPENCODE_DB_PATH="${OPENCODE_DB:-}"
PY="$(command -v bun)"
[ -z "$PY" ] && { echo "🔴 bun not found on PATH — install Bun first: https://bun.sh"; exit 1; }
WATCH="$ROOT/src/daemon/watch.ts"
CRON_TAG="# llmwiki-daemon ($ROOT)"
# The PATH the SERVICE will run with. launchd hands an agent /usr/bin:/bin:/usr/sbin:/sbin, and a
# systemd --user unit little more — but the daemon shells out to `git` for every enrollment check.
# A Homebrew/Nix/MacPorts git that this installing shell found perfectly well would be invisible to
# the daemon, and the result is not an error: every session reads as "not a git worktree", the
# queue fills with skipped rows, and doctor stays green. The engine computes it (src/engine/
# tool-locate.ts) so the search list lives in exactly one language.
SERVICE_PATH="$("$PY" "$ROOT/src/engine/tool-locate.ts" --service-path 2>/dev/null || true)"
[ -z "$SERVICE_PATH" ] && SERVICE_PATH="$PATH"

have() { command -v "$1" >/dev/null 2>&1; }

# Enumerate running watch.ts processes. Exit 2 means "could not verify", which every caller treats
# as a hard stop — starting a second daemon is worse than not starting one.
#
# Two mechanisms, because `ps -axo` is not universal: BusyBox ps has no `-o`, so in a minimal
# container this returned 2 forever and install refused to start the daemon at all. procfs is read
# first where it exists: it needs no subprocess, and comparing argv entries NUL-by-NUL is an exact
# match rather than a string-shape guess (`pgrep -f` would treat a clone path containing `[` as a
# regex — the reason this was written by hand in the first place).
watch_pids_proc() {
    [ -d /proc ] || return 2
    for PROC_DIR in /proc/[0-9]*; do
        [ -r "$PROC_DIR/cmdline" ] || continue
        PROC_PID="${PROC_DIR#/proc/}"
        [ "$PROC_PID" = "$$" ] && continue
        while IFS= read -r -d '' PROC_ARG; do
            if [ "$PROC_ARG" = "$WATCH" ]; then
                printf '%s\n' "$PROC_PID"
                break
            fi
        done < "$PROC_DIR/cmdline" 2>/dev/null || continue
    done
    return 0
}
watch_pids_ps() {
    have ps || return 2
    WATCH_PS="$(ps -axo pid=,command= 2>/dev/null)" || return 2
    # Exit 0 alone is not an answer: a partial `-o` implementation (some BusyBox builds) exits 0
    # while printing a format with no per-process rows. A real listing always contains at least one
    # "<pid> <command>" line — this very shell. No parseable rows → report unverified, not "none".
    printf '%s\n' "$WATCH_PS" | grep -q '^ *[0-9][0-9]* ' || return 2
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
# `ps` FIRST, procfs only when it cannot answer.
#
# Order matters for more than preference. The test suite makes `ps` inert so that a setup run
# cannot reach the developer's real process table and kill the daemon belonging to this very clone
# (tests/support/inert-supervisor.ts). Consulting procfs first would walk straight past that shim on
# Linux and do exactly what it exists to prevent. A `ps` that answers — even with nothing — is an
# answer; procfs is the fallback for the BusyBox case, where `ps -axo` is not an answer at all.
watch_pids() {
    WATCH_PIDS_STATUS=0
    WATCH_PIDS_OUT="$(watch_pids_ps)" || WATCH_PIDS_STATUS=$?
    if [ "$WATCH_PIDS_STATUS" -eq 0 ]; then
        [ -n "$WATCH_PIDS_OUT" ] && printf '%s\n' "$WATCH_PIDS_OUT"
        return 0
    fi
    watch_pids_proc
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
    # Windows: Startup entry + its launcher, then the process — asking the engine for PIDs, since
    # the `ps` path below cannot answer on MSYS and would report a live daemon as "unverifiable".
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*)
            WIN_STARTUP_DIR="$(cygpath -F 7 2>/dev/null || echo "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup")"
            for WIN_OWNED in "$WIN_STARTUP_DIR/llmwiki-daemon.vbs" "$STATE_REQUESTED/llmwiki-daemon.cmd"; do
                [ -n "$WIN_OWNED" ] && [ -f "$WIN_OWNED" ] && rm -f "$WIN_OWNED" && echo "✓ removed $WIN_OWNED"
            done
            # STATE_REQUESTED is empty unless overridden, so ask the engine where state actually is
            # rather than assuming — the launcher lives beside the queue, wherever that ended up.
            WIN_STATE="$("$PY" "$ROOT/src/engine/state-bootstrap.ts" "$STATE_REQUESTED" 2>/dev/null || true)"
            if [ -n "$WIN_STATE" ] && [ -f "$WIN_STATE/llmwiki-daemon.cmd" ]; then
                rm -f "$WIN_STATE/llmwiki-daemon.cmd" && echo "✓ removed $WIN_STATE/llmwiki-daemon.cmd"
            fi
            WIN_PIDS_STATUS=0
            WIN_PIDS="$("$PY" "$ROOT/src/engine/daemon-control.ts" --pids 2>/dev/null)" || WIN_PIDS_STATUS=$?
            if [ "$WIN_PIDS_STATUS" -eq 2 ]; then
                uninstall_failure "watch.ts process status could not be verified."
            else
                for WIN_PID in $WIN_PIDS; do
                    taskkill //PID "$WIN_PID" //F >/dev/null 2>&1 || \
                        uninstall_failure "running watch.ts process (pid $WIN_PID) could not be stopped."
                done
                [ -n "$WIN_PIDS" ] && echo "✓ stopped running watch.ts"
            fi
            if [ "$UNINSTALL_FAILURES" -gt 0 ]; then
                echo "uninstall incomplete: $UNINSTALL_FAILURES daemon stop step(s) failed." >&2
                exit 1
            fi
            echo "uninstall complete."
            exit 0
            ;;
    esac
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

# --- Windows (Git Bash / MSYS / Cygwin): Startup folder ----------------------
#
# This branch exists because every assumption below it is false here, and each one failed SILENTLY:
#
#   - `nohup` is not part of Git Bash. The unsupervised fallback ran it, the shell wrote
#     "nohup: command not found" into daemon.log, and the script printed "✓ started watch.ts in
#     background (pid …)" anyway — `$!` is the pid of a subshell that had already died. A green
#     line over a dead capture loop is the exact failure this file's comments are written against.
#   - SERVICE_PATH is a WINDOWS path list (`C:\a;C:\b`). Assigning it to a bash `PATH=` makes one
#     nonexistent entry out of the whole list, so the daemon would not have found `git` — and a
#     daemon that cannot run git reports every session as "not a git worktree" and skips it.
#   - `ps -axo` is rejected by MSYS ps, so the duplicate-guard could not answer and refused to
#     start anything at all.
#
# Task Scheduler is not the answer: `/SC ONLOGON` requires elevation ("Access is denied" for a
# normal user), and a note-taking daemon does not justify an elevated installer. The per-user
# Startup folder needs no rights, and gives the same guarantee as the Linux cron @reboot fallback —
# starts with your session, does not restart on crash — which is how it is reported.
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        STARTUP_DIR="$(cygpath -F 7 2>/dev/null || echo "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup")"
        LAUNCHER_CMD="$STATE/llmwiki-daemon.cmd"
        LAUNCHER_VBS="$STARTUP_DIR/llmwiki-daemon.vbs"

        # Everything the daemon runs with is baked into the .cmd, exactly as the plist and the
        # systemd unit do it — same reason (a service inherits a minimal environment), same list.
        # Native Windows spellings throughout: this file is read by cmd.exe, not by bash.
        W_PY="$(cygpath -w "$PY")"
        W_WATCH="$(cygpath -w "$WATCH")"
        W_STATE="$(cygpath -w "$STATE")"
        W_HOME="$(cygpath -w "$HOME")"
        W_CODEX_HOME="$(cygpath -w "$CODEX_STATE_HOME" 2>/dev/null || echo "$CODEX_STATE_HOME")"
        W_CLAUDE_PROFILE="$CLAUDE_PROFILE"
        [ -n "$W_CLAUDE_PROFILE" ] && W_CLAUDE_PROFILE="$(cygpath -w "$W_CLAUDE_PROFILE" 2>/dev/null || echo "$CLAUDE_PROFILE")"
        W_OPENCODE_DATA_HOME="$OPENCODE_DATA_HOME"
        [ -n "$W_OPENCODE_DATA_HOME" ] && W_OPENCODE_DATA_HOME="$(cygpath -w "$W_OPENCODE_DATA_HOME" 2>/dev/null || echo "$OPENCODE_DATA_HOME")"
        W_OPENCODE_DB="$OPENCODE_DB_PATH"
        [ -n "$W_OPENCODE_DB" ] && W_OPENCODE_DB="$(cygpath -w "$W_OPENCODE_DB" 2>/dev/null || echo "$OPENCODE_DB_PATH")"

        mkdir -p "$STATE"
        # SERVICE_PATH is already a Windows path list here — tool-locate.ts builds it for the
        # platform it runs on — so it is written straight into the .cmd, never into a bash PATH.
        {
            printf '@echo off\r\n'
            printf 'rem llmwiki capture daemon (%s) — generated by daemon/install.sh\r\n' "$ROOT"
            printf 'set "PATH=%s"\r\n' "$SERVICE_PATH"
            printf 'set "HOME=%s"\r\n' "$W_HOME"
            printf 'set "CODEX_HOME=%s"\r\n' "$W_CODEX_HOME"
            printf 'set "CLAUDE_CONFIG_DIR=%s"\r\n' "$W_CLAUDE_PROFILE"
            printf 'set "XDG_DATA_HOME=%s"\r\n' "$W_OPENCODE_DATA_HOME"
            printf 'set "OPENCODE_DB=%s"\r\n' "$W_OPENCODE_DB"
            printf 'set "LLMWIKI_STATE_DIR=%s"\r\n' "$W_STATE"
            printf '"%s" "%s" >> "%s\\daemon.log" 2>&1\r\n' "$W_PY" "$W_WATCH" "$W_STATE"
        } > "$LAUNCHER_CMD"

        # A .cmd in the Startup folder would flash a console window at every sign-in and keep one
        # on screen for as long as the daemon lives. wscript runs the same file with the window
        # hidden (0) and without waiting (False) — the standard unelevated way to do this.
        mkdir -p "$STARTUP_DIR"
        {
            printf 'Rem llmwiki capture daemon (%s) — generated by daemon/install.sh\r\n' "$ROOT"
            printf 'CreateObject("WScript.Shell").Run """%s""", 0, False\r\n' "$(cygpath -w "$LAUNCHER_CMD")"
        } > "$LAUNCHER_VBS"

        # Duplicate guard, asking the engine rather than a `ps` that cannot answer here.
        WIN_PIDS_STATUS=0
        WIN_PIDS="$("$PY" "$ROOT/src/engine/daemon-control.ts" --pids 2>/dev/null)" || WIN_PIDS_STATUS=$?
        if [ "$WIN_PIDS_STATUS" -eq 2 ]; then
            echo "🔴 could not determine whether a capture daemon is already running; refusing to start a duplicate." >&2
            exit 1
        fi
        for WIN_PID in $WIN_PIDS; do
            taskkill //PID "$WIN_PID" //F >/dev/null 2>&1 || true
        done

        # Start it for THIS session too, detached and hidden, through the file that will run at the
        # next logon — so what starts now is byte-identical to what starts then.
        cscript //nologo //B "$(cygpath -w "$LAUNCHER_VBS")" >/dev/null 2>&1 || \
            wscript //nologo //B "$(cygpath -w "$LAUNCHER_VBS")" >/dev/null 2>&1 || true

        # Verify; never assert. The daemon needs a moment to appear in the process table, and the
        # whole point of this branch is that "we ran something" is not evidence it is running.
        WIN_STARTED=0
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            if "$PY" "$ROOT/src/engine/daemon-control.ts" --running >/dev/null 2>&1; then
                WIN_STARTED=1
                break
            fi
            sleep 1
        done
        echo "✓ registered logon startup: $LAUNCHER_VBS"
        if [ "$WIN_STARTED" -eq 1 ]; then
            echo "✓ started watch.ts (hidden, detached)"
        else
            echo "🔴 the capture daemon did not come up; it is NOT running." >&2
            echo "   launcher: $LAUNCHER_CMD" >&2
            echo "   log     : $STATE/daemon.log" >&2
            exit 1
        fi
        echo "  runtime: $PY"
        echo "  log    : $STATE/daemon.log"
        printf '  check  : bun %q doctor\n' "$ROOT/src/cli.ts"
        echo "  NOTE   : the Startup folder starts the daemon at sign-in but does not restart it if"
        echo "           it crashes (same guarantee as the cron @reboot fallback on Linux)."
        exit 0
        ;;
esac

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
    XML_SERVICE_PATH="$(xml_escape "$SERVICE_PATH")"
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
        <key>PATH</key><string>$XML_SERVICE_PATH</string>
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
Environment="PATH=$SERVICE_PATH"
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
    printf -v SERVICE_PATH_Q '%q' "$SERVICE_PATH"
    # idempotent: drop any prior llmwiki line, then add a fresh one.
    # `|| true` is required: on an EMPTY crontab `grep -v` selects 0 lines → exit 1,
    # which under `set -e` would abort the subshell before the echo and silently skip
    # registration (the common fresh-user case).
    ( { crontab -l 2>/dev/null | grep -vF "$CRON_TAG"; } || true; \
      echo "@reboot PATH=$SERVICE_PATH_Q HOME=$HOME_Q CODEX_HOME=$CODEX_HOME_Q CLAUDE_CONFIG_DIR=$CLAUDE_PROFILE_Q XDG_DATA_HOME=$OPENCODE_DATA_HOME_Q OPENCODE_DB=$OPENCODE_DB_PATH_Q LLMWIKI_STATE_DIR=$STATE_Q nohup $PY_Q $WATCH_Q >> $STATE_Q/daemon.log 2>&1 &  $CRON_TAG" ) | crontab -
    echo "✓ registered cron @reboot line ($CRON_TAG)"
fi
# start it now regardless (so capture begins this boot too)
WATCH_STOP_STATUS=0
stop_watch_processes >/dev/null || WATCH_STOP_STATUS=$?
if [ "$WATCH_STOP_STATUS" -ne 0 ]; then
    echo "🔴 existing watch.ts process could not be safely identified/stopped; refusing to start a duplicate." >&2
    exit 1
fi
# Same PATH the supervised branches bake in — this process is the daemon until the next reboot.
PATH="$SERVICE_PATH" nohup "$PY" "$WATCH" >> "$STATE/daemon.log" 2>&1 &
echo "✓ started watch.ts in background (pid $!)"
echo "  runtime: $PY"
echo "  log    : $STATE/daemon.log"
printf '  check  : pgrep -af watch.ts   ·   bun %q doctor\n' "$ROOT/src/cli.ts"
if ! have crontab; then
    echo "  ⚠️ no systemd and no crontab found — daemon will NOT auto-restart on reboot."
    echo "     Re-run this script after each reboot, or see daemon/README.md."
fi
exit 0
