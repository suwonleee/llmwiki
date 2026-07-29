# llmwiki capture daemon

The **capture (write) link** of the compounding loop. `src/daemon/watch.ts` sweeps every
harness data source on this machine and, when a session settles, records its "pending update"
in the central capture queue (`<clone>/.state/capture.db`). **No LLM is ever called** — the
daemon only writes the waiting list. The actual wiki update happens at `/wiki-save`.

What it watches, per harness:

- **Claude Code** — transcript trees of every profile: `~/.claude*/projects/**/*.jsonl`,
  plus `$CLAUDE_CONFIG_DIR` and any location persisted by `llmwiki connect claude <dir>`
- **Codex** — rollouts under `$CODEX_HOME/sessions/**/*.jsonl[.zst]` (default `~/.codex`)
- **OpenCode** — the SQLite store (`$XDG_DATA_HOME/opencode/opencode*.db` or `$OPENCODE_DB`);
  settled sessions are materialized as export files inside the state root

Transcripts land on these paths whatever terminal (plain/tmux/iTerm2) or folder you work in, so
capture needs no per-client hooks. Short Q&A sessions under 50 lines are skipped as a
workload signal (`src/daemon/watch.ts`). The `watch.ts --once` summary prints `discovered`,
`enqueued`, and `skipped_short` separately, so "not found" and "too short" stay distinguishable.

> **Note**: a session started from `~` (home) has no specific project, so it does not accumulate
> per-project. If you want accumulation, **start the session inside that project's folder.**

`./setup.sh` detects the OS and installs one of the services below automatically. Manual:
`bash <clone>/daemon/install.sh` / removal: `--uninstall`.

---

## macOS — launchd

`install.sh` writes `~/Library/LaunchAgents/com.llmwiki.daemon.plist` and runs
`launchctl load`. The resolved absolute `bun` path is pinned into the plist to avoid launchd's
minimal-PATH problem. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` at install time are also pinned into
the service environment, so transcripts from non-default Codex/Claude profiles keep getting
captured after a reboot.

```bash
launchctl list | grep llmwiki          # status
tail -f <clone>/.state/daemon.log      # log
bash <clone>/daemon/install.sh --uninstall
```

## Linux (systemd) — `systemd --user` service

`install.sh` writes `~/.config/systemd/user/llmwiki-daemon.service` and runs
`systemctl --user enable --now`.

```bash
systemctl --user status llmwiki-daemon.service
journalctl --user -u llmwiki-daemon.service -f   # or tail -f <clone>/.state/daemon.log
bash <clone>/daemon/install.sh --uninstall
```

**Headless persistence**: to keep capturing with no login session, run once:

```bash
loginctl enable-linger "$USER"
```

## Linux without systemd (e.g. WSL, minimal containers) — cron + nohup

Without `systemctl`, `install.sh` registers an `@reboot` line in `crontab` and immediately
starts `nohup bun <clone>/src/daemon/watch.ts &` in the background so capture begins in the
current boot as well.

```bash
pgrep -af watch.ts                     # is it running
crontab -l | grep llmwiki              # @reboot line present
tail -f <clone>/.state/daemon.log      # log
bash <clone>/daemon/install.sh --uninstall
```

With neither `systemctl` nor `crontab`, you get a one-shot run with no automatic restart.
Re-run `install.sh` after each boot, or supervise `bun <clone>/src/daemon/watch.ts` with your
own process manager.

---

## Health check / debugging

```bash
bun <clone>/src/cli.ts doctor          # daemon + hook wiring, all harnesses
bun <clone>/src/daemon/watch.ts --once # one sweep (immediate capture, prints queue stats)
```

- **Nothing captured**: check `skipped_short` in `watch.ts --once` first. ① sessions under
  50 lines are skipped on purpose ② sessions started from `~` route to `_home` (see the note
  above) ③ check `.state/daemon.log` ④ if the harness IS used here but discovery finds no
  data, its location is nonstandard — run `bun <clone>/src/cli.ts locate <harness>` and follow
  the verify→connect steps it prints.
- **launchd/cron minimal PATH**: the generated unit/plist pins the absolute `bun` path. If you
  ever run a generative pass (`autoupdate` etc.) in the daemon's context, the harness CLI may
  need PATH injection — capture itself uses no LLM, so it is unaffected.
