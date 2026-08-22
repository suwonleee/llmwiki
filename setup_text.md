# llmwiki installation contract for coding agents

You are installing the public `llmwiki` repository for the human who opened this coding-agent session. Treat this file as an execution contract, not as user-facing marketing copy.

## Objective

Install this clone as the local llmwiki engine for the coding agent currently running, verify the installation, and give the human the shortest accurate next steps.

Use [`reference/INSTALLATION_FLOW.md`](reference/INSTALLATION_FLOW.md) for the shared sequence,
the active harness branch, and recovery rules. Read only the relevant harness section unless the
human explicitly requests multiple harnesses.

The machine-readable public support contract is
[`reference/support-contract.json`](reference/support-contract.json). Its platform status, setup
shell, daemon mechanism, CI evidence level, runtime floor, and privacy boundaries are canonical.

| contract target | installation | setup shell | daemon | CI evidence |
|---|---|---|---|---|
| `macos` | `supported` | `posix` | `launchd` | `full-suite` |
| `linux` | `supported` | `posix` | `systemd-or-cron-nohup` | `full-suite` |
| `windows-native` | `supported` | `git-bash` | `per-user-startup-folder` | `platform-contract` |
| `windows-wsl2` | `supported` | `posix-wsl2` | `systemd-or-cron-nohup` | `linux-suite` |

Every harness install includes the same user-level `llmwiki` launcher. Apply the one-time `PATH`
line setup prints when necessary; harness choice no longer changes the command spelling.
On native Windows, use that explicit Bun form for every harness: the optional `llmwiki` launcher
is a `#!/bin/sh` script for Git Bash, while Codex and OpenCode execute commands through PowerShell.

## Boundaries

- Work from the repository clone that contains this file. Confirm the absolute clone path before running setup.
- Read `README.md`, `setup.sh`, `llmwiki.config.example.toml`, and the relevant section of
  `reference/INSTALLATION_FLOW.md` before changing anything.
- Do not commit or push.
- Do not add an MCP server, Docker service, external database, vector database, cloud service, or new project dependency.
- Do not overwrite unrelated user configuration. The setup scripts already merge or reject conflicts at their owned boundaries.
- On Codex, llmwiki owns only its entries in `$CODEX_HOME/hooks.json`, its five installed wiki
  skills, the user launcher, and the capture service. It never edits `$CODEX_HOME/config.toml`,
  `developer_instructions`, `AGENTS.md`, or another orchestrator's state; diagnose errors from
  those surfaces with their owner.
- Do not copy private project files, transcripts, credentials, or wiki content into this public engine clone.
- Do not create `llmwiki.config.toml` unless the human asks for custom conventions.
- Do not migrate an existing wiki unless the human explicitly approves the migration after seeing the dry-run.

## Procedure

- Locate and select
    - Confirm the clone containing `setup_text.md` and record its absolute path
    - Identify the active harness: Claude Code, Codex, or OpenCode
    - Read the shared flow and only that harness branch in `reference/INSTALLATION_FLOW.md`
- Check prerequisites
    - The setup shell named by the support contract. `setup.sh` and the daemon installer are bash:
      use a POSIX shell on macOS/Linux/WSL2, or Git Bash for a native-Windows install
    - `git` — the capture loop's one hard dependency. Setup searches past PATH (Homebrew, MacPorts,
      Nix, ~/.local/bin) and now stops before mutation when it is absent; `llmwiki doctor` also
      prints the resolved `[deps]` path
    - Bun 1.2 or newer recommended; 1.1 is the accepted floor. Below 1.2 there is no in-process
      zstd, so Codex's compressed rollouts are skipped unless a `zstd` binary is installed —
      doctor's `[deps]` line says which route it found
    - Active harness CLI: `claude`, `codex`, or `opencode`
    - Missing prerequisite → stop before mutation and report the exact item
- Run the read-only preflight
    - Claude Code: `./setup.sh --dry-run --harness claude`
    - Codex: `./setup.sh --dry-run --harness codex`
    - OpenCode: `./setup.sh --dry-run --harness opencode`
- Install from the clone root
    - Claude Code: `./setup.sh --harness claude`
    - Codex: `./setup.sh --harness codex`
    - OpenCode: `./setup.sh --harness opencode`
    - Native Windows: run the selected command from Git Bash; setup registers the capture daemon
      in the unelevated per-user Startup folder and prints explicit `bun .../src/cli.ts` follow-ups
    - `--harness auto` only on an explicit request for every detected harness
- Preserve setup evidence
    - Keep the complete output
    - A successful setup records the exact clone root and HEAD per selected harness component in
      the owned state root; after a later `git pull`, guidance remains visible until every
      previously installed component has been refreshed
    - Conflict or unsupported CLI → stop at the exact boundary without bypass
- Verify the selected harness
    - Printed `PATH` action → apply that exact command first
    - Codex: `llmwiki doctor --harness codex`
    - OpenCode: `llmwiki doctor --harness opencode`
    - Claude Code: `llmwiki doctor --harness claude`
- Confirm the harness data location (discovery resolves itself before it asks you)
    - Run `llmwiki locate <harness>`
    - A ✅ line means the location is verified and nothing is required of you. That includes
      `found and connected automatically` — the engine searched past the defaults (WSL's mounted
      Windows profile, XDG variants), verified a candidate, and persisted it on its own
    - You are needed ONLY when locate prints the handoff block, which states three things:
        - `tried  :` every path already examined — do not re-check these
        - `blocked:` why no automatic answer was possible
        - `options:` the numbered choices; pick one and run exactly the command shown
    - Four blocking shapes exist, and they want different things:
        - Nothing found, harness installed → search the machine for the location `options` describes,
          then `llmwiki locate <harness> <path>` (read-only check) and `llmwiki connect <harness> <path>`
        - Several locations verified → the engine refuses to guess between them because they are
          usually different PEOPLE's profiles. Ask the human which is theirs; never pick for them
        - One location verified but OUTSIDE the user's home (e.g. a mounted Windows profile under
          `/mnt/c/Users/*`) → the engine never connects foreign-looking data by itself. Ask the
          human whether that profile is theirs; only then run the `connect` command shown
        - An env var ($CODEX_HOME, $OPENCODE_DB) is set but points at something that fails
          verification → the engine cannot fix a shell variable, and env wins over anything it
          could persist. Have the human fix or unset the variable, then re-run locate
    - `connect` records only a path that passes the engine's schema-signature verification
      (fail-closed) — never bypass it by editing state files by hand, and never persist a guess
    - A connected location is read-only: capture reads transcripts from it and the engine never
      writes into it (hook wiring stays in the profiles this machine owns)
    - `connect` restarts the capture daemon itself; no command to copy. Re-run the harness doctor
    - To undo one: `llmwiki connect <harness> --forget`
    - Details and per-harness signatures: `reference/INSTALLATION_FLOW.md` § Harness data locations
- Enroll the project (the one project-level trust decision)
    - Machine-level installation is INERT until a repository is enrolled: no cold-start context,
      no per-turn injection, no captured sessions
    - Run `llmwiki init <absolute-project-path>` once per repository
    - Run `llmwiki verify <absolute-project-path> --harness <harness>` for one combined machine,
      enrollment, index, and cold-start-memory receipt
    - The target must be a git worktree; automatic integration is git-only and per-worktree
    - Confirm with `llmwiki status <absolute-project-path>` — it prints enabled/disabled and why
    - Never enroll a repository the human did not name, and never enroll one just because it
      already contains `docs/wiki/` (that arrives with any clone)
- Generative passes stay off unless the human asks
    - `autoupdate`/`review` launch a subprocess only when `LLMWIKI_LLM_CMD` is set in the machine
      environment; unset means nothing is sent anywhere
    - Do not set it in a repository file, a `.env`, or a config — it is a shell-environment
      decision the human makes explicitly, and llmwiki ignores repository-supplied values
- Handle Codex trust
    - Start Codex in an initialized project
    - Open `/hooks`
    - Inspect and trust both current llmwiki hook hashes
    - Never claim active hooks before the Codex UI verdict
- Report
    - Installed surfaces and health-check result
    - Which repositories were enrolled, and that no others are active
    - Remaining manual action
    - The uninstall path, verbatim: `./setup.sh --uninstall` (add `--purge-data` to delete local
      runtime state), run from this clone BEFORE the clone is moved or deleted
    - Exact wired clone path
    - Exact project initialization command
    - No initialization of an unspecified project

## Tell the human how to use it

After a successful installation, give these instructions:

- First project
    - Initialize with the exact harness command from `reference/INSTALLATION_FLOW.md`
    - Start the same coding agent inside that project
    - Wiki location: `<project>/docs/wiki/`
- Normal operation
    - Local capture without MCP
    - Session close-out: Claude/OpenCode `/wiki-save`; Codex `$wiki-save`
    - Periodic backlog pass: Claude/OpenCode `/wiki-deep`; Codex `$wiki-deep`
- Project repair
    - Claude/OpenCode `/wiki-doctor`; Codex `$wiki-doctor`
    - Engine-only check: `llmwiki wiki-doctor <project-path>`
    - Safe derived-state repair: add `--fix`
- Custom conventions
    - Copy `llmwiki.config.example.toml` to `llmwiki.config.toml` only on request
    - Codex/OpenCode check: `llmwiki config <project-path>`
    - Check: `llmwiki config <project-path>`
    - Show the result before any migration

## Local architecture to describe accurately

llmwiki requires Bun and uses local lifecycle hooks, a local capture daemon, local SQLite state/indexes, and plain git markdown in each project. It does not require an MCP server, Docker, an external or vector database, or a cloud service.
